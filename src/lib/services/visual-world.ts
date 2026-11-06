import fs from "fs";
import path from "path";
import { getSetting } from "../settings";
import { log } from "../logger";
import { recordGemini } from "./cost-ledger";
import { callGemini, type GeminiGenerateContentResponse } from "./gemini-models";
import { noteGeminiQuota } from "./gemini-quota";

/**
 * Visual world — ONE Gemini call per run, before planning, that reads the WHOLE script and
 * names the universe of imagery the video lives in: its subject, era, region, and 12–30
 * concrete "visual families" (for a Sumerian-myth video: cylinder seal impressions,
 * Assyrian palace reliefs, cuneiform tablets, excavation photographs, an Assyriologist at
 * a desk…).
 *
 * Why it exists. Measured against a reference documentary (Sumer Vault, "Scorpion Men",
 * 2026-11-05): an editor keeps EVERY shot on-topic by translating each abstract line into a
 * piece of the same world ("everyone who knew it is dead" → an excavated burial; "the
 * cuneiform world ended" → a cracked tablet). Our planner could not: its only notion of the
 * topic was the FIRST 60 WORDS of narration (which, in that script, never name Sumer at
 * all), and its abstract-line rule carried forward the previous subject or fell back to
 * generic stock. Beat 400 of a 50-minute script simply did not know what video it was in.
 *
 * Fail-open: no key, the setting off, or any Gemini failure → null, and the planner runs
 * exactly as before (the prompt is byte-identical when no world is passed).
 */
export interface VisualWorld {
  /** One line: what the video is about, named concretely ("Sumerian scorpion-men myth"). */
  topic: string;
  /** Period(s) the imagery belongs to ("c. 3000–500 BC, Mesopotamia"); may be empty. */
  era: string;
  region: string;
  /** Concrete, searchable kinds of imagery that belong to this video's world. */
  families: string[];
  /** Kinds of imagery that would be off-topic here (generic modern stock, fantasy art…). */
  avoid: string[];
}

const MAX_SCRIPT_CHARS = 60_000; // ~15k tokens: a 50-minute script fits whole
const MAX_FAMILIES = 30;
const MIN_FAMILIES = 5;
const MAX_ITEM_CHARS = 90;

export function visualWorldEnabled(): boolean {
  return getSetting("VISUAL_WORLD") === "1";
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    topic: { type: "STRING" },
    era: { type: "STRING" },
    region: { type: "STRING" },
    families: { type: "ARRAY", items: { type: "STRING" } },
    avoid: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["topic", "era", "region", "families", "avoid"],
  propertyOrdering: ["topic", "era", "region", "families", "avoid"],
} as const;

export function buildVisualWorldPrompt(script: string, title?: string): string {
  return (
    `You are the picture researcher for a documentary YouTube video. Read the WHOLE narration and define the ` +
    `visual world every shot of this video must come from — the way a good editor keeps every image on-topic even ` +
    `when the narration is abstract, rhetorical or philosophical.\n\n` +
    (title?.trim() ? `Title: "${title.trim()}"\n\n` : "") +
    `Narration:\n"""\n${script.slice(0, MAX_SCRIPT_CHARS)}\n"""\n\n` +
    `Return JSON:\n` +
    `- "topic": one concrete line naming the subject (e.g. "Sumerian scorpion-man myth in Mesopotamian art", ` +
    `"Tide laundry detergent and how it cleans"). Name things, never a mood.\n` +
    `- "era": the period(s) the imagery belongs to, or "" for a present-day subject.\n` +
    `- "region": where the imagery belongs, or "" if it does not matter.\n` +
    `- "families": 12-30 CONCRETE, SEARCHABLE kinds of imagery that belong to this subject's world, 2-8 words each, ` +
    `varied enough to cover every kind of line in the script — the objects and artifacts themselves, the places, ` +
    `the documents and maps, the people who make/study/use them at work, the natural subject if there is one. ` +
    `Include families an editor would use for ABSTRACT lines (loss, time, mystery, experts, doubt, death, origins) ` +
    `that still stay inside this world (e.g. "broken cuneiform tablet fragment", "Assyriologist reading a tablet ` +
    `under a lamp", "archival excavation photograph"). Never abstract concepts, moods or effects.\n` +
    `- "avoid": 3-8 kinds of imagery that would be OFF-topic for this video even though a literal reading of a ` +
    `sentence might suggest them (e.g. "generic office workers", "fantasy creature art", "modern city skyline").\n` +
    `No markdown.`
  );
}

function cleanList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = x.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Validate a model answer. A world with no topic or too few families is worse than none. */
export function normalizeVisualWorld(raw: unknown): VisualWorld | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 160) : "");
  const topic = str(r.topic);
  const families = cleanList(r.families, MAX_FAMILIES);
  if (!topic || families.length < MIN_FAMILIES) return null;
  return { topic, era: str(r.era), region: str(r.region), families, avoid: cleanList(r.avoid, 8) };
}

/** The block injected into every planner chunk. */
export function formatVisualWorld(w: VisualWorld): string {
  return (
    `VISUAL WORLD of this video (every shot must come from it):\n` +
    `Topic: ${w.topic}\n` +
    (w.era ? `Era: ${w.era}\n` : "") +
    (w.region ? `Region: ${w.region}\n` : "") +
    `Visual families: ${w.families.join("; ")}\n` +
    (w.avoid.length ? `Off-topic for this video: ${w.avoid.join("; ")}\n` : "")
  );
}

/** One line naming the world — leads the AI-image anchor and the footage scorer's context. */
export function visualWorldAnchor(w: VisualWorld): string {
  return [w.topic, [w.era, w.region].filter(Boolean).join(", ")].filter(Boolean).join(" — ").slice(0, 160);
}

function answerText(json: GeminiGenerateContentResponse): string {
  return (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => (p as { thought?: boolean }).thought !== true)
    .map((p) => p.text ?? "")
    .join("");
}

function parseWorld(text: string): VisualWorld | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return normalizeVisualWorld(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

/** Best-effort. Returns null (and logs why) whenever the world can't be built. */
export async function buildVisualWorld(runId: string, script: string, title?: string): Promise<VisualWorld | null> {
  if (!visualWorldEnabled()) return null;
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey || !script.trim()) return null;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: buildVisualWorldPrompt(script, title) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
      maxOutputTokens: 4000,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  try {
    const { json } = await callGemini({
      apiKey,
      model: getSetting("SCENE_SPLIT_MODEL"),
      body,
      timeoutMs: 60_000,
      validate: (j, usedModel) => {
        // Metered on EVERY 200, before the parse probe — same rule as requestPlanChunk.
        recordGemini(runId, "geminiText", j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0, usedModel);
        if (!parseWorld(answerText(j))) throw new Error("unusable visual-world JSON");
      },
    });
    const world = parseWorld(answerText(json));
    if (world) {
      log(runId, "info", `Visual world: ${visualWorldAnchor(world)} · ${world.families.length} visual families`, { stage: "plan" });
    }
    return world;
  } catch (e) {
    const msg = (e as Error).message;
    noteGeminiQuota(runId, msg);
    log(runId, "warn", `Visual world unavailable (${msg.slice(0, 120)}) — planning with the script opening as context, as before`, { stage: "plan" });
    return null;
  }
}

export function visualWorldPath(runDir: string): string {
  return path.join(runDir, "visual-world.json");
}

/** The world a run was planned with, or null (older run, feature off, unreadable file). */
export function readVisualWorld(runDir: string): VisualWorld | null {
  try {
    return normalizeVisualWorld(JSON.parse(fs.readFileSync(visualWorldPath(runDir), "utf-8")));
  } catch {
    return null;
  }
}

/** Prefix `context` with the world's anchor line. No world → `context` unchanged. */
export function withWorldAnchor(world: VisualWorld | null, context: string): string {
  return world ? `${visualWorldAnchor(world)}. ${context}` : context;
}

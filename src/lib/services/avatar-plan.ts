import { getSetting } from "../settings";
import { log } from "../logger";
import type { TranscriptSegment } from "./transcribe";
import { callGemini } from "./gemini-models";

/**
 * AVATAR MODE — layout planner.
 *
 * Given the transcript of an uploaded talking-head video, decide for EACH
 * segment how the screen should look, then assign a B-roll source. The
 * assembler later composites the avatar video with matched visuals beat by
 * beat, keeping the avatar's own audio throughout.
 *
 *   layout "avatar" → avatar stays full-screen (hook, direct address, abstract)
 *   layout "broll"  → full-screen B-roll cutaway (a concrete thing is named)
 *   layout "split"  → avatar on one side, B-roll on the other (explanatory)
 *
 * Source (AI-generated vs Pexels stock) is spread across the visual beats per
 * STOCK_RATIO_PERCENT (50 = half/half) — the same knob faceless mode uses.
 */

export type BeatLayout = "avatar" | "split" | "broll";

export interface AvatarBeat {
  startMs: number;
  endMs: number;
  text: string;
  layout: BeatLayout;
  /** Short search/generation prompt for the B-roll. "" when layout = "avatar". */
  visualQuery: string;
  /** Which visual engine fills this beat. Ignored when layout = "avatar". */
  source: "ai" | "stock";
}

function isLayout(v: unknown): v is BeatLayout {
  return v === "avatar" || v === "split" || v === "broll";
}

export async function planAvatarBeats(
  segments: TranscriptSegment[],
  opts: { stockRatioPercent: number; runId?: string }
): Promise<AvatarBeat[]> {
  if (segments.length === 0) return [];

  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set — required to plan avatar layouts.");
  const model = getSetting("SCENE_SPLIT_MODEL"); // blank/retired → live default via buildGeminiLadder

  const numbered = segments.map((s) => `[${s.index}] ${s.text}`).join("\n");
  const userPrompt =
    `You are editing a talking-head (avatar) video into a dynamic faceless-style edit. ` +
    `Below are the transcript segments of the avatar speaking, one per line as "[index] text".\n\n` +
    `For EACH segment decide how the screen should look:\n` +
    `- "avatar": keep the avatar full-screen. Use for the hook/intro, direct address to the viewer, and emotional or abstract lines with nothing concrete to show.\n` +
    `- "broll": full-screen B-roll cutaway (no avatar). Use when a concrete object, place, or action is named and showing it adds a lot.\n` +
    `- "split": avatar on one side, B-roll on the other. Use for most explanatory lines that reference something visual but still benefit from the avatar's presence.\n\n` +
    `Rules: open on "avatar". Vary the layout for rhythm — never stay on one layout for many segments in a row. For "broll" and "split", give a SHORT 3-8 word visual search query of concrete nouns (what to show on screen). For "avatar", visual_query must be "".\n\n` +
    `Transcript:\n${numbered}\n\n` +
    `Return STRICTLY a JSON array, one object per segment IN ORDER:\n` +
    `{"index": <int>, "layout": "avatar"|"broll"|"split", "visual_query": "<string>"}\n` +
    `No markdown, no commentary, no extra keys.`;

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.6,
      maxOutputTokens: 16000,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let parsed: { index: number; layout: string; visual_query?: string }[] = [];
  try {
    // Shared resilience layer (gemini-models.ts): one call, now failing over to a
    // live model on a transient blip. On total failure the catch below defaults to split.
    const { json: j } = await callGemini({ apiKey, model, body, timeoutMs: 45_000 });
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const arr: unknown = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text);
    if (Array.isArray(arr)) {
      parsed = arr as { index: number; layout: string; visual_query?: string }[];
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (opts.runId) {
      log(opts.runId, "warn", `Avatar layout planning failed (${msg.slice(0, 120)}) — defaulting all beats to split`, {
        stage: "avatar_plan",
      });
    }
  }

  const byIndex = new Map<number, { index: number; layout: string; visual_query?: string }>(
    parsed.map((p) => [Number(p.index), p])
  );

  // Build beats — any missing / unknown layout defaults to "split".
  const beats: AvatarBeat[] = segments.map((s) => {
    const p = byIndex.get(s.index);
    const layout: BeatLayout = p && isLayout(p.layout) ? p.layout : "split";
    const visualQuery = layout === "avatar" ? "" : (p?.visual_query?.trim() || s.text.trim());
    return { startMs: s.startMs, endMs: s.endMs, text: s.text, layout, visualQuery, source: "ai" };
  });

  // Assign source (AI vs Pexels stock) across the visual beats, evenly spread.
  const ratio = Math.max(0, Math.min(100, opts.stockRatioPercent));
  const visualBeats = beats.filter((b) => b.layout !== "avatar");
  if (visualBeats.length > 0 && ratio > 0) {
    const target = Math.min(visualBeats.length, Math.round((visualBeats.length * ratio) / 100));
    const stockOrdinals = new Set<number>();
    if (target > 0) {
      const step = visualBeats.length / target;
      for (let i = 0; stockOrdinals.size < target && i < visualBeats.length; i++) {
        stockOrdinals.add(Math.floor(i * step));
      }
    }
    let ordinal = 0;
    for (const b of beats) {
      if (b.layout === "avatar") continue;
      b.source = stockOrdinals.has(ordinal) ? "stock" : "ai";
      ordinal++;
    }
  }

  if (opts.runId) {
    const c = { avatar: 0, split: 0, broll: 0 };
    for (const b of beats) c[b.layout]++;
    log(
      opts.runId,
      "success",
      `Avatar plan: ${beats.length} beats · avatar=${c.avatar} split=${c.split} broll=${c.broll} · ${visualBeats.filter((b) => b.source === "stock").length} stock / ${visualBeats.filter((b) => b.source === "ai").length} AI`,
      { stage: "avatar_plan" }
    );
  }

  return beats;
}

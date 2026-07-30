import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import { getRunDir } from "../run-paths";
import { callGemini } from "./gemini-models";

export interface Scene {
  index: number;
  text: string;
  visual_prompt: string;
  duration_hint_sec: number;
}

/**
 * Splits the script into scenes. Supports Google Gemini (default, cheap) and Anthropic Claude.
 * If `overrideSystemPrompt` is passed (e.g. from a Prompt Preset chosen on the New Run page),
 * it replaces the default scene_split prompt for this call only.
 */
export async function splitScript(
  runId: string,
  script: string,
  overrideSystemPrompt?: string
): Promise<Scene[]> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  const systemPrompt = overrideSystemPrompt?.trim() ? overrideSystemPrompt : getPrompt("scene_split");

  log(runId, "info", `Splitting script (${provider})`, {
    stage: "scene_split",
    data: { scriptChars: script.length },
  });

  let raw: string;
  if (provider === "google") {
    raw = await splitWithGemini(systemPrompt, script);
  } else if (provider === "anthropic") {
    raw = await splitWithClaude(systemPrompt, script);
  } else {
    throw new Error(`Unknown SCENE_SPLIT_PROVIDER: ${provider}`);
  }

  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (e) {
    // Save raw output so we can see what went wrong
    try {
      const runDir = getRunDir(runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "scene_split_raw.txt"), raw, "utf-8");
      log(runId, "error", `Raw output saved to ${runDir}/scene_split_raw.txt (${raw.length} chars)`, {
        stage: "scene_split",
      });
    } catch {}
    throw e;
  }
  if (!Array.isArray(json)) {
    log(runId, "error", "LLM did not return an array", { stage: "scene_split", data: { raw: raw.slice(0, 500) } });
    throw new Error("scene_split: model did not return a JSON array");
  }

  let scenes: Scene[] = enforceMaxSceneLength(
    json.map((s, i) => ({
      index: i,
      text: String(s.text ?? ""),
      visual_prompt: String(s.visual_prompt ?? ""),
      duration_hint_sec: Number(s.duration_hint_sec ?? 6),
    }))
  );

  // Post-process: dedupe adjacent near-duplicate visual_prompts (Gemini tends
  // to give 2-3 consecutive scenes the same visual when the script narrates
  // one topic across adjacent sentences — looks like a freeze loop in the
  // final video). Cheap: only re-calls Gemini for the duplicate groups.
  scenes = await dedupeAdjacentVisuals(runId, scenes, systemPrompt);

  // Coverage check: words in scene.text vs original script.
  // If coverage < 70%, the model probably summarized — warn the user.
  const scriptWords = script.trim().split(/\s+/).filter(Boolean).length;
  const sceneWords = scenes.reduce(
    (sum, s) => sum + s.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
  const coverage = scriptWords > 0 ? (sceneWords / scriptWords) * 100 : 0;

  log(runId, "success", `Done: ${scenes.length} scenes · script coverage ${coverage.toFixed(0)}% (${sceneWords}/${scriptWords} words)`, {
    stage: "scene_split",
    data: { scenes: scenes.map((s) => ({ i: s.index, text: s.text.slice(0, 60) })) },
  });

  if (coverage < 70) {
    log(
      runId,
      "warn",
      `⚠️ Low coverage (${coverage.toFixed(0)}%) — the model likely summarized the script. Review the scene_split prompt on /prompts.`,
      { stage: "scene_split" }
    );
  }

  return scenes;
}

/**
 * Same logic as splitScript but with no DB logging and no artifact files.
 * Used by /api/preview/scenes — the user wants to *see* the scenes before
 * deciding to start a run, so we shouldn't create run_logs rows or temp dirs.
 */
export async function splitScriptPreview(
  script: string,
  overrideSystemPrompt?: string
): Promise<Scene[]> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  const systemPrompt = overrideSystemPrompt?.trim() ? overrideSystemPrompt : getPrompt("scene_split");
  let raw: string;
  if (provider === "google") raw = await splitWithGemini(systemPrompt, script);
  else if (provider === "anthropic") raw = await splitWithClaude(systemPrompt, script);
  else throw new Error(`Unknown SCENE_SPLIT_PROVIDER: ${provider}`);
  const json = extractJson(raw);
  if (!Array.isArray(json)) throw new Error("Model did not return a JSON array");
  return enforceMaxSceneLength(
    json.map((s, i) => ({
      index: i,
      text: String(s.text ?? ""),
      visual_prompt: String(s.visual_prompt ?? ""),
      duration_hint_sec: Number(s.duration_hint_sec ?? 6),
    }))
  );
}

/**
 * HARD GUARD against over-long scenes.
 *
 * Grok via 69labs returns a fixed ~6-second clip. If a scene's narration is
 * longer than the clip, the video freezes on the last frame for the overflow.
 * The scene_split prompt tells the LLM to keep scenes short, but the LLM does
 * not always obey — so we enforce it in code here, no matter what the LLM did.
 *
 * Any scene whose text exceeds MAX_SCENE_WORDS is split into the fewest equal
 * word-boundary chunks that all fit. Splitting only on word boundaries keeps
 * the joined text identical, so script coverage stays 100%. The split halves
 * share the original scene's visual_prompt (same visual world).
 *
 * MAX_SCENE_WORDS is deliberately conservative (~5.5s even on a slow ~108wpm
 * HeyGen voice) so the clip always covers the audio with motion to spare.
 */
const MAX_SCENE_WORDS = 11;

function enforceMaxSceneLength(scenes: Scene[]): Scene[] {
  const out: Scene[] = [];
  for (const s of scenes) {
    const words = s.text.trim().split(/\s+/).filter(Boolean);
    if (words.length <= MAX_SCENE_WORDS) {
      out.push(s);
      continue;
    }
    const chunkCount = Math.ceil(words.length / MAX_SCENE_WORDS);
    const perChunk = Math.ceil(words.length / chunkCount);
    for (let i = 0; i < words.length; i += perChunk) {
      const chunkWords = words.slice(i, i + perChunk);
      out.push({
        index: 0, // reindexed below
        text: chunkWords.join(" "),
        visual_prompt: s.visual_prompt,
        duration_hint_sec: Math.min(6, Math.max(2, Math.round((chunkWords.length / 150) * 60))),
      });
    }
  }
  return out.map((s, i) => ({ ...s, index: i }));
}

async function splitWithGemini(systemPrompt: string, script: string): Promise<string> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL"); // blank/retired → live default via buildGeminiLadder

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: `Script:\n\n${script}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7,
      // 60K — enough for ~150 scenes in JSON
      maxOutputTokens: 60000,
      // Disable thinking — for structured output it just wastes the token budget
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  // Shared resilience layer: model selection + retry/failover + error classification
  // all live in gemini-models.ts. Preserve this call's historical budget of 5 attempts
  // (was MAX_RETRIES=4) and its 1s/2s/4s/8s exponential backoff; now those attempts also
  // fail over across live models instead of hammering one overloaded model.
  const { json } = await callGemini({
    apiKey,
    model,
    body,
    maxAttempts: 5,
    backoffMs: (n) => 1000 * Math.pow(2, n - 1), // 1s, 2s, 4s, 8s
  });
  const cand = json.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const reason = cand?.finishReason;
  if (reason && reason !== "STOP") {
    throw new Error(
      `Gemini finish=${reason} (output cut off, tokens=${json.usageMetadata?.candidatesTokenCount}). Increase maxOutputTokens.`
    );
  }
  if (!text) throw new Error(`Gemini: empty output (${JSON.stringify(json).slice(0, 300)})`);
  return text;
}

async function splitWithClaude(systemPrompt: string, script: string): Promise<string> {
  const apiKey = getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "claude-sonnet-4-6";
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: `Script:\n\n${script}` }],
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Adjacent-duplicate dedupe (issue #4 — Gemini visual_prompt repetition)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Bull Network reported that Gemini Flash often gives the same visual_prompt
 * to 2-3 consecutive scenes when the script narrates a single topic across
 * adjacent sentences. Veo then renders nearly identical clips back-to-back
 * — looks like a freeze loop / amateur monitor. Adding "vary the visuals"
 * to the system prompt doesn't help, because Gemini treats "faithful to
 * script" as the dominant instruction.
 *
 * Fix: post-process. Walk the returned scenes, find adjacent groups whose
 * visual_prompts share a Jaccard word-similarity above the threshold
 * (default 0.7), then make ONE focused call back to Gemini per group:
 * "these N scenes share the same visual — give me N different angles /
 * actions / props in the same world. Don't change the scene text." Replace
 * in place. Cheap (only fires on real duplicates) and surgical.
 */
async function dedupeAdjacentVisuals(
  runId: string,
  scenes: Scene[],
  systemPrompt: string
): Promise<Scene[]> {
  if (scenes.length < 2) return scenes;
  if (getSetting("SCENE_DEDUPE_ENABLED") === "0") return scenes;
  const threshold = clampNum(getSetting("SCENE_DEDUPE_THRESHOLD"), 0.7, 0, 1);
  // Iterate: one pass rarely clears everything because Gemini dupes 60-70% of
  // adjacent prompts and a single re-variation can still land similar (or
  // create a NEW adjacency with a neighbour). Re-detect + re-vary up to
  // SCENE_DEDUPE_MAX_PASSES times until no duplicate groups remain.
  const maxPasses = Math.round(clampNum(getSetting("SCENE_DEDUPE_MAX_PASSES"), 3, 1, 5));

  for (let pass = 1; pass <= maxPasses; pass++) {
    const groups = findDuplicateGroups(scenes, threshold);
    if (groups.length === 0) {
      log(
        runId,
        "info",
        pass === 1
          ? `Dedupe: 0 adjacent-duplicate groups (threshold ${threshold})`
          : `Dedupe: clean after pass ${pass - 1} — no duplicate groups remain`,
        { stage: "scene_split" }
      );
      return scenes;
    }

    const totalDupes = groups.reduce((sum, g) => sum + g.length, 0);
    log(
      runId,
      "info",
      `Dedupe pass ${pass}/${maxPasses}: ${groups.length} group(s) covering ${totalDupes}/${scenes.length} scenes — re-asking Gemini`,
      { stage: "scene_split" }
    );

    // For each group, ask Gemini to rewrite the visual_prompts with variation.
    // Failures are logged but non-fatal — we keep the original visuals if so.
    let changed = 0;
    for (const group of groups) {
      try {
        const replacements = await variateVisuals(scenes, group, systemPrompt);
        for (let k = 0; k < group.length; k++) {
          const idx = group[k];
          if (replacements[k] && replacements[k].trim().length > 0) {
            scenes[idx] = { ...scenes[idx], visual_prompt: replacements[k].trim() };
            changed++;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(
          runId,
          "warn",
          `Dedupe pass ${pass} failed for group ${group[0]}–${group[group.length - 1]}: ${msg.slice(0, 150)} — keeping originals`,
          { stage: "scene_split" }
        );
      }
      // Gentle throttle between Gemini calls (polite even on paid tiers).
      await new Promise((r) => setTimeout(r, 400));
    }

    if (changed === 0) {
      log(runId, "warn", `Dedupe: pass ${pass} changed nothing (all groups errored) — stopping`, {
        stage: "scene_split",
      });
      return scenes;
    }
  }

  // After the final pass, report any residual duplicates that survived.
  const residual = findDuplicateGroups(scenes, threshold);
  if (residual.length > 0) {
    const residualCount = residual.reduce((sum, g) => sum + g.length, 0);
    log(
      runId,
      "warn",
      `Dedupe: ${residualCount} scene(s) in ${residual.length} group(s) still similar after ${maxPasses} passes — minor residual duplicates may remain`,
      { stage: "scene_split" }
    );
  } else {
    log(runId, "success", `Dedupe: clean after ${maxPasses} passes — no duplicate groups remain`, {
      stage: "scene_split",
    });
  }
  return scenes;
}

/** Groups of consecutive scene indices whose visual_prompts are ≥ threshold similar. */
function findDuplicateGroups(scenes: Scene[], threshold: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < scenes.length - 1; i++) {
    const sim = jaccardWords(scenes[i].visual_prompt, scenes[i + 1].visual_prompt);
    if (sim >= threshold) {
      if (current.length === 0) current.push(i);
      current.push(i + 1);
    } else if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Word-level Jaccard similarity in [0,1]. Lowercase + alpha-numeric tokens. */
function jaccardWords(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3)
    );
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function clampNum(s: string, fallback: number, min: number, max: number): number {
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Ask Gemini Flash to rewrite the visual_prompts for one duplicate group into
 * N varied alternatives. Returns an array of length `group.length` (best
 * effort — caller skips empty strings).
 */
async function variateVisuals(
  scenes: Scene[],
  group: number[],
  systemPrompt: string
): Promise<string[]> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set");
  const model = getSetting("SCENE_SPLIT_MODEL"); // blank/retired → live default via buildGeminiLadder

  const sceneBlock = group
    .map(
      (idx, k) =>
        `Scene ${k + 1} (text: "${scenes[idx].text.replace(/"/g, "'")}", current visual_prompt: "${scenes[
          idx
        ].visual_prompt.replace(/"/g, "'")}")`
    )
    .join("\n\n");

  const userPrompt =
    `These ${group.length} consecutive scenes have nearly identical visual_prompts. In the assembled video this looks like a freeze-loop — the same shot held for 10+ seconds. Rewrite the visual_prompt for each so they show DIFFERENT moments from the same world: different camera angle, different action, different prop, different framing. Keep the documentary tone, the same characters / setting / style established by the channel. DO NOT change the scene text.\n\n` +
    sceneBlock +
    `\n\nReturn STRICTLY a JSON array of ${group.length} strings — the new visual_prompts in order. No markdown, no commentary, no extra fields.`;

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      // Higher temperature for variety — the whole point of this call.
      temperature: 0.9,
      maxOutputTokens: 4000,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  // Shared resilience layer (gemini-models.ts): 3 attempts with the original 4s/8s
  // backoff — even paid Gemini tiers hit brief 429/503 blips under the dedupe burst —
  // now failing over across live models. Throws once the budget/live models are spent.
  const { json } = await callGemini({ apiKey, model, body, maxAttempts: 3 });
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error(`could not parse JSON: ${text.slice(0, 200)}`);
    parsed = JSON.parse(m[0]);
  }
  if (!Array.isArray(parsed))
    throw new Error(`expected JSON array, got ${typeof parsed}: ${text.slice(0, 200)}`);
  if (parsed.length !== group.length)
    throw new Error(`expected ${group.length} entries, got ${parsed.length}`);
  return parsed.map((p) => (typeof p === "string" ? p : String(p ?? "")));
}

/** Extracts the first JSON array from a text response, even if the model added markdown. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    throw new Error("Could not parse JSON from model response");
  }
}

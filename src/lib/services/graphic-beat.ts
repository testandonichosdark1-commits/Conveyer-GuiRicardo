import { getSetting } from "../settings";
import { log } from "../logger";
import type { WordTiming } from "./elevenlabs-voiceover";
import type { Beat } from "./studio-plan";
import { PRODUCT_REF, type GraphicWord } from "./graphic-templates";
import { renderGraphicClip } from "./graphic-renderer";
import { resolveProductImage } from "./product-cutout";

/**
 * One graphic beat → its silent clip, for studio-pipeline.ts. Kept out of the pipeline so
 * the fresh-run and Resume loops share it verbatim. Throws on any failure; the pipeline
 * answers by flipping the beat to "broll" (it still carries its planned b-roll fields).
 */

/** Words spoken inside the beat, re-timed relative to its start (what the templates cue on). */
export function wordsForBeat(words: WordTiming[], startMs: number, endMs: number): GraphicWord[] {
  return words
    .filter((w) => w.startMs >= startMs && w.startMs < endMs)
    .map((w) => ({ text: w.word, startMs: Math.max(0, w.startMs - startMs), endMs: Math.max(0, w.endMs - startMs) }));
}

/** Same rounding as studio-assemble's beatFrames — the clip must be exactly that long, or the
 *  compositor's loop would flash the first frame at the end. */
export function graphicBeatFrames(startMs: number, endMs: number, fps: number): number {
  return Math.max(1, Math.round((endMs * fps) / 1000) - Math.round((startMs * fps) / 1000));
}

/** Replace every `product:<name>` image (any depth) with a cut-out path. */
async function resolveProducts(value: unknown, runId: string): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveProducts(v, runId)));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const m = k === "image" && typeof v === "string" ? v.match(PRODUCT_REF) : null;
    out[k] = m ? await resolveProductImage(m[1].trim(), runId) : await resolveProducts(v, runId);
  }
  return out;
}

export async function renderGraphicBeat(
  runId: string,
  beat: Beat,
  words: WordTiming[],
  outPath: string,
  resolution?: string,
): Promise<string> {
  if (!beat.graphic) throw new Error("beat has no graphic spec");
  const m = (resolution || getSetting("VIDEO_RESOLUTION") || "1920x1080").match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  const width = m ? Number(m[1]) : 1920, height = m ? Number(m[2]) : 1080;
  const fps = Math.max(1, Number(getSetting("VIDEO_FPS") || "30"));
  const data = await resolveProducts(beat.graphic.data, runId);
  const r = await renderGraphicClip({
    template: beat.graphic.template,
    data,
    theme: beat.graphic.theme || getSetting("GRAPHIC_THEME") || "arden",
    words: wordsForBeat(words, beat.startMs, beat.endMs),
    durationSec: (beat.endMs - beat.startMs) / 1000,
    frames: graphicBeatFrames(beat.startMs, beat.endMs, fps),
    fps,
    width,
    height,
    outPath,
  });
  log(runId, "info", `Beat ${beat.index}: graphic ${beat.graphic.template} rendered (${r.frames} frames, ${(r.ms / 1000).toFixed(1)}s)`, { stage: "visual" });
  return r.path;
}

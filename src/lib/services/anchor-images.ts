import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { animateStill } from "./still-animator";
import type { Beat } from "./studio-plan";

/**
 * Anchor images — the protagonist's REAL portraits, reused across a long video.
 *
 * A historical documentary keeps returning to the same few pictures of its subject (the
 * reference channel shows the same portrait at 0:36, 6:30, 10:03 and on the very last frame).
 * Searching for "<name> portrait" beat after beat cannot guarantee that: archives return other
 * people with the same title, and an AI image of a real person is not that person. So the
 * operator drops a handful of verified photos in a folder (ANCHOR_IMAGES_DIR, set per channel)
 * and the pipeline places them deterministically:
 *
 *   - only on beats whose narration is ABOUT the protagonist (ANCHOR_TERMS, else the channel's
 *     AI_CHARACTER_TERMS; with no terms every beat is eligible),
 *   - never closer together than ANCHOR_MIN_GAP_SEC (default 75 s),
 *   - and always on the final eligible beat, so the video closes on the protagonist.
 *
 * Deterministic (no randomness, no network) so a Resume places exactly the same anchors. Off —
 * an empty plan, and the pipeline untouched — whenever the folder is unset, missing or empty.
 */

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const DEFAULT_MIN_GAP_SEC = 75;
/** A beat shorter than this is too brief to read as "her portrait" — skip it. */
const MIN_ANCHOR_BEAT_MS = 2000;

type PlannableBeat = Pick<Beat, "index" | "startMs" | "endMs" | "text" | "layout">;

/** Image files in `dir`, sorted by name (so the operator controls the order). [] when unusable. */
export function listAnchorImages(dir: string | undefined | null): string[] {
  const d = (dir ?? "").trim();
  if (!d) return [];
  try {
    return fs
      .readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isFile() && IMAGE_EXT.test(e.name) && !e.name.startsWith("."))
      .map((e) => path.join(d, e.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Comma-separated words → a whole-word, case-insensitive matcher. null = no terms given. */
export function anchorTermsRegex(raw: string | undefined | null): RegExp | null {
  const words = (raw ?? "")
    .split(/[,;\n]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return words.length ? new RegExp(`\\b(?:${words.join("|")})\\b`, "i") : null;
}

/**
 * Pure placement: beat index → anchor image path. Exported for tests.
 * Images are handed out round-robin in pick order.
 */
export function planAnchorBeats(
  beats: readonly PlannableBeat[],
  images: readonly string[],
  terms: RegExp | null,
  minGapMs: number
): Map<number, string> {
  const plan = new Map<number, string>();
  if (images.length === 0) return plan;
  const eligible = beats.filter(
    (b) => b.layout !== "avatar" && b.layout !== "graphic" && b.endMs - b.startMs >= MIN_ANCHOR_BEAT_MS
  );
  if (eligible.length === 0) return plan;

  const picks: PlannableBeat[] = [];
  let lastStart = -Infinity;
  for (const b of eligible) {
    if (terms && !terms.test(b.text)) continue;
    if (b.startMs - lastStart < minGapMs) continue;
    picks.push(b);
    lastStart = b.startMs;
  }
  // The video always closes on the protagonist.
  const final = eligible[eligible.length - 1];
  if (!picks.includes(final)) {
    // Keep the gap: drop a pick that would sit right before the closing anchor.
    while (picks.length && final.startMs - picks[picks.length - 1].startMs < minGapMs) picks.pop();
    picks.push(final);
  }
  picks.forEach((b, i) => plan.set(b.index, images[i % images.length]));
  return plan;
}

/** The run's anchor plan from settings (channel overrides apply). Empty when the feature is off. */
export function resolveAnchorPlan(beats: readonly PlannableBeat[]): Map<number, string> {
  const images = listAnchorImages(getSetting("ANCHOR_IMAGES_DIR"));
  if (images.length === 0) return new Map();
  const terms = anchorTermsRegex(getSetting("ANCHOR_TERMS") || getSetting("AI_CHARACTER_TERMS"));
  const gapSec = Number(getSetting("ANCHOR_MIN_GAP_SEC") || DEFAULT_MIN_GAP_SEC);
  const minGapMs = (Number.isFinite(gapSec) && gapSec >= 0 ? gapSec : DEFAULT_MIN_GAP_SEC) * 1000;
  return planAnchorBeats(beats, images, terms, minGapMs);
}

/** Animate one anchor image into the beat's clip, exactly like any other still. */
export async function renderAnchorBeat(beat: PlannableBeat, imagePath: string, outPath: string, resolution?: string): Promise<string> {
  const beatDurSec = Math.max(0.8, (beat.endMs - beat.startMs) / 1000);
  await animateStill({ imagePath, outPath, durationSec: beatDurSec, zoomOut: beat.index % 2 === 1, resolution, beatIndex: beat.index });
  return outPath;
}

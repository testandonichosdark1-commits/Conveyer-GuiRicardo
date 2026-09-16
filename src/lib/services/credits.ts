import fs from "node:fs";
import path from "node:path";
import { log } from "../logger";

/**
 * Where every frame in a finished video came from.
 *
 * The pipeline already knew this — `VisualResult.attribution` carries the author, the page
 * and the licence — and then dropped it on the floor. Nothing downstream needed it, so a
 * finished run held no record of which photograph it used, and answering "where is this shot
 * from?" meant re-running the search and hoping the same result came back.
 *
 * That is fine while the footage is licensed stock. It stops being fine with an open-web
 * source, where the licence is "the operator's responsibility" and the operator has no way
 * to discharge a responsibility they cannot see. So: written next to the video, per beat,
 * including the beats that reused a neighbour's visual and the ones that are AI.
 *
 * Provenance ONLY. Nothing reads these files back except the resume merge below, and a
 * failure to write one must never fail a run that has already been paid for.
 */

export interface CreditEntry {
  beat: number;
  kind: "video" | "image" | "ai";
  /** "pexels", "wigolo", "kie:veo", … — the same string the run log uses. */
  provider: string;
  /** The PAGE the media was found on. A licence check starts here, not at the file. */
  sourceUrl?: string;
  /** The file actually downloaded — often a CDN path that outlives nothing. */
  fileUrl?: string;
  author?: string | null;
  license?: string | null;
  /** Set when this beat shows another beat's visual (the no-black-screens carry-over). */
  reusedFromBeat?: number;
}

interface CreditsFile {
  version: 1;
  runId: string;
  entries: CreditEntry[];
}

const JSON_NAME = "credits.json";
const TEXT_NAME = "credits.txt";

/**
 * Read back what a previous execution recorded.
 *
 * Resume reuses intact clips on disk instead of re-fetching them, so it never learns where
 * those came from. Without this the second execution would rewrite the file with holes
 * exactly where the run did the least work.
 */
export function readCredits(runDir: string): Map<number, CreditEntry> {
  const out = new Map<number, CreditEntry>();
  try {
    const raw = fs.readFileSync(path.join(runDir, JSON_NAME), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CreditsFile>;
    // Hand-edited or half-written files are treated as absent, never as a crash.
    if (!Array.isArray(parsed?.entries)) return out;
    for (const e of parsed.entries) {
      if (e && Number.isFinite(e.beat)) out.set(Number(e.beat), e);
    }
  } catch {
    /* absent or unreadable — provenance is additive, so an empty map is a valid answer */
  }
  return out;
}

/**
 * Turn one acquisition result into a credit line. AI beats get an entry too — an empty
 * gap in the list would be indistinguishable from "we forgot to record this one".
 */
export function creditFrom(
  beat: number,
  res: { kind: "video" | "image" | "ai"; provider: string; attribution?: { author?: string | null; sourceUrl?: string; license?: string | null; url?: string } }
): CreditEntry {
  const a = res.attribution;
  return {
    beat,
    kind: res.kind,
    provider: res.provider,
    ...(a?.sourceUrl ? { sourceUrl: a.sourceUrl } : {}),
    ...(a?.url ? { fileUrl: a.url } : {}),
    ...(a?.author ? { author: a.author } : {}),
    ...(a?.license ? { license: a.license } : {}),
  };
}

/** The operator-facing list: what you paste under a video, in beat order. */
function renderText(entries: CreditEntry[]): string {
  const lines = [
    "Footage credits",
    "",
    "Each line is one shot, in the order it appears. Check the licence of anything",
    "marked as coming from the open web before publishing.",
    "",
  ];
  for (const e of entries) {
    const where = e.reusedFromBeat != null ? ` (same shot as #${e.reusedFromBeat})` : "";
    const who = e.author ? ` — ${e.author}` : "";
    const lic = e.license ? ` [${e.license}]` : "";
    lines.push(`#${e.beat}${where}  ${e.kind} via ${e.provider}${who}${lic}`);
    if (e.sourceUrl) lines.push(`    ${e.sourceUrl}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Write both files atomically (temp + rename), so a crash mid-write leaves the previous
 * version intact rather than a truncated one.
 */
export function writeCredits(runDir: string, runId: string, entries: CreditEntry[]): void {
  const sorted = [...entries].sort((a, b) => a.beat - b.beat);
  const payload: CreditsFile = { version: 1, runId, entries: sorted };
  try {
    for (const [name, body] of [
      [JSON_NAME, JSON.stringify(payload, null, 2)],
      [TEXT_NAME, renderText(sorted)],
    ] as const) {
      const dest = path.join(runDir, name);
      const tmp = `${dest}.tmp`;
      fs.writeFileSync(tmp, body, "utf-8");
      fs.renameSync(tmp, dest);
    }
  } catch (e) {
    log(runId, "warn", `Could not write footage credits (${(e as Error).message.slice(0, 120)})`, {
      stage: "visual",
    });
  }
}

import fs from "node:fs";
import path from "node:path";

/**
 * `AI_PROVIDER=manual` — for an operator who has no CDP/API access to the browser account
 * they want to generate with (e.g. an anti-detect-browser profile whose vendor charges extra
 * for automation access) but is willing to paste prompts and generate by hand. Rather than
 * calling any generation API, a beat routed here either:
 *   - finds an operator-supplied file already sitting in `<runDir>/manual/` and uses it, or
 *   - writes its prompt to `<runDir>/manual-prompts.txt` and throws this error, which
 *     studio-pipeline.ts recognizes specially: NOT a normal beat failure (never reused from a
 *     neighbour, never silently degrades the video), but a run-wide pause once every beat that
 *     can proceed without manual input has finished — see `pauseRunForOperator` in
 *     run-lifecycle.ts, the same mechanism a kie.ai credit exhaustion already uses. Resume
 *     re-enters the SAME acquireAi manual branch, which now finds the operator's files.
 */
export class ManualGenerationPendingError extends Error {
  constructor(beatIndex: number) {
    super(`Beat ${beatIndex}: waiting for manual AI generation`);
    this.name = "ManualGenerationPendingError";
  }
}

export interface ManualPromptEntry {
  index: number;
  media: "image" | "video";
  aspect: string;
  durationSec?: number;
  prompt: string;
}

const paddedBeat = (index: number) => String(index).padStart(4, "0");

/** Absolute path to the folder an operator drops their manually-generated files into. */
export function manualMediaDir(runDir: string): string {
  return path.join(runDir, "manual");
}

/** Absolute path to the prompts file the operator pastes into the manual tool/browser. */
export function manualPromptsPath(runDir: string): string {
  return path.join(runDir, "manual-prompts.txt");
}

/**
 * Does `<runDir>/manual/` already hold a file for this beat? Returns its full path, or null.
 * The extension is never assumed — an operator's download could be .png/.jpg (image) or
 * .mp4/.mov/.webm (video) depending on the browser/tool that produced it.
 */
export function findManualFile(runDir: string, beatIndex: number): string | null {
  const dir = manualMediaDir(runDir);
  if (!fs.existsSync(dir)) return null;
  const prefix = `beat_${paddedBeat(beatIndex)}.`;
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(prefix));
  return hit ? path.join(dir, hit) : null;
}

/** The exact header line a beat's block starts with — also used to detect a beat already
 *  written to the file, so a beat re-attempted across a Resume never appends a duplicate. */
function blockHeader(index: number, media: "image" | "video", aspect: string, durationSec?: number): string {
  const tail = media === "video" && durationSec ? `, ${durationSec}s` : "";
  return `===== Beat ${paddedBeat(index)} (${media}, ${aspect}${tail}) =====`;
}

/**
 * Append this beat's prompt to `<runDir>/manual-prompts.txt`, unless it is already there
 * (the SAME beat can reach this code on more than one attempt/resume before the operator has
 * supplied a file — the file must stay a clean, one-entry-per-beat list, not accumulate
 * duplicates every time the pipeline is resumed).
 */
export function appendManualPrompt(runDir: string, entry: ManualPromptEntry): void {
  const file = manualPromptsPath(runDir);
  const header = blockHeader(entry.index, entry.media, entry.aspect, entry.durationSec);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.includes(header)) return;
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(file, `${header}\n${entry.prompt}\n\n`);
}

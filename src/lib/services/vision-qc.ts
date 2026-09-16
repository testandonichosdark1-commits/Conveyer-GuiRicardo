import { log } from "../logger";

/**
 * ONE loud line per run when frame/image quality control stops actually judging anything.
 *
 * Why this exists: `scoreLocalImage` fails OPEN — with no Gemini key, an unreadable or
 * oversized file, or any API error, it returns **100 out of 100**. That is the correct
 * routing choice (a broken judge must not stall a run), but 100 clears every bar and is
 * indistinguishable in the log from a genuine perfect score.
 *
 * And it is worse than indistinguishable — it is INVISIBLE. The AI-image gate only logs when
 * a score is BELOW its threshold ("scored N% (<75) — regenerating"), so a fail-open 100 emits
 * nothing at all. With AI_REGEN_ATTEMPTS defaulting to 5, a broken judge means every generated
 * image is accepted on the first try with no regeneration, and the operator ships a video
 * whose frames nobody checked without a single hint that the check was off. A client asked
 * exactly this question, which is how the gap was found.
 *
 * So: the first unjudged frame of a run logs a `warn` naming the cause and the consequence;
 * every later one is silent, because a run scores hundreds of frames and a line each would
 * bury the fact instead of surfacing it. Modelled on gemini-quota.ts, which solves the same
 * shape of problem for an exhausted key.
 *
 * This module REPORTS. It changes no score, no threshold and no routing — scoreLocalImage
 * returns exactly what it returned before, pinned by test.
 */
const notified = new Set<string>();

/**
 * Report, at most once per run, that quality control could not judge a frame and accepted it
 * unchecked. `reason` should name the cause concretely (missing key, file too large, …) —
 * it is the part that tells the operator whether they can fix it.
 */
export function noteVisionUnjudged(runId: string, reason: string, stage = "visual"): void {
  if (notified.has(runId)) return;
  notified.add(runId);
  log(
    runId,
    "warn",
    `FRAME QUALITY CONTROL IS OFF — ${reason}. For the rest of this run, video frames and ` +
      `generated images are ACCEPTED WITHOUT BEING CHECKED: nothing is scored for relevance, ` +
      `no AI image is regenerated, and burned-in text / off-topic footage is not rejected. ` +
      `A "100%" in this run's log means "not checked", not "perfect". The video will still be ` +
      `produced — only its shot quality is unverified.`,
    { stage }
  );
}

/** Has this run already reported that quality control is off? Reporting only — never routes. */
export function visionQcOff(runId: string): boolean {
  return notified.has(runId);
}

/** Test seam: forget a run's notice so the once-per-run behaviour can be exercised repeatedly. */
export function __resetVisionQcNotice(runId?: string): void {
  if (runId) notified.delete(runId);
  else notified.clear();
}

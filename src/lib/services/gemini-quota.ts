import { isGeminiQuotaError, isGeminiAuthError } from "./gemini-models";
import { pauseRunForOperator } from "../run-lifecycle";

/**
 * ONE loud line per run when Gemini becomes permanently unusable — out of quota OR a bad/missing
 * API key — and PAUSE the run there.
 *
 * Why this exists: a run whose key is exhausted (429) or invalid (400) fails on EVERY Gemini
 * call — the planner, the candidate scorer and the title reranker alike. A real run logged ~170
 * of them and kept going for another ~140 beats: no overlay cards, footage matching cut to
 * raw-narration keywords, and — worst of all — image/frame quality control silently switched off
 * (see vision-qc.ts), so a provider's own safety-filter placeholder image sailed straight into
 * the final video with nobody left to catch it. Each failure was already reported honestly, but
 * always as its own local, recoverable-sounding fallback ("retrying", "lexical fallback
 * scoring", "keeping original order"), never as the single account-level fact underneath them
 * all — and Gemini has no fallback provider for any of these roles, so there is nothing to route
 * around. An invalid key fails exactly the same way and was NOT caught here until a live run sat
 * for 226 beats with every Gemini call 400ing "API key not valid" and never paused.
 *
 * So: the first quota-or-auth failure of a run logs an `error` naming the cause and the
 * consequences, then pauses the run exactly the way a user-initiated Stop does (see
 * `pauseRunForOperator`) — every beat already rendered is kept, nothing new starts, and the
 * run's own Resume button picks it back up once the operator has fixed GOOGLE_API_KEY. Every
 * later quota-or-auth failure in the same run is silent, leaving the existing per-beat lines to
 * carry the detail.
 */
const notified = new Set<string>();

/**
 * Report a Gemini failure IF it is a quota exhaustion or an invalid/missing key, and pause the
 * run on the first one. No-op for every other failure (a transient 503, a timeout, a content
 * rejection) and for runs that already reported one. Returns whether this run is known to be
 * permanently locked out of Gemini, so a caller can add its own consequence line (see the
 * overlay summary in studio-plan).
 *
 * Safe to call from any Gemini catch block: classification is by message, and the notice +
 * pause fire at most once per runId.
 */
export function noteGeminiQuota(runId: string, message: string, stage = "plan"): boolean {
  const isQuota = isGeminiQuotaError(message);
  const isAuth = !isQuota && isGeminiAuthError(message);
  if (!isQuota && !isAuth) return notified.has(runId);
  if (notified.has(runId)) return true;
  notified.add(runId);
  pauseRunForOperator(
    runId,
    isAuth
      ? "GEMINI UNAVAILABLE — GOOGLE_API_KEY is invalid (HTTP 400 \"API key not valid\"). " +
        "Pausing this run now instead of finishing it degraded: NO text/overlay cards would be " +
        "produced (Gemini writes them), footage search would fall back to keywords cut from the " +
        "narration, and image/frame quality control would silently accept everything unchecked " +
        "for the rest of the run — including a provider's own \"blocked by safety filter\" " +
        "placeholder, if one comes back. Fix GOOGLE_API_KEY in Settings, then click Resume on " +
        "this run: every beat already rendered is kept, only what's missing gets (re)generated."
      : "GEMINI UNAVAILABLE — the API key is out of quota (HTTP 429). Pausing this run now instead " +
        "of finishing it degraded: NO text/overlay cards would be produced (Gemini writes them), " +
        "footage search would fall back to keywords cut from the narration, and image/frame quality " +
        "control would silently accept everything unchecked for the rest of the run — including a " +
        "provider's own \"blocked by safety filter\" placeholder, if one comes back. Check the " +
        "GOOGLE_API_KEY quota and billing in Google AI Studio, top it up, then click Resume on this " +
        "run: every beat already rendered is kept, only what's missing gets (re)generated.",
    // The stage the wall was FIRST hit in. A key can also run dry mid-run, after planning
    // succeeded — filing that under "plan" would point at the wrong part of the timeline.
    stage
  );
  return true;
}

/**
 * Same pause as `noteGeminiQuota`, for the case a quota/auth HTTP failure never even reaches:
 * GOOGLE_API_KEY is blank. Callers that short-circuit before attempting a Gemini call (no point
 * making a request with no key) used to just log a warning and silently degrade for the whole
 * run — call this instead so a run started with no key at all pauses the same way one that runs
 * out of quota mid-flight does, rather than finishing unjudged with nothing to fix afterward.
 */
export function noteGeminiKeyMissing(runId: string, stage = "plan"): void {
  if (notified.has(runId)) return;
  notified.add(runId);
  pauseRunForOperator(
    runId,
    "GEMINI UNAVAILABLE — GOOGLE_API_KEY is not set. Pausing this run now instead of finishing it " +
      "degraded: NO text/overlay cards would be produced (Gemini writes them), footage search " +
      "would fall back to keywords cut from the narration, and image/frame quality control would " +
      "silently accept everything unchecked for the rest of the run — including a provider's own " +
      "\"blocked by safety filter\" placeholder, if one comes back. Set GOOGLE_API_KEY in " +
      "Settings, then click Resume on this run: every beat already rendered is kept, only what's " +
      "missing gets (re)generated.",
    stage
  );
}

/** Has this run already hit a Gemini quota wall? Reporting only — never used to route. */
export function geminiQuotaHit(runId: string): boolean {
  return notified.has(runId);
}

/** Test seam: forget a run's notice so the once-per-run behaviour can be exercised repeatedly. */
export function __resetGeminiQuotaNotice(runId?: string): void {
  if (runId) notified.delete(runId);
  else notified.clear();
}

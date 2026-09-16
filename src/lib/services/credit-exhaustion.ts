import { pauseRunForOperator } from "../run-lifecycle";

/**
 * ONE loud line per run, PAUSING it, the first time ANY paid provider reports it is out of
 * credit/balance — not just Gemini (see gemini-quota.ts, which this mirrors but keeps
 * separate: Gemini's wording and its "no fallback provider exists" consequence are specific
 * enough to earn its own message).
 *
 * WHY PAUSE EVEN WHEN A FALLBACK COVERS THE BEAT: an operator asked for this explicitly,
 * having watched a run keep going after kie.ai ran out of credit — every subsequent beat
 * quietly fell through to 69labs/Meta Muse/Pollinations, which mostly worked but is a
 * DIFFERENT model/style per beat, and a couple of beats still degraded (reused a neighbour's
 * visual) once every fallback in the chain was also exhausted or rate-limited. Waiting until
 * "no alternative is left" caught only the second case; it never told the operator that the
 * FIRST provider — the one they're actually paying for and configured as primary — had gone
 * dry, until long after the video shows it. Pausing on the first sighting, whatever the
 * outcome for that one beat, means every subsequent beat is generated with the operator's
 * actual settings restored, not a silent substitute.
 *
 * Same mechanism as noteGeminiQuota: reuses the exact cancel path a user-initiated Stop uses
 * (see `pauseRunForOperator`), so Resume already knows how to continue — every beat already
 * rendered is kept, nothing new starts until the operator tops up and clicks Resume.
 */
const notified = new Map<string, string>(); // runId -> which provider triggered it (for a second call's return value)

/**
 * Does this message read as "this account is out of money", independent of which provider
 * said it? Deliberately broad — every provider phrases it differently and most of them
 * cannot be probed live — but scoped to unambiguous billing language so a genuine content/
 * validation rejection (also sometimes a 4xx) is never misread as a credit problem.
 */
export function looksLikeCreditExhaustion(message: string): boolean {
  return /\b402\b|insufficient\s+(credit|balance|funds)|credits?\s+(insufficient|exhausted|depleted)|(out\s+of|no\s+more)\s+credits?|(low|insufficient)\s+balance|add\s+(funds|credit)|top\s*-?up\s+your\s+(balance|credit)|prepayment\s+credit|payment\s+required/i.test(
    message
  );
}

/**
 * Report a provider failure IF it reads as credit exhaustion, and pause the run on the first
 * one — from ANY provider, not just the one first hit. Returns whether this run is already
 * paused for this reason, mirroring noteGeminiQuota's contract.
 *
 * Deliberately generic: unlike noteGeminiQuota (which knows Gemini has zero fallback for its
 * roles), this fires even when the CURRENT beat still succeeds via a different provider —
 * see the module doc for why that is the point, not a bug.
 */
export function noteCreditExhausted(runId: string, provider: string, message: string, stage: string): boolean {
  if (!looksLikeCreditExhaustion(message)) return notified.has(runId);
  if (notified.has(runId)) return true;
  notified.set(runId, provider);
  pauseRunForOperator(
    runId,
    `${provider.toUpperCase()} OUT OF CREDIT — pausing this run now instead of continuing on a ` +
      `substitute provider for the rest of it. Whatever handled this one beat, every beat after ` +
      `it would have used a fallback instead of ${provider} until you fix this. Top up ${provider} ` +
      `credit/balance, then click Resume on this run: every beat already rendered is kept, only ` +
      `what's missing gets (re)generated — with ${provider} restored.`,
    stage
  );
  return true;
}

/** Has this run already paused for a credit wall, and which provider triggered it? */
export function creditExhaustionHit(runId: string): string | null {
  return notified.get(runId) ?? null;
}

/** Test seam: forget a run's notice so the once-per-run behaviour can be exercised repeatedly. */
export function __resetCreditExhaustionNotice(runId?: string): void {
  if (runId) notified.delete(runId);
  else notified.clear();
}

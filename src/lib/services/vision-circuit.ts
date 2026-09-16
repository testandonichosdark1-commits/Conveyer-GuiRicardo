/**
 * Run-scoped circuit breaker for high-volume Gemini Vision calls.
 *
 * We track API ATTEMPTS (not scene quality): only availability failures such as
 * timeout / 429 / 5xx / network errors count toward opening the circuit. Scores,
 * bad matches and malformed model content do not. This lets a transient Gemini
 * incident stop expensive multimodal retries without affecting the planner.
 */

const WINDOW_SIZE = 10;
const FAILURE_THRESHOLD = 5;
const OPEN_MS = 60_000;

type Outcome = "success" | "failure";

interface VisionCircuitState {
  outcomes: Outcome[];
  openUntil: number;
  probeInFlight: boolean;
}

export interface VisionCircuitDecision {
  allow: boolean;
  /** True only for the single request allowed after the 60s open period. */
  probe: boolean;
  /** Present when the caller should emit a state-transition log. */
  transition?: "half-open";
  /** Remaining cooldown when allow=false. */
  retryAfterMs?: number;
}

export interface VisionCircuitUpdate {
  transition?: "open" | "closed" | "reopened";
  failuresInWindow: number;
  samplesInWindow: number;
  openUntil?: number;
}

const states = new Map<string, VisionCircuitState>();

function stateFor(runId: string): VisionCircuitState {
  let state = states.get(runId);
  if (!state) {
    state = { outcomes: [], openUntil: 0, probeInFlight: false };
    states.set(runId, state);
  }
  return state;
}

function pushOutcome(state: VisionCircuitState, outcome: Outcome): void {
  state.outcomes.push(outcome);
  if (state.outcomes.length > WINDOW_SIZE) state.outcomes.splice(0, state.outcomes.length - WINDOW_SIZE);
}

function stats(state: VisionCircuitState): { failures: number; samples: number } {
  return {
    failures: state.outcomes.filter((x) => x === "failure").length,
    samples: state.outcomes.length,
  };
}

/**
 * Check whether a Gemini Vision API call may start.
 *
 * OPEN      -> bypass until cooldown expires.
 * HALF-OPEN -> exactly one probe is admitted; concurrent calls keep bypassing.
 * CLOSED    -> calls proceed normally.
 */
export function beforeVisionCall(runId: string, now = Date.now()): VisionCircuitDecision {
  const state = stateFor(runId);
  if (state.openUntil > now) {
    return { allow: false, probe: false, retryAfterMs: state.openUntil - now };
  }

  // Cooldown just expired: admit exactly one probe. Other concurrent beats bypass
  // until that probe records success/failure.
  if (state.openUntil > 0) {
    if (state.probeInFlight) return { allow: false, probe: false, retryAfterMs: 0 };
    state.probeInFlight = true;
    return { allow: true, probe: true, transition: "half-open" };
  }

  return { allow: true, probe: false };
}

/** True only for outages/rate limits that should contribute to the breaker. */
export function isVisionAvailabilityFailure(reason: string): boolean {
  const status = Number(reason.match(/\bGemini (\d{3})\b/)?.[1] ?? 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return /\btimeout\b|fetch failed|ECONNRESET|ETIMEDOUT|network|overloaded|high demand|temporarily unavailable/i.test(reason);
}

/** Record one failed Gemini API ATTEMPT. */
export function noteVisionFailure(
  runId: string,
  reason: string,
  probe = false,
  now = Date.now()
): VisionCircuitUpdate | null {
  if (!isVisionAvailabilityFailure(reason)) return null;
  const state = stateFor(runId);

  // Only the explicitly admitted half-open probe may re-open/extend the circuit.
  // Calls that were already in flight when another request opened the breaker are
  // ignored here so a burst of late failures cannot keep extending the cooldown.
  if (probe) {
    state.probeInFlight = false;
    state.openUntil = now + OPEN_MS;
    pushOutcome(state, "failure");
    const { failures, samples } = stats(state);
    return { transition: "reopened", failuresInWindow: failures, samplesInWindow: samples, openUntil: state.openUntil };
  }
  if (state.openUntil > 0) {
    const { failures, samples } = stats(state);
    return { failuresInWindow: failures, samplesInWindow: samples, openUntil: state.openUntil };
  }

  pushOutcome(state, "failure");
  const { failures, samples } = stats(state);
  if (failures >= FAILURE_THRESHOLD) {
    state.openUntil = now + OPEN_MS;
    state.probeInFlight = false;
    return { transition: "open", failuresInWindow: failures, samplesInWindow: samples, openUntil: state.openUntil };
  }
  return { failuresInWindow: failures, samplesInWindow: samples };
}

/** Record one successful Gemini Vision API response. */
export function noteVisionSuccess(runId: string, probe = false): VisionCircuitUpdate {
  const state = stateFor(runId);
  if (probe) {
    // Recovery should start with a clean health window so old outage failures do not
    // instantly re-open the breaker after one healthy probe.
    state.outcomes = [];
    state.openUntil = 0;
    state.probeInFlight = false;
    return { transition: "closed", failuresInWindow: 0, samplesInWindow: 0 };
  }

  // A normal call may finish after a concurrent request has already opened the
  // circuit. It must not close the breaker; only the half-open probe can do that.
  if (state.openUntil > 0) {
    const { failures, samples } = stats(state);
    return { failuresInWindow: failures, samplesInWindow: samples, openUntil: state.openUntil };
  }

  pushOutcome(state, "success");
  const { failures, samples } = stats(state);
  return { failuresInWindow: failures, samplesInWindow: samples };
}

/** Tests / explicit run cleanup. Safe to call even if no state exists. */
export function resetVisionCircuit(runId?: string): void {
  if (runId) states.delete(runId);
  else states.clear();
}

export const VISION_CIRCUIT = Object.freeze({
  windowSize: WINDOW_SIZE,
  failureThreshold: FAILURE_THRESHOLD,
  openMs: OPEN_MS,
});

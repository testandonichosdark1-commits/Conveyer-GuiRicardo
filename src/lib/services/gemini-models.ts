/**
 * Single source of truth for which Gemini models the planning pipeline may call,
 * plus the shared retry/fallback primitives (ladder builder + error classifier).
 *
 * WHY THIS FILE EXISTS
 * Google retires models on a schedule. gemini-2.0-flash and gemini-2.0-flash-lite
 * were retired 2026-06-01 and now return a permanent 404 ("model not found for API
 * version v1beta"). Previously the failover ladder was hardcoded inline in
 * studio-plan.ts and still listed those dead models, so every failover walked onto
 * a 404. To survive the NEXT retirement, the model roster lives in exactly ONE
 * place: edit `SUPPORTED_GEMINI_MODELS` (and, if you like, `RETIRED_GEMINI_MODELS`)
 * here and every retry path updates at once.
 */

/**
 * The LIVE Gemini models the planner may fail over to, in preference order.
 * The caller's configured model (e.g. a user-chosen gemini-2.5-pro) is tried
 * first; these are the shared fallbacks appended after it.
 *
 * To migrate on a future Google retirement: change ONLY this array.
 */
export const SUPPORTED_GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

/**
 * Models Google has retired. They are filtered out of every ladder so no code
 * path can ever request them again — even if a stale DB setting still names one
 * (the ladder self-heals to the supported models instead).
 */
export const RETIRED_GEMINI_MODELS: ReadonlySet<string> = new Set([
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-lite-001",
]);

/**
 * Build a de-duplicated failover ladder of LIVE models: the caller's preferred
 * model first (honoring an explicitly configured model), then the supported
 * fallbacks. Retired models and duplicates are dropped, so the ladder is always
 * unique + live, and each model is attempted at most once. Never empty — if the
 * preferred model is retired/blank it falls back to the supported list.
 */
export function buildGeminiLadder(preferred?: string | null): string[] {
  const ladder: string[] = [];
  for (const m of [preferred ?? "", ...SUPPORTED_GEMINI_MODELS]) {
    const name = m.trim();
    if (name && !RETIRED_GEMINI_MODELS.has(name) && !ladder.includes(name)) {
      ladder.push(name);
    }
  }
  return ladder.length ? ladder : [...SUPPORTED_GEMINI_MODELS];
}

/**
 * Classify a Gemini failure so the retry loop knows whether failing over is worth
 * a backoff.
 *
 *   "transient"  → 429 / 5xx / timeouts / network drops / overload. Worth waiting
 *                  and retrying on the next model.
 *   "permanent"  → 4xx other than 429 (400 bad request, 401/403 auth, 404 model
 *                  retired) and any unrecognized error. Retrying the SAME request
 *                  can never succeed, so skip the model immediately with NO backoff
 *                  (a sibling model may still work, or we fall through to keyword).
 *
 * Our HTTP errors are thrown as `Gemini <status>: <body>`, so the status code is
 * the primary signal; timeout/network errors are matched by message.
 */
export function classifyGeminiError(message: string): "transient" | "permanent" {
  const status = Number(message.match(/\bGemini (\d{3})\b/)?.[1] ?? 0);
  if (status === 429 || (status >= 500 && status <= 599)) return "transient";
  if (status >= 400 && status < 500) return "permanent";
  // Non-HTTP failures: aborts/timeouts and transport drops are worth a retry.
  if (/\btimeout\b|fetch failed|ECONNRESET|ETIMEDOUT|network|overloaded|high demand|temporarily unavailable/i.test(message)) {
    return "transient";
  }
  // Unknown (e.g. a malformed response body) — don't burn backoff on it; skip the
  // model fast and let the ladder / keyword fallback take over.
  return "permanent";
}

/** Minimal shape of a Gemini `generateContent` response — only the fields our callers read. */
export interface GeminiGenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

/** Details of one failed attempt, handed to `onFailure` for caller-specific logging. */
export interface GeminiAttemptFailure {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Total attempt budget. */
  maxAttempts: number;
  /** Model used on the failed attempt. */
  model: string;
  /** Model the next attempt will use, or null if this was the last / no live model remains. */
  nextModel: string | null;
  /** Error message (untrimmed — caller slices for its own log). */
  reason: string;
  /** Whether the failure is worth another attempt (transient) or the model was skipped (permanent). */
  kind: "transient" | "permanent";
}

export interface CallGeminiOptions {
  apiKey: string;
  /** Configured/preferred model — tried first, then the shared live fallbacks. */
  model: string;
  /** JSON-stringified request body. The caller builds it, so prompts/params are unchanged. */
  body: string;
  /**
   * Total attempt budget across the ladder. Default = number of live models (each
   * tried once). If larger than the live-model count, live models are CYCLED
   * (models that returned a permanent error are dropped) so a caller can keep its
   * historical retry count while also gaining cross-model failover.
   */
  maxAttempts?: number;
  /** Per-attempt hard timeout in ms. Omit for none. */
  timeoutMs?: number;
  /** Wait before the next attempt after N transient failures. Default 4000·N; return 0 for none. */
  backoffMs?: (transientFailures: number) => number;
  /**
   * Runs on every HTTP-200 response. Throw to force a TRANSIENT retry (e.g. an
   * empty/truncated body) — a validation throw never marks the model dead. Also
   * the hook for per-attempt cost metering (it sees the model that served).
   */
  validate?: (json: GeminiGenerateContentResponse, model: string) => void;
  /** Per-attempt failure notification, for caller-specific logging. */
  onFailure?: (info: GeminiAttemptFailure) => void;
}

export interface CallGeminiResult {
  json: GeminiGenerateContentResponse;
  /** The model that actually served the successful response (for cost metering). */
  model: string;
}

/**
 * THE single Gemini `generateContent` retry/failover implementation for the whole
 * repository. Every caller delegates model selection, retries, backoff, timeout and
 * error classification here; none reimplements them. Behavior:
 *
 *   - builds the failover ladder from {@link buildGeminiLadder} (live models only);
 *   - transient error (503/429/timeout/network) → back off, fail over to the next model;
 *   - permanent error (404 retired / 400 / 401 / 403) → skip the model with NO backoff;
 *   - `validate()` throw → transient retry (content blip), model NOT killed;
 *   - returns the parsed JSON + serving model on the first success;
 *   - throws the last error once the budget or the live models are exhausted (the
 *     caller then runs its own fallback — keyword planner, lexical scoring, etc.).
 *
 * The success path performs exactly one fetch + `r.json()`, so a successful request
 * behaves identically to a hand-rolled single call.
 */
export async function callGemini(opts: CallGeminiOptions): Promise<CallGeminiResult> {
  const { apiKey, model, body, timeoutMs, validate, onFailure } = opts;
  const backoffMs = opts.backoffMs ?? ((n: number) => 4000 * n);
  const ladder = buildGeminiLadder(model);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? ladder.length);
  const dead = new Set<string>(); // models that returned a permanent error — never reused
  let transientFailures = 0;
  let lastErr = "";

  // Next live model for the attempt whose 0-based slot is `slot`, cycling the ladder
  // and skipping permanently-dead models (plus an optional model dying right now).
  const liveModelFor = (slot: number, dyingNow?: string): string | null => {
    for (let k = 0; k < ladder.length; k++) {
      const m = ladder[(slot + k) % ladder.length];
      if (!dead.has(m) && m !== dyingNow) return m;
    }
    return null;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const useModel = liveModelFor(attempt - 1);
    if (!useModel) break; // every live model has hit a permanent error
    if (transientFailures > 0) {
      const wait = backoffMs(transientFailures);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
      let r: Response;
      if (timeoutMs && timeoutMs > 0) {
        const ctrl = new AbortController();
        const tt = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctrl.signal });
        } catch (e) {
          throw e instanceof Error && e.name === "AbortError" ? new Error(`Gemini timeout after ${Math.round(timeoutMs / 1000)}s`) : e;
        } finally {
          clearTimeout(tt);
        }
      } else {
        r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      }
      if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const json = (await r.json()) as GeminiGenerateContentResponse;
      // Content validation is separate from transport errors: a validate() rejection is a
      // TRANSIENT content blip (empty/truncated body), never a reason to kill the model.
      if (validate) {
        try {
          validate(json, useModel);
        } catch (ve) {
          lastErr = (ve as Error).message;
          transientFailures++;
          onFailure?.({ attempt, maxAttempts, model: useModel, nextModel: attempt < maxAttempts ? liveModelFor(attempt) : null, reason: lastErr, kind: "transient" });
          continue;
        }
      }
      return { json, model: useModel };
    } catch (e) {
      lastErr = (e as Error).message;
      const kind = classifyGeminiError(lastErr);
      const dyingNow = kind === "permanent" ? useModel : undefined;
      onFailure?.({ attempt, maxAttempts, model: useModel, nextModel: attempt < maxAttempts ? liveModelFor(attempt, dyingNow) : null, reason: lastErr, kind });
      if (kind === "permanent") dead.add(useModel);
      else transientFailures++;
    }
  }
  throw new Error(lastErr || "Gemini call failed");
}

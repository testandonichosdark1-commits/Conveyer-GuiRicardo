/**
 * Single source of truth for which Gemini models the planning pipeline may call,
 * plus the shared retry/fallback primitives (ladder builder + error classifier).
 *
 * WHY THIS FILE EXISTS
 * Google retires models on a schedule. gemini-2.0-flash and gemini-2.0-flash-lite
 * were retired 2026-06-01 and now return a permanent 404 ("model not found for API
 * version v1beta"). gemini-2.5-flash / -flash-lite / -pro shut down 2026-10-16
 * (Google's named replacements: gemini-3.5-flash and gemini-3.1-flash-lite). To
 * survive each retirement the model roster lives in exactly ONE place: edit
 * `SUPPORTED_GEMINI_MODELS` + `GEMINI_MODEL_REPLACEMENT` here and every retry path
 * updates at once.
 *
 * We PROACTIVELY retire the 2.5 models (they're in `GEMINI_MODEL_REPLACEMENT`
 * below, so also in `RETIRED_GEMINI_MODELS`): they're dropped from every ladder and
 * transparently substituted with their Gemini-3 successor, so an operator can't
 * accidentally keep running an EOL model in the days before Google's shutdown. A
 * one-time settings migration rewrites any saved 2.5 model to its replacement, and
 * the Settings save handler refuses to persist a retired id.
 */

/**
 * The LIVE Gemini models the planner may fail over to, in preference order.
 * The caller's configured model (e.g. a user-chosen gemini-2.5-pro) is tried
 * first; these are the shared fallbacks appended after it.
 *
 * To migrate on a future Google retirement: change ONLY this array.
 */
export const SUPPORTED_GEMINI_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
] as const;

/**
 * Retired Gemini models → their best LIVE Gemini-3 replacement. A retired model is
 * filtered out of every ladder (so no code path can ever request it again) AND,
 * when it's the caller's configured model, transparently SUBSTITUTED with the
 * mapped replacement — so a stale `gemini-2.5-flash-lite` config keeps using a
 * flash-lite-class model, not whatever happens to be first in the supported list.
 *
 *   - gemini-2.0-*   retired 2026-06-01 (hard 404).
 *   - gemini-2.5-*   shut down 2026-10-16; proactively retired here so an EOL id
 *                    can't be run in the run-up to the shutdown date.
 *
 * Replacement is Google's named successor per class (flash→3.5-flash,
 * flash-lite→3.1-flash-lite, pro→3.1-pro-preview). pro-preview is not in the
 * supported ladder, so a 2.5-pro config tries pro-preview first then falls through
 * to the live supported flash models — never a dead end.
 */
export const GEMINI_MODEL_REPLACEMENT: Readonly<Record<string, string>> = {
  "gemini-2.0-flash": "gemini-3.5-flash",
  "gemini-2.0-flash-001": "gemini-3.5-flash",
  "gemini-2.0-flash-lite": "gemini-3.1-flash-lite",
  "gemini-2.0-flash-lite-001": "gemini-3.1-flash-lite",
  "gemini-2.5-flash": "gemini-3.5-flash",
  "gemini-2.5-flash-lite": "gemini-3.1-flash-lite",
  "gemini-2.5-pro": "gemini-3.1-pro-preview",
};

/**
 * Models Google has retired / we proactively retire. Derived from the replacement
 * map so the two never drift. Filtered out of every ladder — even if a stale DB
 * setting still names one.
 */
export const RETIRED_GEMINI_MODELS: ReadonlySet<string> = new Set(Object.keys(GEMINI_MODEL_REPLACEMENT));

/** True if `model` is a retired/deprecated Gemini id we must not run or persist. */
export function isRetiredGeminiModel(model: string | null | undefined): boolean {
  return RETIRED_GEMINI_MODELS.has((model ?? "").trim());
}

/**
 * The live Gemini-3 model that should stand in for `model`. If `model` is retired,
 * its mapped replacement (or, defensively, the first supported model if a retired
 * id ever lacks a mapping); otherwise the model unchanged. Used by the settings
 * migration + save handler to rewrite an EOL id, and by the ladder to substitute
 * at call time.
 */
export function replacementForGeminiModel(model: string): string {
  const name = (model ?? "").trim();
  if (!RETIRED_GEMINI_MODELS.has(name)) return name;
  return GEMINI_MODEL_REPLACEMENT[name] ?? SUPPORTED_GEMINI_MODELS[0];
}

/** Warn at most once per process per retired model so a stale config surfaces in logs without spamming. */
const warnedRetiredModels = new Set<string>();
function warnRetiredGeminiModel(model: string): void {
  if (warnedRetiredModels.has(model)) return;
  warnedRetiredModels.add(model);
  console.warn(
    `[gemini] model "${model}" is retired/deprecated — falling back to "${replacementForGeminiModel(model)}". ` +
      `Update SCENE_SPLIT_MODEL / VISION_MATCH_MODEL in Settings to a current model.`
  );
}

/* ── Cross-call model health ──────────────────────────────────────────────────
 *
 * `callGemini`'s own `dead` set is scoped to ONE call, which is right for its job —
 * "don't try this model twice in this request". But nothing remembered a failure
 * between calls, so a model that is broken for an entire install was re-tried first on
 * every single call. A run makes dozens of Gemini calls (planner chunks + per-beat
 * vision scoring), and an operator reported exactly that symptom: the configured model
 * "constantly" failing and the system "always" falling back.
 *
 * The cost of re-trying is not just noise. A transient failure increments the retry
 * loop's `transientFailures`, so the next attempt sleeps `backoffMs(1)` — 4 s by
 * default, paid per planner chunk. A permanent failure costs a wasted round-trip each
 * time. Neither ever taught the process anything.
 *
 * So: remember it, briefly, and DEMOTE — never remove. See `preferredOrder`.
 */

/** Consecutive transient failures before we stop leading with a model. */
const DEMOTE_AFTER_TRANSIENT = 3;
/** A rate limit clears on its own, so hold the demotion only briefly. */
const TRANSIENT_DEMOTE_MS = 60_000;
/** 403/404/400 will not fix itself; stop paying a round-trip for it every call. */
const PERMANENT_DEMOTE_MS = 30 * 60_000;

interface ModelHealth {
  /** Consecutive transient failures since the last success. */
  transient: number;
  /** Epoch ms until which this model should not be tried first. 0 = healthy. */
  demotedUntil: number;
}
const modelHealth = new Map<string, ModelHealth>();
/** Models we have already announced as demoted, so a broken key logs once, not per call. */
const announcedDemotions = new Set<string>();

/** True while `model` is demoted — i.e. tried only after the healthy ones. */
function isDemoted(model: string): boolean {
  const h = modelHealth.get(model);
  return !!h && h.demotedUntil > Date.now();
}

/**
 * Record a failed attempt. A permanent error demotes immediately; a transient one only
 * after several in a row, because a single busy minute is not a broken model.
 *
 * Announced with `console.warn` on the way down. Silently routing around a model the
 * operator explicitly configured would hide a real problem with their API key — the
 * whole point is that the run keeps working AND the cause stays visible.
 */
export function noteGeminiModelFailure(model: string, kind: "transient" | "permanent"): void {
  const h = modelHealth.get(model) ?? { transient: 0, demotedUntil: 0 };
  if (kind === "permanent") {
    h.demotedUntil = Date.now() + PERMANENT_DEMOTE_MS;
  } else {
    h.transient++;
    if (h.transient >= DEMOTE_AFTER_TRANSIENT) h.demotedUntil = Date.now() + TRANSIENT_DEMOTE_MS;
  }
  modelHealth.set(model, h);
  if (h.demotedUntil > Date.now() && !announcedDemotions.has(model)) {
    announcedDemotions.add(model);
    console.warn(
      `[gemini] model "${model}" keeps failing (${kind}) — trying it last for now. ` +
        `Other models still work, so runs continue; check the API key's quota/access for this model.`
    );
  }
}

/**
 * Record a success. Clears the record outright rather than decaying it: once the model
 * answers, whatever was wrong is over, and continuing to route around a working model
 * would be the mirror-image bug.
 */
export function noteGeminiModelSuccess(model: string): void {
  if (modelHealth.delete(model)) announcedDemotions.delete(model);
}

/** Drop all remembered health. Exists for tests — nothing in the app calls it. */
export function resetGeminiModelHealth(): void {
  modelHealth.clear();
  announcedDemotions.clear();
}

/**
 * The ladder reordered so demoted models come last, preserving relative order within
 * each group.
 *
 * DEMOTE, never drop: if every model is failing (Gemini itself down, key revoked) a
 * filtered list would be empty and the call would fail having tried nothing. A demoted
 * model must remain the last resort.
 */
export function preferredOrder(ladder: string[]): string[] {
  const healthy = ladder.filter((m) => !isDemoted(m));
  return healthy.length && healthy.length < ladder.length ? [...healthy, ...ladder.filter(isDemoted)] : ladder;
}

/**
 * Build a de-duplicated failover ladder of LIVE models: the caller's preferred
 * model first (honoring an explicitly configured model), then the supported
 * fallbacks. A retired preferred model is transparently substituted with its
 * Gemini-3 replacement (and warned once); retired models and duplicates are
 * otherwise dropped, so the ladder is always unique + live and each model is
 * attempted at most once. Never empty — if the preferred model is blank it falls
 * back to the supported list.
 */
export function buildGeminiLadder(preferred?: string | null): string[] {
  const first = (preferred ?? "").trim();
  const head = first && RETIRED_GEMINI_MODELS.has(first) ? (warnRetiredGeminiModel(first), replacementForGeminiModel(first)) : first;
  const ladder: string[] = [];
  for (const m of [head, ...SUPPORTED_GEMINI_MODELS]) {
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

/**
 * Is this failure the API key running out of quota, rather than Gemini being busy?
 *
 * Both arrive as HTTP 429 and both are classified "transient" above — correctly, since a
 * per-minute rate limit really does clear on its own. But an EXHAUSTED quota never clears
 * inside a run: every subsequent call 429s too, the planner falls through to the keyword
 * fallback for every beat, and the operator gets a video with no overlay cards and search
 * queries cut from the raw narration. That looked identical to "Gemini had a bad minute" in
 * the logs, so it is called out separately (see noteGeminiQuota).
 *
 * Google words it as a `RESOURCE_EXHAUSTED` status with "Quota exceeded for quota metric …",
 * and our thrown message carries the first 200 bytes of that body. A bare 429 with no body
 * detail stays UNMATCHED here: it is far likelier to be a momentary rate limit, and calling
 * that "your key is out of quota" would send the operator to fix a bill that is already paid.
 *
 * A pay-as-you-go key exhausts a DIFFERENT way: the body reads "Your prepayment credit
 * balance is too low …", not "quota"/"RESOURCE_EXHAUSTED" at all — confirmed live: a real run's
 * 429 body put its `"status": "RESOURCE_EXHAUSTED"` field far enough into the JSON (after a
 * long `message`) that the 200-byte slice above cut it off before this check ever saw it, so
 * the quota wall went completely unreported for the rest of that run. "prepayment" is matched
 * on its own, independent of the RESOURCE_EXHAUSTED/quota wording, precisely so a truncated
 * body still classifies correctly.
 */
export function isGeminiQuotaError(message: string): boolean {
  if (!/\bGemini 429\b/.test(message)) return false;
  return /RESOURCE_EXHAUSTED|quota exceeded|exceeded your current quota|prepayment credit/i.test(message);
}

/**
 * Is this failure a bad/missing GOOGLE_API_KEY, rather than Gemini rejecting the request
 * content? Both can arrive as HTTP 400, so the message body — not just the status — decides.
 * Google returns `"status": "INVALID_ARGUMENT"` with a message starting "API key not valid"
 * for a wrong/revoked key; that never clears on its own within a run, so — like an exhausted
 * quota — every subsequent Gemini call fails identically for the rest of the run (see
 * noteGeminiQuota, which pauses on this the same way it pauses on quota exhaustion).
 */
export function isGeminiAuthError(message: string): boolean {
  if (!/\bGemini 400\b/.test(message)) return false;
  return /api key not valid|api_key_invalid/i.test(message);
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
  /**
   * When false, retries stay on the configured model instead of crossing the shared
   * failover ladder. Vision calls use this to avoid escalating cheap Flash-Lite work
   * to a much more expensive model during transient outages.
   */
  allowModelFallback?: boolean;
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
 *   - builds the failover ladder from {@link buildGeminiLadder} (live models only), unless
 *     `allowModelFallback=false`, in which case retries stay on the configured model;
 *   - transient error (503/429/timeout/network) → back off, then use the next eligible attempt model;
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
  // Most callers use the shared cross-model ladder. High-volume Vision calls can opt out
  // so a transient Flash-Lite outage does not silently escalate thousands of image tokens
  // to a more expensive model; retries then stay on the configured model only.
  const ladder = opts.allowModelFallback === false
    ? [model]
    : preferredOrder(buildGeminiLadder(model));
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
      noteGeminiModelSuccess(useModel);
      return { json, model: useModel };
    } catch (e) {
      lastErr = (e as Error).message;
      const kind = classifyGeminiError(lastErr);
      noteGeminiModelFailure(useModel, kind);
      const dyingNow = kind === "permanent" ? useModel : undefined;
      onFailure?.({ attempt, maxAttempts, model: useModel, nextModel: attempt < maxAttempts ? liveModelFor(attempt, dyingNow) : null, reason: lastErr, kind });
      if (kind === "permanent") dead.add(useModel);
      else transientFailures++;
    }
  }
  throw new Error(lastErr || "Gemini call failed");
}

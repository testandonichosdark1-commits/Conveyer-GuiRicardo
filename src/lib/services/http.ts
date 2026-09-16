/**
 * Shared HTTP transport for every provider client (kie, 69labs, replicate, openai, fal…).
 *
 * WHY THIS EXISTS — the dead-socket problem:
 * A naked fetch() in Node has NO timeout. When the machine sleeps, in-flight TCP
 * connections die SILENTLY (no RST, no close), so the fetch waits on a dead socket
 * forever. A hung job holds a pipeline concurrency slot permanently, so a few hangs
 * freeze the whole run with no error and no log. Every provider fetch must therefore
 * be bounded by a per-request timeout — a DEAD-CONNECTION DETECTOR, not a perf limit.
 * (This is the exact failure that hung a 69labs image run for 8+ minutes with no log:
 * the create POST used a naked fetch, so a stalled socket never resolved and the
 * "job created" line that follows it was never reached.)
 *
 * WHY IT ISN'T "just wrap fetch with a timeout and retry": a timeout must NEVER be
 * turned into a blind retry on a BILLABLE create. An aborted POST may already have
 * reached the server and created (and charged for) the job; we simply never saw the
 * reply. Re-sending would create — and bill — a SECOND job. So retry-on-our-own-timeout
 * is the CALLER's decision (FetchPolicy.retryOnTimeout): true only for free + idempotent
 * requests (polls, downloads), false for billable creates. This split is the whole point
 * of the abstraction, and getting it wrong costs real money.
 *
 * This is the generalization of the kie.ai resilience layer (formerly private to kie.ts),
 * so every provider now shares ONE dead-socket policy instead of each reinventing it.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flatten name + message + code down the `cause` chain. Node's fetch buries the real
 *  network failure (ECONNRESET, ENOTFOUND) in `cause`, surfacing only a generic
 *  TypeError("fetch failed") at the top, so matching the top-level message is blind. */
export function errorChainText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const o = cur as { name?: string; message?: string; code?: string; cause?: unknown };
    if (o.name) parts.push(o.name);
    if (o.message) parts.push(o.message);
    if (o.code) parts.push(o.code);
    cur = o.cause;
  }
  return parts.join(" | ");
}

/** Did WE hang up (our timeout ceiling, or a caller's cancellation signal)? Classified
 *  by the structured `name` first — our timeout yields TimeoutError, a manual abort yields
 *  AbortError — with the message/cause chain only as a fallback guard. */
export function isOurAbort(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  return /TimeoutError|AbortError|operation was aborted/i.test(errorChainText(e));
}

/** Errors that PROVE the request never landed on the server: the socket never opened
 *  (DNS/refused) or died before a reply. Safe to re-send even a billable POST —
 *  no job can have been created. Anything else is treated as "unknown outcome". */
export function provesRequestNeverArrived(e: unknown): boolean {
  return /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo/i.test(errorChainText(e));
}

/**
 * Fetch bounded by a real timeout. Uses a manual AbortController + clearTimeout (rather
 * than AbortSignal.timeout) so the timer is ALWAYS cleared when the request settles —
 * no orphaned timers linger to fire under fake timers in tests, and a dead socket still
 * aborts with a TimeoutError. Any caller-supplied signal (cancellation) is composed in,
 * so a user cancel still wins early.
 */
async function fetchBounded(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException(`operation timed out after ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs
  );
  const signal = init.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal;
  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchPolicy {
  /** Per-request ceiling. ~1000× the healthy latency: a dead-socket detector, not a perf cap. */
  timeoutMs: number;
  /**
   * Is OUR OWN timeout retryable? TRUE only for FREE + IDEMPOTENT requests (polls,
   * downloads) — re-asking cannot lose or duplicate work, which is what rescues a dead
   * socket. FALSE for BILLABLE creates: an aborted POST may already have created (and
   * charged for) the job, so re-sending would double-bill.
   */
  retryOnTimeout: boolean;
  /**
   * Retry 429 / 5xx transparently (the server answered and rejected, so nothing was
   * created). Default TRUE. Set FALSE when the caller must inspect throttle responses
   * itself — e.g. 69labs' hourly-cap 403/429 wait loop, which reads the body + Retry-After.
   */
  retryStatus?: boolean;
  /** Max attempts across transient failures (default 3). */
  maxAttempts?: number;
}

/**
 * Bounded fetch with dead-socket detection + policy-driven retry. Returns the Response
 * (ok OR not — the caller interprets any non-retried status). Throws a labelled Error only
 * when the request could not be completed: our own timeout (terminal for a billable create),
 * exhausted retries, or an unknown transport failure on a billable request.
 */
export async function requestWithPolicy(
  url: string,
  init: RequestInit,
  label: string,
  policy: FetchPolicy
): Promise<Response> {
  const maxAttempts = policy.maxAttempts ?? 3;
  const retryStatus = policy.retryStatus ?? true;
  for (let attempt = 1; ; attempt++) {
    let r: Response;
    try {
      r = await fetchBounded(url, init, policy.timeoutMs);
    } catch (e) {
      if (isOurAbort(e)) {
        // We hung up. For a billable POST the server may already hold the job —
        // stop here and say why, in words an operator can act on.
        if (!policy.retryOnTimeout) {
          throw new Error(
            `${label}: timed out after ${policy.timeoutMs / 1000}s — not retried ` +
              `(a retry could create a second billable task)`
          );
        }
        if (attempt < maxAttempts) {
          await sleep(2000 * attempt);
          continue;
        }
        throw new Error(`${label}: timed out after ${policy.timeoutMs / 1000}s`);
      }
      // A genuine connection error: the request never arrived, so re-sending is safe
      // even when billable. An unknown error on a billable request is NOT re-sent.
      if (attempt < maxAttempts && (policy.retryOnTimeout || provesRequestNeverArrived(e))) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new Error(`${label}: ${(e as Error).message}`);
    }
    // The server answered and rejected transiently → it definitely created nothing.
    if (retryStatus && (r.status === 429 || r.status >= 500) && attempt < maxAttempts) {
      try {
        await r.text(); // drain the body so the socket can be reused
      } catch {}
      await sleep(2000 * attempt);
      continue;
    }
    return r;
  }
}

/**
 * Convenience over requestWithPolicy: ok → body text; non-ok → throw `${label} ${status}: ${body}`.
 * Use for JSON APIs whose non-2xx bodies carry the error message.
 */
export async function textWithPolicy(
  url: string,
  init: RequestInit,
  label: string,
  policy: FetchPolicy
): Promise<string> {
  const r = await requestWithPolicy(url, init, label, policy);
  const text = await r.text();
  if (r.ok) return text;
  throw new Error(`${label} ${r.status}: ${text.slice(0, 250)}`);
}

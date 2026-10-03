import { getSetting } from "../settings";
import { fetchBounded, errorChainText } from "./http";
import type { SceneJobStatus } from "../scene-job-store";

/**
 * Runpod Serverless client — QUEUE-BASED endpoints only (`/run` + `/status` + `/cancel`).
 * No production code calls this yet; it is transport for future remote providers.
 *
 * What it deliberately is NOT:
 *  - Not `/runsync`: video jobs run for minutes; a held-open request is a dead-socket risk.
 *  - Not `/retry`: Runpod can re-run a FAILED/TIMED_OUT job under the same id, but our
 *    scene jobs treat failed as terminal. The retry policy is decided with the first real worker.
 *  - Not a Pod / GPU manager: which GPUs serve an endpoint, in what priority, and the
 *    fallback between them, is the ENDPOINT's configuration on Runpod. This client only
 *    talks to the endpoint id it is given.
 *  - Not a store: it never writes scene_jobs. A provider combines the two.
 *  - Not storage: Runpod keeps async `/run` results for 30 minutes. A provider must download/persist any media in `output` right away;
 *    a job id is not a durable handle to its result.
 *  - Model-agnostic: `input` and `output` are opaque JSON.
 *
 * ── The submit problem ───────────────────────────────────────────────────────────────
 * Runpod documents no client idempotency key for `/run`. A submit whose reply we never
 * saw may or may not have created a (billable) job, and re-sending can run it twice. So
 * every submit failure carries a `delivery` verdict:
 *   - "not_delivered"  provably never reached Runpod (bad config, DNS failure, connection
 *                      refused, connect timeout, aborted before sending) → safe to re-send.
 *   - "rejected"       Runpod answered with a 4xx → no job was created.
 *   - "unknown"        anything else: our timeout after sending, a reset mid-response, a
 *                      5xx (a gateway can fail after forwarding), a 2xx we cannot parse.
 *                      NEVER safe to re-send automatically — the caller keeps its scene
 *                      job in `submitting` until the outcome is reconciled.
 * `/run` is therefore sent exactly ONCE per call: no transport or HTTP retry, ever.
 *
 * The API key is read here, sent only in the Authorization header, and scrubbed from
 * every error message; this module never logs.
 */

const API_BASE = "https://api.runpod.ai/v2";

export type RunpodEndpointKind = "ltx" | "infinitetalk";

const ENDPOINT_SETTING: Record<RunpodEndpointKind, "RUNPOD_LTX_ENDPOINT_ID" | "RUNPOD_INFINITETALK_ENDPOINT_ID"> = {
  ltx: "RUNPOD_LTX_ENDPOINT_ID",
  infinitetalk: "RUNPOD_INFINITETALK_ENDPOINT_ID",
};

export interface RunpodEndpoint {
  endpointId: string;
}

export type RunpodJobStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

const STATUSES: readonly RunpodJobStatus[] = ["IN_QUEUE", "IN_PROGRESS", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
const TERMINAL: readonly RunpodJobStatus[] = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];

export function isTerminalRunpodStatus(s: RunpodJobStatus): boolean {
  return TERMINAL.includes(s);
}

/** How a Runpod status reads as a scene job status. Pure: nothing is written anywhere. */
export function runpodStatusToSceneJobStatus(s: RunpodJobStatus): SceneJobStatus {
  switch (s) {
    case "IN_QUEUE":
      return "submitted";
    case "IN_PROGRESS":
    case "RUNNING":
      return "running";
    case "COMPLETED":
      return "succeeded";
    case "FAILED":
    case "TIMED_OUT":
      return "failed";
    case "CANCELLED":
      return "cancelled";
  }
}

/** Per-request execution policy, sent as Runpod's `policy` (Runpod's units: milliseconds). */
export interface RunpodPolicy {
  /** Max execution time once a worker picks the job up. Omitted = the endpoint's default. */
  executionTimeoutMs?: number;
  /** Max lifetime of the job, queue time included. Omitted = Runpod's default. */
  ttlMs?: number;
}

export interface RunpodJobState {
  id: string;
  status: RunpodJobStatus;
  /** Worker output, opaque. Short-lived on Runpod — persist what matters immediately. */
  output?: unknown;
  error?: unknown;
  executionTimeMs?: number;
  delayTimeMs?: number;
}

export interface RunpodSubmitResult {
  remoteJobId: string;
  /** Status in the submit reply when Runpod sent one (normally IN_QUEUE). */
  status: RunpodJobStatus | null;
}

const HEALTH_JOB_COUNTERS = ["completed", "failed", "inProgress", "inQueue", "retried"] as const;
const HEALTH_WORKER_COUNTERS = ["idle", "running"] as const;

export interface RunpodHealth {
  jobs: Record<string, number>;
  workers: Record<string, number>;
}

export type RunpodOp = "submit" | "status" | "cancel" | "health";
export type RunpodDelivery = "not_delivered" | "rejected" | "unknown";

export class RunpodError extends Error {
  constructor(
    message: string,
    readonly op: RunpodOp,
    /** Whether the request reached Runpod — see the module comment. */
    readonly delivery: RunpodDelivery,
    readonly code: "config" | "invalid_request" | "network" | "timeout" | "aborted" | "http" | "malformed_response" | "unknown_status",
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = "RunpodError";
  }
  /** Re-sending this submit cannot create a second job. */
  get safeToResubmit(): boolean {
    return this.op === "submit" && this.delivery !== "unknown";
  }
}

export interface RunpodRequestOptions {
  signal?: AbortSignal;
  /** Per-request dead-socket ceiling (default 30 s). */
  timeoutMs?: number;
  /** First backoff between GET retries (default 1 s; doubled each time, Retry-After wins). */
  retryBaseDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const GET_MAX_ATTEMPTS = 3;
const CANCEL_MAX_ATTEMPTS = 2;
const MAX_RETRY_AFTER_MS = 30_000;
/** Runpod's 10 MB limit for `/run`, checked on the FINAL serialised body (input + policy + any
 *  top-level field) in UTF-8 bytes, so an oversized request fails locally as not_delivered. */
const MAX_RUN_BODY_BYTES = 10 * 1024 * 1024;
const MAX_POLICY_MS = 7 * 24 * 60 * 60 * 1000;
/** Runpod's documented minimums: executionTimeout ≥ 5 s, ttl ≥ 10 s (both ≤ 7 days). */
const MIN_POLICY_MS = { executionTimeoutMs: 5_000, ttlMs: 10_000 } as const;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** The endpoint configured for `kind`. Throws (not_delivered) when it is not set. */
export function resolveRunpodEndpoint(kind: RunpodEndpointKind): RunpodEndpoint {
  const endpointId = (getSetting(ENDPOINT_SETTING[kind]) || "").trim();
  if (!endpointId) {
    throw new RunpodError(`Runpod ${kind} endpoint is not configured (${ENDPOINT_SETTING[kind]})`, "submit", "not_delivered", "config");
  }
  return { endpointId };
}

function apiKey(op: RunpodOp): string {
  const key = (getSetting("RUNPOD_API_KEY") || "").trim();
  if (!key) throw new RunpodError("RUNPOD_API_KEY is not set", op, "not_delivered", "config");
  return key;
}

function checkId(value: string, what: string, op: RunpodOp): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new RunpodError(`Runpod ${what} is invalid: ${JSON.stringify(String(value)).slice(0, 80)}`, op, "not_delivered", "invalid_request");
  }
  return value;
}

/** Remove the key from anything that may end up in an error message. */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join("[REDACTED]") : text;
}

/**
 * Proof — not a guess — that a request never reached the server: no DNS answer, the
 * connection was refused or never opened. Stricter than http.ts's
 * `provesRequestNeverArrived`, which also accepts ECONNRESET and a bare "fetch failed":
 * both also happen AFTER the request was sent, which is exactly the double-submit case.
 */
export function provesNotDelivered(e: unknown): boolean {
  const codes: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return codes.some((c) =>
    ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"].includes(c)
  );
}

function isAbortLike(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** One HTTP exchange. Transport failures become RunpodError with an honest delivery verdict. */
async function exchange(
  op: RunpodOp,
  url: string,
  init: RequestInit,
  key: string,
  opts: RunpodRequestOptions
): Promise<Response> {
  if (opts.signal?.aborted) throw new RunpodError(`Runpod ${op} aborted before sending`, op, "not_delivered", "aborted");
  try {
    return await fetchBounded(url, { ...init, signal: opts.signal }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (e) {
    const detail = scrub(errorChainText(e), key).slice(0, 300);
    if (provesNotDelivered(e)) throw new RunpodError(`Runpod ${op} could not connect: ${detail}`, op, "not_delivered", "network");
    // Checked on the signal, not the error's name: a caller may abort with any reason.
    const byCaller = opts.signal?.aborted === true;
    if (byCaller || isAbortLike(e)) {
      throw new RunpodError(
        byCaller ? `Runpod ${op} aborted by caller after sending` : `Runpod ${op} timed out after ${(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`,
        op, "unknown", byCaller ? "aborted" : "timeout"
      );
    }
    throw new RunpodError(`Runpod ${op} failed in transit: ${detail}`, op, "unknown", "network");
  }
}

async function httpError(op: RunpodOp, r: Response, key: string): Promise<RunpodError> {
  let body = "";
  try {
    body = scrub(await r.text(), key).slice(0, 300);
  } catch {}
  // A 4xx is Runpod refusing the request. A 5xx on a submit or cancel may come from a
  // gateway AFTER the request was acted on, so it proves nothing about the outcome.
  const delivery: RunpodDelivery = r.status < 500 ? "rejected" : op === "submit" || op === "cancel" ? "unknown" : "rejected";
  return new RunpodError(`Runpod ${op} HTTP ${r.status}${body ? `: ${body}` : ""}`, op, delivery, "http", r.status);
}

async function readJson(op: RunpodOp, r: Response, key: string, delivery: RunpodDelivery): Promise<Record<string, unknown>> {
  let text = "";
  try {
    text = await r.text();
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  throw new RunpodError(`Runpod ${op} returned an unreadable response: ${scrub(text, key).slice(0, 200)}`, op, delivery, "malformed_response", r.status);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new DOMException("aborted", "AbortError"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMs(r: Response): number | null {
  const v = r.headers.get("retry-after");
  if (!v) return null;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, MAX_RETRY_AFTER_MS) : null;
}

/**
 * Request with bounded retries, backoff and Retry-After; a caller abort stops at once.
 * Never used for `/run`.
 *  - replayAmbiguous = true (status/health reads, free to repeat): retries 429, 5xx,
 *    timeouts and transport errors.
 *  - replayAmbiguous = false (cancel): retries ONLY what provably did not act — a request
 *    that never arrived, or an explicit 429. A timeout, reset or 5xx after sending is
 *    returned to the caller, who reconciles through /status rather than replaying.
 */
async function requestWithRetry(
  op: RunpodOp,
  url: string,
  init: RequestInit,
  key: string,
  opts: RunpodRequestOptions,
  maxAttempts: number,
  replayAmbiguous = true
): Promise<Response> {
  const base = opts.retryBaseDelayMs ?? 1000;
  for (let attempt = 1; ; attempt++) {
    let wait = base * 2 ** (attempt - 1);
    try {
      const r = await exchange(op, url, init, key, opts);
      if ((r.status === 429 || (replayAmbiguous && r.status >= 500)) && attempt < maxAttempts) {
        wait = retryAfterMs(r) ?? wait;
        try { await r.text(); } catch {}
      } else {
        return r;
      }
    } catch (e) {
      if (opts.signal?.aborted || attempt >= maxAttempts || (e as RunpodError).code === "config") throw e;
      if (!replayAmbiguous && (e as RunpodError).delivery !== "not_delivered") throw e;
    }
    await abortableSleep(wait, opts.signal).catch(() => {
      throw new RunpodError(`Runpod ${op} aborted by caller`, op, "not_delivered", "aborted");
    });
  }
}

function headers(key: string, json: boolean): Record<string, string> {
  return { Authorization: `Bearer ${key}`, accept: "application/json", ...(json ? { "content-type": "application/json" } : {}) };
}

function checkPolicy(policy: RunpodPolicy | undefined): Record<string, number> | undefined {
  if (!policy) return undefined;
  const out: Record<string, number> = {};
  for (const [field, wire] of [["executionTimeoutMs", "executionTimeout"], ["ttlMs", "ttl"]] as const) {
    const v = policy[field];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < MIN_POLICY_MS[field] || v > MAX_POLICY_MS) {
      throw new RunpodError(`Runpod policy.${field} must be an integer between ${MIN_POLICY_MS[field]} ms and 7 days, got ${v}`, "submit", "not_delivered", "invalid_request");
    }
    out[wire] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseStatus(raw: unknown, op: RunpodOp, delivery: RunpodDelivery): RunpodJobStatus {
  if (typeof raw === "string" && (STATUSES as readonly string[]).includes(raw)) return raw as RunpodJobStatus;
  throw new RunpodError(`Runpod ${op} returned an unknown job status: ${JSON.stringify(raw)}`, op, delivery, "unknown_status");
}

function optionalMs(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function toJobState(body: Record<string, unknown>, op: RunpodOp, expectedId: string): RunpodJobState {
  if (typeof body.id !== "string" || !body.id) {
    throw new RunpodError(`Runpod ${op} response has no job id`, op, "rejected", "malformed_response");
  }
  if (body.id !== expectedId) {
    throw new RunpodError(`Runpod ${op} answered for job ${body.id}, expected ${expectedId}`, op, "rejected", "malformed_response");
  }
  const state: RunpodJobState = { id: body.id, status: parseStatus(body.status, op, "rejected") };
  if ("output" in body) state.output = body.output;
  if ("error" in body && body.error !== null && body.error !== undefined) state.error = body.error;
  const exec = optionalMs(body.executionTime);
  const delay = optionalMs(body.delayTime);
  if (exec !== undefined) state.executionTimeMs = exec;
  if (delay !== undefined) state.delayTimeMs = delay;
  return state;
}

/**
 * Queue a job (`POST /run`). Sent exactly once. On failure the RunpodError's `delivery`
 * says whether a job may exist; a success always carries a non-empty remote job id.
 */
export async function submitRunpodJob(
  endpoint: RunpodEndpoint,
  input: Record<string, unknown>,
  opts: RunpodRequestOptions & { policy?: RunpodPolicy } = {}
): Promise<RunpodSubmitResult> {
  const key = apiKey("submit");
  const endpointId = checkId(endpoint.endpointId, "endpoint id", "submit");
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RunpodError("Runpod submit input must be a JSON object", "submit", "not_delivered", "invalid_request");
  }
  const policy = checkPolicy(opts.policy);
  let body: string;
  try {
    body = JSON.stringify(policy ? { input, policy } : { input });
  } catch (e) {
    throw new RunpodError(`Runpod submit input is not serialisable: ${(e as Error).message}`, "submit", "not_delivered", "invalid_request");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_RUN_BODY_BYTES) {
    throw new RunpodError("Runpod submit body exceeds 10 MB — send references to media, not media", "submit", "not_delivered", "invalid_request");
  }

  const r = await exchange("submit", `${API_BASE}/${endpointId}/run`, { method: "POST", headers: headers(key, true), body }, key, opts);
  if (!r.ok) throw await httpError("submit", r, key);
  // From here the job most likely EXISTS: an unreadable reply leaves its id unknown.
  const json = await readJson("submit", r, key, "unknown");
  if (typeof json.id !== "string" || !json.id.trim()) {
    throw new RunpodError("Runpod submit succeeded but returned no job id", "submit", "unknown", "malformed_response", r.status);
  }
  let status: RunpodJobStatus | null = null;
  if (json.status !== undefined) {
    // The job was accepted; an unexpected status word must not hide its id.
    status = (STATUSES as readonly string[]).includes(json.status as string) ? (json.status as RunpodJobStatus) : null;
  }
  return { remoteJobId: json.id, status };
}

/** Current state of a job (`GET /status/{id}`). Retried on 429/5xx/timeouts — reads are free. */
export async function getRunpodJobStatus(
  endpoint: RunpodEndpoint,
  remoteJobId: string,
  opts: RunpodRequestOptions = {}
): Promise<RunpodJobState> {
  const key = apiKey("status");
  const endpointId = checkId(endpoint.endpointId, "endpoint id", "status");
  const id = checkId(remoteJobId, "job id", "status");
  const r = await requestWithRetry("status", `${API_BASE}/${endpointId}/status/${id}`, { method: "GET", headers: headers(key, false) }, key, opts, GET_MAX_ATTEMPTS);
  if (!r.ok) throw await httpError("status", r, key);
  return toJobState(await readJson("status", r, key, "rejected"), "status", id);
}

/**
 * Ask Runpod to cancel (`POST /cancel/{id}`). Returns the state Runpod reports — the job
 * is only cancelled if that says CANCELLED (a job that already finished stays finished).
 * Re-sent once only when the first request provably never arrived or got an explicit 429.
 * An ambiguous failure (timeout/reset/5xx after sending) throws with delivery "unknown":
 * the outcome must be read back with getRunpodJobStatus, never assumed or replayed.
 */
export async function cancelRunpodJob(
  endpoint: RunpodEndpoint,
  remoteJobId: string,
  opts: RunpodRequestOptions = {}
): Promise<RunpodJobState> {
  const key = apiKey("cancel");
  const endpointId = checkId(endpoint.endpointId, "endpoint id", "cancel");
  const id = checkId(remoteJobId, "job id", "cancel");
  const r = await requestWithRetry("cancel", `${API_BASE}/${endpointId}/cancel/${id}`, { method: "POST", headers: headers(key, false) }, key, opts, CANCEL_MAX_ATTEMPTS, false);
  if (!r.ok) throw await httpError("cancel", r, key);
  return toJobState(await readJson("cancel", r, key, "rejected"), "cancel", id);
}

/** Endpoint queue/worker counters (`GET /health`). Diagnostic only. */
export async function getRunpodEndpointHealth(endpoint: RunpodEndpoint, opts: RunpodRequestOptions = {}): Promise<RunpodHealth> {
  const key = apiKey("health");
  const endpointId = checkId(endpoint.endpointId, "endpoint id", "health");
  const r = await requestWithRetry("health", `${API_BASE}/${endpointId}/health`, { method: "GET", headers: headers(key, false) }, key, opts, GET_MAX_ATTEMPTS);
  if (!r.ok) throw await httpError("health", r, key);
  const json = await readJson("health", r, key, "rejected");
  // Documented counters are validated when present; extra numeric counters Runpod may add
  // later are kept, anything else unknown is ignored.
  const counters = (v: unknown, known: readonly string[], what: string): Record<string, number> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new RunpodError(`Runpod health response is missing ${what}`, "health", "rejected", "malformed_response");
    }
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v)) {
      const ok = typeof n === "number" && Number.isInteger(n) && n >= 0;
      if (known.includes(k) && !ok) {
        throw new RunpodError(`Runpod health ${what}.${k} is not a count: ${JSON.stringify(n)}`, "health", "rejected", "malformed_response");
      }
      if (ok) out[k] = n as number;
    }
    return out;
  };
  return {
    jobs: counters(json.jobs, HEALTH_JOB_COUNTERS, "jobs"),
    workers: counters(json.workers, HEALTH_WORKER_COUNTERS, "workers"),
  };
}

export class RunpodPollTimeoutError extends Error {
  constructor(readonly remoteJobId: string, readonly lastState: RunpodJobState | null, timeoutMs: number) {
    super(`Runpod job ${remoteJobId} not finished after ${Math.round(timeoutMs / 1000)}s (last status: ${lastState?.status ?? "none"})`);
    this.name = "RunpodPollTimeoutError";
  }
}

export interface WaitOptions extends RunpodRequestOptions {
  /** Give up after this long (required — there is no unbounded wait). */
  timeoutMs: number;
  /** First interval between polls (default 5 s). */
  intervalMs?: number;
  /** Ceiling the interval backs off to (default 30 s). */
  maxIntervalMs?: number;
  /** Interval multiplier per poll (default 1.5). */
  backoffFactor?: number;
  /** Called with every state observed (e.g. so a provider can record `running`). */
  onStatus?: (state: RunpodJobState) => void;
}

/**
 * Poll until the job reaches a terminal status and return that state. Bounded by
 * `timeoutMs` (throws RunpodPollTimeoutError — the job may still be running remotely),
 * stopped by `signal`, and backs off between polls. Errors from a status read, including
 * an unknown status, propagate unchanged. Leaves no timer behind.
 */
export async function waitForRunpodTerminalStatus(
  endpoint: RunpodEndpoint,
  remoteJobId: string,
  opts: WaitOptions
): Promise<RunpodJobState> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("waitForRunpodTerminalStatus: timeoutMs must be > 0");
  const max = Math.max(1, opts.maxIntervalMs ?? 30_000);
  const factor = Math.max(1, opts.backoffFactor ?? 1.5);
  let interval = Math.min(max, Math.max(1, opts.intervalMs ?? 5_000));
  const deadline = Date.now() + opts.timeoutMs;
  let last: RunpodJobState | null = null;
  for (;;) {
    last = await getRunpodJobStatus(endpoint, remoteJobId, opts);
    opts.onStatus?.(last);
    if (isTerminalRunpodStatus(last.status)) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RunpodPollTimeoutError(remoteJobId, last, opts.timeoutMs);
    await abortableSleep(Math.min(interval, remaining), opts.signal).catch(() => {
      throw new RunpodError(`Runpod polling of ${remoteJobId} aborted by caller`, "status", "not_delivered", "aborted");
    });
    interval = Math.min(max, Math.round(interval * factor));
  }
}

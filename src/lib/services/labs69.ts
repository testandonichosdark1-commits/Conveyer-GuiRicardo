import fs from "node:fs";
import { getSetting } from "../settings";
import { log, type LogLevel } from "../logger";
import { checkCancelled } from "../cancellation";
import { requestWithPolicy } from "./http";

/**
 * 69labs.vip API client with multi-key pool support.
 *
 * A single API key (vk_...) covers TTS + images + videos.
 * The platform supports MULTIPLE accounts/keys for higher parallelism — each
 * 69labs account has its own hard limits (7 concurrent images, 5 concurrent
 * videos), so 3 keys = 21 image / 15 video slots total.
 *
 * Keys are read from `LABS69_API_KEY` setting (newline or comma separated).
 * Jobs are bound to a specific key for their lifetime (poll/download/cancel
 * all use the same key that created the job) — required for img2vid chaining
 * because 69labs only lets the original account access a job's output.
 *
 * Docs:    https://69labs.vip/api-docs
 * OpenAPI: https://69labs.vip/api/docs/openapi.yaml
 */

const BASE = "https://69labs.vip/api/v1";
const POLL_INTERVAL_MS = 2500;

/**
 * Phase-aware polling budgets. A single flat 8-min timeout couldn't tell a job stuck in the
 * QUEUE (dead/congested — give up fast) from one actively RENDERING (GPU work — be patient),
 * so a stalled job burned the full 8 min with no logs. These split that decision:
 *
 *   • QUEUE_MAX_MS  — a job still PENDING past this is congestion/dead → cancel + recreate.
 *   • RENDER_MAX_MS — once PROCESSING/FINALIZING, allow the generous budget real renders need
 *                     (nano-banana-pro 2K legitimately takes 4–5 min). Never killed early.
 *   • STALL_MAX_MS  — if `progressPercent` (or status) hasn't advanced for this long WHILE a
 *                     progress signal exists, the job is dead regardless of phase.
 *   • HEARTBEAT_MS  — cadence of the "still rendering…/queued…" run-log heartbeat.
 *
 * INTERNAL engine constants — deliberately NOT surfaced in the settings UI. A developer can
 * override any of them with an env var (e.g. LABS69_QUEUE_MAX_MS) without a redeploy.
 */
const envMs = (name: string, def: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const QUEUE_MAX_MS = envMs("LABS69_QUEUE_MAX_MS", 120_000); // 2 min stuck in queue → dead
const RENDER_MAX_MS = envMs("LABS69_RENDER_MAX_MS", 480_000); // 8 min of real GPU work allowed
const STALL_MAX_MS = envMs("LABS69_STALL_MAX_MS", 90_000); // 90s with no progress change → dead
const HEARTBEAT_MS = envMs("LABS69_HEARTBEAT_MS", 30_000); // one heartbeat line every ~30s
/** Absolute wall-clock backstop so no pathological state can poll forever. */
const POLL_HARD_MAX_MS = QUEUE_MAX_MS + RENDER_MAX_MS;

// Per-request dead-socket ceilings (see ./http). These bound a SINGLE HTTP round-trip —
// distinct from the poll BUDGETS above, which bound the whole create→render lifecycle
// across many polls. A naked create fetch with no ceiling is exactly what hung a run for
// 8+ min with no log: the create POST never resolved, so the "job created" line after it
// was never reached. One request that stays silent this long is a dead socket, not slowness.
const CREATE_TIMEOUT_MS = envMs("LABS69_CREATE_TIMEOUT_MS", 60_000); // billable create POST
const STATUS_TIMEOUT_MS = envMs("LABS69_STATUS_TIMEOUT_MS", 60_000); // single status poll GET
const CANCEL_TIMEOUT_MS = envMs("LABS69_CANCEL_TIMEOUT_MS", 30_000); // best-effort cancel POST
const DOWNLOAD_TIMEOUT_MS = envMs("LABS69_DOWNLOAD_TIMEOUT_MS", 300_000); // media download GET

type JobKind = "tts" | "images" | "videos";
type JobStatus = "PENDING" | "PROCESSING" | "FINALIZING" | "COMPLETED" | "FAILED" | "CANCELLED" | "CENSORED";

/**
 * Human-facing phase label for a status. PENDING reads better as QUEUED in the logs (it is time
 * spent waiting in 69labs' queue, not our processing); every other status is already self-explaining.
 * Purely cosmetic — nothing branches on this.
 */
function phaseOf(status: JobStatus): string {
  return status === "PENDING" ? "QUEUED" : status;
}

// ── Key pool ────────────────────────────────────────────────────────────────

/**
 * Tracks in-flight job count per key.
 * Key list is parsed lazily from the LABS69_API_KEY setting on each pick(),
 * so users can add/remove keys live in /settings and we pick them up next job.
 */
const pool = {
  active: new Map<string, number>(),

  list(): string[] {
    return getSetting("LABS69_API_KEY")
      .split(/[\n,;]+/)
      .map((k) => k.trim())
      .filter(Boolean);
  },

  /** Pick the least-loaded key from the current pool. Bumps its counter. */
  pick(): string {
    const keys = this.list();
    if (keys.length === 0) throw new Error("LABS69_API_KEY is not set (Settings)");
    let best = keys[0];
    let bestCount = this.active.get(best) ?? 0;
    for (let i = 1; i < keys.length; i++) {
      const c = this.active.get(keys[i]) ?? 0;
      if (c < bestCount) {
        best = keys[i];
        bestCount = c;
      }
    }
    this.active.set(best, bestCount + 1);
    return best;
  },

  /** Manually acquire a specific key (used when chaining img2vid to a known image's key). */
  acquireSpecific(key: string) {
    if (!key) return;
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
  },

  release(key: string) {
    const c = this.active.get(key) ?? 0;
    if (c > 0) this.active.set(key, c - 1);
  },
};

/** Number of configured keys. Exposed for UI / pipeline concurrency scaling. */
export function getKeyCount(): number {
  return pool.list().length;
}

// ── Job ↔ key binding ───────────────────────────────────────────────────────

/**
 * jobId → key that created it. Needed because:
 *   • polling a job has to use the same account that created it
 *   • img2vid with imageJobId requires the same key as the source image
 */
const jobKeyMap = new Map<string, string>();

/**
 * jobId → queue position AT CREATION. 69labs returns `queuePosition` only on the create
 * response — the status endpoint omits it — so we stash it here to enrich the first "queued…"
 * heartbeat. It is not refreshed during polling (the API gives no live position).
 */
const jobQueuePos = new Map<string, number>();

/** Release a job's slot manually (used in caller error/cleanup paths). */
export function releaseJob(jobId: string) {
  const key = jobKeyMap.get(jobId);
  if (key) {
    pool.release(key);
    jobKeyMap.delete(jobId);
  }
  jobQueuePos.delete(jobId);
}

function authHeadersFor(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function keyFor(jobId: string): string {
  const k = jobKeyMap.get(jobId);
  if (k) return k;
  // Fallback to first key — happens for older jobs without binding (e.g. after server restart).
  const keys = pool.list();
  if (keys.length === 0) throw new Error("LABS69_API_KEY is not set");
  return keys[0];
}

// Rate-limit handling. 69labs caps creation throughput per hour
// (~200 clips/hour as of writing). Long overnight batches must keep going
// when the cap hits — so instead of sleeping the full hour in one shot, we
// retry every 10 minutes. If the limit clears early (e.g. at the top of the
// clock-hour) we pick up right away instead of wasting 30+ minutes asleep.
//
// 429 = the documented "too many requests" status. 403 with a body matching
// "hourly|credit limit|concurrent" is what 69labs actually returns when the
// per-hour Business cap is reached — treated identically. Non-throttle
// 4xx/5xx propagates immediately.
const RATE_LIMIT_MAX_RETRIES = 30;          // 30 × 10 min = up to 5h total wait
const RATE_LIMIT_WAIT_MS = 10 * 60_000;     // 10 min between retries

/**
 * POST helper. Transparently waits out HTTP 429 / 403-hourly-cap responses
 * instead of failing the run. Polls every 10 minutes until the cap clears
 * (with a `Retry-After` header honored if shorter than 10 min). The repeated
 * 10-min log heartbeat lets the operator see the run is still alive instead
 * of going quiet for a whole hour. Non-throttle errors propagate
 * immediately.
 */
async function postJsonWithKey<T>(
  path: string,
  body: unknown,
  key: string,
  ctx?: { runId: string; stage: string }
): Promise<T> {
  let rateRetry = 0;
  while (true) {
    // Billable create → retryOnTimeout:false (an aborted POST may already have created the
    // job — re-sending would double-bill). retryStatus:false so THIS function keeps owning
    // the 429/403 hourly-cap wait below (it needs the body + Retry-After header). A genuine
    // dead socket now aborts instead of hanging the whole run forever.
    const r = await requestWithPolicy(
      `${BASE}${path}`,
      { method: "POST", headers: authHeadersFor(key), body: JSON.stringify(body) },
      `69labs POST ${path}`,
      { timeoutMs: CREATE_TIMEOUT_MS, retryOnTimeout: false, retryStatus: false }
    );
    if (r.ok) return (await r.json()) as T;

    // Throttle detection: 429 always; 403 only when body matches the
    // 69labs hourly-cap / concurrent-limit text. Reading the body once
    // serves both detection and the eventual error message.
    let throttle = false;
    let errText = "";
    if (r.status === 429) {
      throttle = true;
      errText = await r.text();
    } else if (r.status === 403) {
      errText = await r.text();
      if (/hourly|credit limit|concurrent/i.test(errText)) throttle = true;
    }

    if (throttle && rateRetry < RATE_LIMIT_MAX_RETRIES) {
      rateRetry++;
      const retryAfter = Number(r.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter * 1000 < RATE_LIMIT_WAIT_MS
          ? retryAfter * 1000
          : RATE_LIMIT_WAIT_MS;
      if (ctx) {
        const waitText =
          waitMs >= 60_000
            ? `${Math.round(waitMs / 60_000)} min`
            : `${Math.round(waitMs / 1000)}s`;
        log(
          ctx.runId,
          "warn",
          `69labs rate limit (${r.status}) — retrying in ${waitText} (attempt ${rateRetry}/${RATE_LIMIT_MAX_RETRIES})`,
          { stage: ctx.stage }
        );
      }
      await sleep(waitMs);
      if (ctx) checkCancelled(ctx.runId); // don't resume a rate-limited create for a cancelled run
      continue;
    }

    throw new Error(
      `69labs POST ${path} ${r.status}: ${(errText || (await r.text())).slice(0, 400)}`
    );
  }
}

interface JobCreatedResponse {
  id: string;
  status?: JobStatus;
  queuePosition?: number | null;
}
interface MultiJobCreatedResponse {
  jobs: JobCreatedResponse[];
}

// ── TTS ─────────────────────────────────────────────────────────────────────

/** TTS: create a job. Returns jobId. Supports elevenlabs / edgetts / voice-clone. */
export async function createTtsJob(opts: {
  text: string;
  voiceId: string;
  voiceProvider?: "elevenlabs" | "edgetts" | "voice-clone";
  modelId?: string;
  splitType?: "smart" | "paragraphs" | "max_length";
  voiceSettings?: {
    stability?: number;
    similarityBoost?: number;
    speed?: number;
    style?: number;
    useSpeakerBoost?: boolean;
  };
  autoPauseEnabled?: boolean;
  autoPauseDuration?: number;
  autoPauseFrequency?: number;
  /** Optional — enables rate-limit (429) wait logging into the run log. */
  runId?: string;
}): Promise<string> {
  if (opts.runId) checkCancelled(opts.runId); // never start a new billable 69labs job for a cancelled run
  const key = pool.pick();
  const ctx = opts.runId ? { runId: opts.runId, stage: "tts" } : undefined;
  try {
    // Voice-clone uses a different endpoint
    if (opts.voiceProvider === "voice-clone") {
      const resp = await postJsonWithKey<JobCreatedResponse>(
        "/voice-clones/generate",
        { voiceCloneId: opts.voiceId, text: opts.text },
        key,
        ctx
      );
      jobKeyMap.set(resp.id, key);
      return resp.id;
    }
    const body: Record<string, unknown> = {
      text: opts.text,
      voiceId: opts.voiceId,
      splitType: opts.splitType ?? "smart",
    };
    if (opts.voiceProvider) body.voiceProvider = opts.voiceProvider;
    if (opts.modelId) body.modelId = opts.modelId;
    if (opts.voiceSettings && Object.keys(opts.voiceSettings).length > 0) {
      body.voiceSettings = opts.voiceSettings;
    }
    if (opts.autoPauseEnabled) {
      body.autoPauseEnabled = true;
      if (opts.autoPauseDuration !== undefined) body.autoPauseDuration = opts.autoPauseDuration;
      if (opts.autoPauseFrequency !== undefined) body.autoPauseFrequency = opts.autoPauseFrequency;
    }
    const resp = await postJsonWithKey<JobCreatedResponse>("/tts/generate", body, key, ctx);
    jobKeyMap.set(resp.id, key);
    return resp.id;
  } catch (e) {
    pool.release(key);
    throw e;
  }
}

// ── Images ──────────────────────────────────────────────────────────────────

/** Image: create a job. Returns jobId. */
export async function createImageJob(opts: {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  imageUrls?: string[];
  /** Optional — lets a cancelled run skip creating a new billable job. */
  runId?: string;
}): Promise<string> {
  if (opts.runId) checkCancelled(opts.runId); // never start a new billable 69labs job for a cancelled run
  const key = pool.pick();
  try {
    const body: Record<string, unknown> = { prompt: opts.prompt };
    if (opts.model) body.model = opts.model;
    if (opts.aspectRatio) body.aspectRatio = opts.aspectRatio;
    if (opts.resolution) body.resolution = opts.resolution;
    if (opts.imageUrls?.length) body.imageUrls = opts.imageUrls;

    const resp = await postJsonWithKey<JobCreatedResponse | MultiJobCreatedResponse>(
      "/images/generate",
      body,
      key
    );
    const created = "jobs" in resp ? resp.jobs[0] : resp;
    jobKeyMap.set(created.id, key);
    if (typeof created.queuePosition === "number") jobQueuePos.set(created.id, created.queuePosition);
    return created.id;
  } catch (e) {
    pool.release(key);
    throw e;
  }
}

// ── Videos ──────────────────────────────────────────────────────────────────

/**
 * Video: create a job. Supports:
 *  - text-to-video (prompt only)
 *  - image-to-video via imageJobId (reuses a previous /images/generate job)
 *  - image-to-video via imageUrls (external URLs)
 *
 * Critical: when imageJobId is provided, the video job MUST be created using
 * the same API key that created the image job. Otherwise 69labs returns 403
 * (the image belongs to a different account).
 */
export async function createVideoJob(opts: {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  duration?: string;
  imageJobId?: string;
  imageUrls?: string[];
  mute?: boolean;
  /** Optional — enables rate-limit (429) wait logging into the run log. */
  runId?: string;
}): Promise<string> {
  if (opts.runId) checkCancelled(opts.runId); // never start a new billable 69labs job for a cancelled run
  // Pick a key — but if we're chaining off an existing image job, reuse its key
  let key: string;
  if (opts.imageJobId && jobKeyMap.has(opts.imageJobId)) {
    key = jobKeyMap.get(opts.imageJobId)!;
    pool.acquireSpecific(key);
  } else {
    key = pool.pick();
  }
  const ctx = opts.runId ? { runId: opts.runId, stage: "animate" } : undefined;

  try {
    const body: Record<string, unknown> = { prompt: opts.prompt };
    if (opts.model) body.model = opts.model;
    if (opts.aspectRatio) body.aspectRatio = opts.aspectRatio;
    if (opts.duration) body.duration = opts.duration;
    body.mute = opts.mute ?? true;
    if (opts.imageJobId) body.imageJobId = opts.imageJobId;
    else if (opts.imageUrls && opts.imageUrls.length) body.imageUrls = opts.imageUrls;

    const resp = await postJsonWithKey<JobCreatedResponse | MultiJobCreatedResponse>(
      "/videos/generate",
      body,
      key,
      ctx
    );
    const created = "jobs" in resp ? resp.jobs[0] : resp;
    jobKeyMap.set(created.id, key);
    if (typeof created.queuePosition === "number") jobQueuePos.set(created.id, created.queuePosition);
    return created.id;
  } catch (e) {
    pool.release(key);
    throw e;
  }
}

// ── Polling / download / cancel ─────────────────────────────────────────────

/**
 * Polls a job until COMPLETED, or throws. Uses the key that created the job.
 *
 * Phase-aware (see the *_MAX_MS constants): a queued job that never starts is given up on fast
 * (QUEUE_MAX_MS), an actively rendering one is allowed the generous RENDER_MAX_MS, and either is
 * abandoned if it goes silent for STALL_MAX_MS with a live progress signal. A concise heartbeat
 * (~every HEARTBEAT_MS, plus on every phase change) keeps the run log alive instead of going
 * quiet for minutes.
 *
 * ALL give-up conditions throw an error whose message contains "polling timeout", because the
 * callers (image-gen / img2vid) already react to that by cancelling the job and retrying — so
 * the existing create → poll → cancel → retry flow, retry counts, and billing are UNCHANGED.
 * Only the *decision to give up* got smarter (and earlier for dead/queued jobs).
 */
export async function pollJob(
  kind: JobKind,
  jobId: string,
  runId: string,
  stage: string,
  level: LogLevel = "info"
): Promise<void> {
  const key = keyFor(jobId);
  const shortId = jobId.slice(0, 8);
  const queuePosAtCreate = jobQueuePos.get(jobId);
  const start = Date.now();
  let renderStart: number | null = null; // when the job first entered PROCESSING/FINALIZING
  let lastChange = start; // last time status/progress actually moved (for stall detection)
  let lastSnapshot = "";
  let lastBeat = start; // last heartbeat emit
  const secs = (ms: number) => Math.round(ms / 1000);

  /**
   * Emit the final lifecycle line for a give-up, then throw the error the CALLER keys off.
   * `outcome` is the human summary (e.g. "queue timeout after 120s"); `errMsg` MUST keep the
   * "polling timeout" wording so create → poll → cancel → retry stays wired exactly as before.
   */
  const giveUp = (outcome: string, errMsg: string): never => {
    if (level !== "debug") log(runId, level, `69labs ${kind} ${shortId} ${outcome}`, { stage });
    throw new Error(errMsg);
  };

  while (true) {
    checkCancelled(runId); // stop polling a cancelled run (the job is abandoned)
    // Free + idempotent poll → retryOnTimeout:true (re-asking a dead socket is the rescue).
    // retryStatus:false so the 429 back-off just below stays in charge of throttle handling.
    const r = await requestWithPolicy(
      `${BASE}/${kind}/status/${jobId}`,
      { headers: authHeadersFor(key) },
      `69labs status ${kind}/${jobId}`,
      { timeoutMs: STATUS_TIMEOUT_MS, retryOnTimeout: true, retryStatus: false }
    );
    if (!r.ok) {
      // A 429 on the status endpoint is transient — back off and keep polling
      // rather than failing the job.
      if (r.status === 429) {
        await sleep(POLL_INTERVAL_MS * 4);
        continue;
      }
      throw new Error(`69labs status ${kind}/${jobId} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const json = (await r.json()) as {
      status: JobStatus;
      progressPercent?: number | null;
      startedAt?: string | null;
      userMessage?: string | null;
    };
    const status = json.status;
    const progress = typeof json.progressPercent === "number" ? json.progressPercent : null;
    const now = Date.now();
    const elapsed = now - start;

    if (status === "COMPLETED") {
      // Final lifecycle line — the happy terminal.
      if (level !== "debug") log(runId, level, `69labs ${kind} ${shortId} completed in ${secs(elapsed)}s`, { stage });
      return;
    }
    if (status === "FAILED" || status === "CANCELLED" || status === "CENSORED") {
      // Final lifecycle line — 69labs itself ended the job (not a timeout of ours).
      if (level !== "debug") {
        log(runId, level, `69labs ${kind} ${shortId} ${status.toLowerCase()} after ${secs(elapsed)}s${json.userMessage ? ` — ${json.userMessage}` : ""}`, { stage });
      }
      throw new Error(`69labs ${kind} job ${jobId} ${status}${json.userMessage ? `: ${json.userMessage}` : ""}`);
    }

    const isQueued = status === "PENDING";
    const isRendering = status === "PROCESSING" || status === "FINALIZING";
    if (isRendering && renderStart === null) renderStart = now;

    // Track real movement: any status change, or a change in reported progress.
    const snapshot = `${status}|${progress ?? ""}`;
    const changed = snapshot !== lastSnapshot;
    if (changed) {
      lastSnapshot = snapshot;
      lastChange = now;
    }

    // Heartbeat — on a phase change or every HEARTBEAT_MS. Concise, one line, and it names the
    // PHASE explicitly (QUEUED vs PROCESSING) so a glance at the log shows whether the time went to
    // queue congestion or real rendering. The job id keeps concurrent renders distinguishable.
    if (level !== "debug" && (changed || now - lastBeat >= HEARTBEAT_MS)) {
      let detail = "";
      if (isQueued && queuePosAtCreate != null && queuePosAtCreate > 0) detail = ` (queue position ${queuePosAtCreate})`;
      else if (isRendering && progress != null) detail = ` (${Math.round(progress)}%)`;
      log(runId, level, `69labs ${kind} ${shortId} phase ${phaseOf(status)} elapsed ${secs(elapsed)}s${detail}`, { stage });
      lastBeat = now;
    }

    // ── Give-up decisions (all worded "…polling timeout…" so the caller cancels + retries) ──
    if (isQueued && elapsed > QUEUE_MAX_MS) {
      // "(phase QUEUED)" not "(never left queue)": a job can bounce PROCESSING→PENDING and be
      // caught here on total elapsed — observed live — so don't claim it never rendered.
      giveUp(
        `queue timeout after ${secs(elapsed)}s (phase ${phaseOf(status)})`,
        `69labs ${kind} job ${jobId} queue polling timeout after ${secs(QUEUE_MAX_MS)}s (never left ${status})`
      );
    }
    if (renderStart !== null && now - renderStart > RENDER_MAX_MS) {
      giveUp(
        `render timeout after ${secs(now - renderStart)}s (phase ${phaseOf(status)})`,
        `69labs ${kind} job ${jobId} render polling timeout after ${secs(RENDER_MAX_MS)}s (status ${status})`
      );
    }
    // Stall only when we HAVE a progress signal to judge by — a static PROCESSING with no progress
    // reporting is normal for a slow render and must NOT be killed early (RENDER_MAX_MS backstops it).
    if (progress !== null && now - lastChange > STALL_MAX_MS) {
      giveUp(
        `stalled in ${phaseOf(status)} — no progress for ${secs(STALL_MAX_MS)}s (stuck at ${Math.round(progress)}%)`,
        `69labs ${kind} job ${jobId} stalled polling timeout — no progress for ${secs(STALL_MAX_MS)}s (status ${status}, progress ${Math.round(progress)}%)`
      );
    }
    if (elapsed > POLL_HARD_MAX_MS) {
      giveUp(
        `timed out after ${secs(elapsed)}s (phase ${phaseOf(status)})`,
        `69labs ${kind} job ${jobId} exceeded ${secs(POLL_HARD_MAX_MS)}s polling timeout`
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/** Best-effort job cancellation. Releases the key slot. */
export async function cancelJob(kind: JobKind, jobId: string): Promise<boolean> {
  const key = keyFor(jobId);
  try {
    // Best-effort + idempotent → bounded so a dead socket can't hang the cleanup path that
    // frees a concurrency slot. Any error (incl. timeout) falls to the catch → returns false.
    const r = await requestWithPolicy(
      `${BASE}/${kind}/cancel/${jobId}`,
      { method: "POST", headers: { Authorization: `Bearer ${key}` } },
      `69labs cancel ${kind}/${jobId}`,
      { timeoutMs: CANCEL_TIMEOUT_MS, retryOnTimeout: true, retryStatus: false }
    );
    return r.ok;
  } catch {
    return false;
  } finally {
    releaseJob(jobId);
  }
}

/** Downloads a completed job's output. Releases the key slot. */
export async function downloadJob(kind: JobKind, jobId: string, outPath: string): Promise<void> {
  const key = keyFor(jobId);
  try {
    // Idempotent media fetch → retryOnTimeout:true, generous ceiling (a completed clip on a
    // CDN legitimately takes a while; only a truly dead socket stays silent for 5 min).
    const r = await requestWithPolicy(
      `${BASE}/${kind}/download/${jobId}`,
      { headers: { Authorization: `Bearer ${key}` }, redirect: "follow" },
      `69labs download ${kind}/${jobId}`,
      { timeoutMs: DOWNLOAD_TIMEOUT_MS, retryOnTimeout: true, retryStatus: false }
    );
    if (!r.ok) {
      throw new Error(`69labs download ${kind}/${jobId} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(outPath, buf);
  } finally {
    releaseJob(jobId);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

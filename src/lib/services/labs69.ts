import fs from "node:fs";
import { getSetting } from "../settings";
import { log, type LogLevel } from "../logger";
import { checkCancelled } from "../cancellation";

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
// nano-banana-pro 2K can legitimately take 4–5 min. 8 min is enough headroom
// without keeping zombie polls alive forever.
const POLL_MAX_MS = 8 * 60 * 1000;

type JobKind = "tts" | "images" | "videos";
type JobStatus = "PENDING" | "PROCESSING" | "FINALIZING" | "COMPLETED" | "FAILED" | "CANCELLED" | "CENSORED";

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

/** Release a job's slot manually (used in caller error/cleanup paths). */
export function releaseJob(jobId: string) {
  const key = jobKeyMap.get(jobId);
  if (key) {
    pool.release(key);
    jobKeyMap.delete(jobId);
  }
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
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: authHeadersFor(key),
      body: JSON.stringify(body),
    });
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
    const id = "jobs" in resp ? resp.jobs[0].id : resp.id;
    jobKeyMap.set(id, key);
    return id;
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
    const id = "jobs" in resp ? resp.jobs[0].id : resp.id;
    jobKeyMap.set(id, key);
    return id;
  } catch (e) {
    pool.release(key);
    throw e;
  }
}

// ── Polling / download / cancel ─────────────────────────────────────────────

/** Polls a job until COMPLETED or FAILED. Uses the key that created the job. */
export async function pollJob(
  kind: JobKind,
  jobId: string,
  runId: string,
  stage: string,
  level: LogLevel = "debug"
): Promise<void> {
  const key = keyFor(jobId);
  const start = Date.now();
  while (true) {
    checkCancelled(runId); // stop polling a cancelled run (the job is abandoned)
    const r = await fetch(`${BASE}/${kind}/status/${jobId}`, { headers: authHeadersFor(key) });
    if (!r.ok) {
      // A 429 on the status endpoint is transient — back off and keep polling
      // rather than failing the job.
      if (r.status === 429) {
        await sleep(POLL_INTERVAL_MS * 4);
        continue;
      }
      throw new Error(`69labs status ${kind}/${jobId} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const json = (await r.json()) as { status: JobStatus; userMessage?: string | null };
    if (level !== "debug") {
      log(runId, level, `${kind} ${jobId.slice(0, 8)} → ${json.status}`, { stage });
    }
    if (json.status === "COMPLETED") return;
    if (json.status === "FAILED" || json.status === "CANCELLED" || json.status === "CENSORED") {
      throw new Error(
        `69labs ${kind} job ${jobId} ${json.status}${json.userMessage ? `: ${json.userMessage}` : ""}`
      );
    }
    if (Date.now() - start > POLL_MAX_MS) {
      throw new Error(`69labs ${kind} job ${jobId} exceeded ${POLL_MAX_MS / 1000}s polling timeout`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Best-effort job cancellation. Releases the key slot. */
export async function cancelJob(kind: JobKind, jobId: string): Promise<boolean> {
  const key = keyFor(jobId);
  try {
    const r = await fetch(`${BASE}/${kind}/cancel/${jobId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    });
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
    const r = await fetch(`${BASE}/${kind}/download/${jobId}`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "follow",
    });
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

import fs from "node:fs";
import { getSetting } from "../settings";
import { defaultAiModel } from "../providers";
import { checkCancelled } from "../cancellation";
import { pLimit } from "../plimit";
import { log } from "../logger";

/**
 * Higgsfield AI provider — text→image (Soul + third-party image models) and
 * text/image→video (DoP + Kling / Seedance …). One more AI b-roll backend
 * alongside kie.ai / 69labs / Magnific / Runware; it never replaces them.
 *
 * API shape (confirmed against docs.higgsfield.ai, 2026):
 *  - Base URL `https://platform.higgsfield.ai`; auth header
 *    `Authorization: Key {id}:{secret}` (a two-part key — NOT Bearer, NOT x-api-key).
 *  - Async pattern: `POST /{model_slug}` → `{ request_id, status_url, cancel_url }`;
 *    poll `GET /requests/{request_id}/status` → `{ status, images:[{url}] | video:{url} }`
 *    until `status:"completed"`. Terminal statuses: completed | failed | nsfw | cancelled
 *    (the last three are FAILURE paths); queued / in_progress keep polling.
 *  - The model slug namespaces by engine (`higgsfield-ai/soul/standard`,
 *    `higgsfield-ai/dop/standard`, `kling-video/...`), so one endpoint fronts every model.
 *  - Result asset URLs live ~7 days, so we download immediately (as with HeyGen/kie/Magnific).
 *
 * Resilience mirrors magnific.ts: a process-wide FIFO concurrency limiter, a per-request
 * hard timeout, and a retry loop that backs off on TRANSIENT failures (429 / 5xx / timeout /
 * network) and fails fast on PERMANENT ones (400 / 401 / 403 / 404). A failed / nsfw /
 * cancelled task is surfaced as an error so the caller's regen loop (acquireAi) can retry
 * or fall through — exactly like a Magnific/kie failure.
 */

const BASE = "https://platform.higgsfield.ai";
const REQUEST_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The two-part API key (id + secret). Both halves are required. */
function higgsfieldCreds(): { id: string; secret: string } {
  const id = (getSetting("HIGGSFIELD_API_KEY") || "").trim();
  const secret = (getSetting("HIGGSFIELD_API_SECRET") || "").trim();
  if (!id) throw new Error("HIGGSFIELD_API_KEY is not set — paste it in /settings.");
  if (!secret) throw new Error("HIGGSFIELD_API_SECRET is not set — paste it in /settings.");
  return { id, secret };
}

/** True when Higgsfield is switched on AND has both key halves — the gate for using it. */
export function higgsfieldConfigured(): boolean {
  return (
    getSetting("HIGGSFIELD_ENABLED") !== "0" &&
    (getSetting("HIGGSFIELD_API_KEY") || "").trim() !== "" &&
    (getSetting("HIGGSFIELD_API_SECRET") || "").trim() !== ""
  );
}

// ── Process-wide concurrency limiter (mirrors magnificLimiter) ───────────────
// Shared across every simultaneous run so several videos don't blow past the
// account's concurrent-job cap. Memoized; rebuilt only when the setting changes.
let _limiter: ReturnType<typeof pLimit> | null = null;
let _limiterN = 0;
function higgsfieldLimiter() {
  const n = Math.max(1, Math.min(15, Number(getSetting("HIGGSFIELD_CONCURRENCY") || "2") || 2));
  if (!_limiter || _limiterN !== n) {
    _limiter = pLimit(n);
    _limiterN = n;
  }
  return _limiter;
}

/**
 * Transient (worth a backoff+retry) vs permanent (fail fast). Our HTTP errors are
 * thrown as `Higgsfield <status> (<label>): <body>`, so the status right after the
 * name is the signal (the label can contain digits, so it must NOT be parsed).
 */
export function isTransientHiggsfieldError(message: string): boolean {
  const status = Number(message.match(/\bHiggsfield (\d{3})\b/)?.[1] ?? 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (status >= 400 && status < 500) return false; // 400/401/403/404 — retrying can't help
  // Non-HTTP failures: aborts/timeouts and transport drops are worth a retry.
  return /\btimeout\b|fetch failed|ECONNRESET|ETIMEDOUT|network|socket hang up|EAI_AGAIN/i.test(message);
}

/** `Authorization: Key {id}:{secret}` — the custom two-part scheme Higgsfield uses. */
function authHeaders(json: boolean): Record<string, string> {
  const { id, secret } = higgsfieldCreds();
  const h: Record<string, string> = { Authorization: `Key ${id}:${secret}`, Accept: "application/json" };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/**
 * One HTTP call bounded by the concurrency limiter + a hard AbortController timeout,
 * retried on transient failures with exponential backoff (jittered). Permanent failures
 * throw immediately. Covers both the POST (submit) and every poll GET, so a transient
 * blip mid-poll doesn't kill an in-flight generation.
 */
async function higgsfieldFetch(runId: string, pathName: string, init: RequestInit, label: string): Promise<string> {
  const retries = Math.max(0, Math.min(8, Number(getSetting("HIGGSFIELD_RETRIES") || "3") || 3));
  const limiter = higgsfieldLimiter();
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await limiter(async () => {
        const ctrl = new AbortController();
        const tt = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        let r: Response;
        try {
          r = await fetch(`${BASE}${pathName}`, { ...init, signal: ctrl.signal });
        } catch (e) {
          throw e instanceof Error && e.name === "AbortError"
            ? new Error(`Higgsfield timeout after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s (${label})`)
            : new Error(`Higgsfield network error (${label}): ${(e as Error).message}`);
        } finally {
          clearTimeout(tt);
        }
        const text = await r.text();
        if (!r.ok) throw new Error(`Higgsfield ${r.status} (${label}): ${text.slice(0, 250)}`);
        return text;
      });
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt < retries && isTransientHiggsfieldError(lastErr)) {
        const backoff = 2000 * 2 ** attempt + Math.floor(Math.random() * 400);
        log(runId, "warn", `Higgsfield ${label} transient error (${lastErr.slice(0, 90)}) — retry ${attempt + 1}/${retries} in ${(backoff / 1000).toFixed(1)}s`, { stage: "visual" });
        await sleep(backoff);
        continue;
      }
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr || `Higgsfield ${label} failed`);
}

function parseHiggsfield<T>(label: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Higgsfield ${label}: non-JSON response: ${text.slice(0, 200)}`);
  }
}

async function higgsfieldPost<T>(runId: string, pathName: string, body: unknown, label: string): Promise<T> {
  const text = await higgsfieldFetch(
    runId,
    pathName,
    { method: "POST", headers: authHeaders(true), body: JSON.stringify(body) },
    label
  );
  return parseHiggsfield<T>(label, text);
}

async function higgsfieldGet<T>(runId: string, pathName: string, label: string): Promise<T> {
  const text = await higgsfieldFetch(runId, pathName, { headers: authHeaders(false) }, label);
  return parseHiggsfield<T>(label, text);
}

interface CreateResp {
  request_id?: string;
  id?: string;
}

interface StatusResp {
  status?: string;
  images?: { url?: string }[];
  video?: { url?: string };
  error?: string;
}

/**
 * Find the first result URL in a completed job. Higgsfield splits results by media —
 * `images:[{url}]` for image jobs, `video:{url}` for video jobs — so we check both and
 * return whichever is present (documented shapes only).
 */
export function extractHiggsfieldUrl(rec: StatusResp): string | null {
  const img = rec.images?.find((x) => typeof x?.url === "string" && /^https?:\/\//.test(x.url!))?.url;
  if (img) return img;
  const vid = rec.video?.url;
  return typeof vid === "string" && /^https?:\/\//.test(vid) ? vid : null;
}

/**
 * Classify a poll status. `done` = terminal success; `fail` = terminal failure
 * (failed / nsfw / cancelled — all treated as a failed generation the caller falls
 * through on); `pending` = keep polling (queued / in_progress / anything unknown).
 */
export function higgsfieldTerminal(status: string): "done" | "fail" | "pending" {
  const s = (status || "").toLowerCase();
  if (s === "completed") return "done";
  if (s === "failed" || s === "nsfw" || s === "cancelled" || s === "canceled") return "fail";
  return "pending";
}

/** POST an async job, then poll until completed and return the first result URL. */
async function runHiggsfieldTask(
  runId: string,
  modelSlug: string,
  body: unknown,
  opts: { label: string; deadlineMs: number }
): Promise<string> {
  if (runId) checkCancelled(runId); // never start a new billable Higgsfield job for a cancelled run
  const created = await higgsfieldPost<CreateResp>(runId, `/${modelSlug}`, body, opts.label);
  const reqId = created.request_id ?? created.id;
  if (!reqId) throw new Error(`Higgsfield ${opts.label} returned no request_id: ${JSON.stringify(created).slice(0, 200)}`);

  const DEADLINE = Date.now() + opts.deadlineMs;
  let delay = 4000;
  while (Date.now() < DEADLINE) {
    if (runId) checkCancelled(runId);
    await sleep(delay);
    delay = Math.min(delay + 1500, 12000);
    const rec = await higgsfieldGet<StatusResp>(runId, `/requests/${encodeURIComponent(reqId)}/status`, opts.label);
    const verdict = higgsfieldTerminal(String(rec.status || ""));
    if (verdict === "done") {
      const url = extractHiggsfieldUrl(rec);
      if (url) return url;
      throw new Error(`Higgsfield ${opts.label} completed but returned no result URL`);
    }
    if (verdict === "fail") {
      throw new Error(`Higgsfield ${opts.label} task ${String(rec.status).toLowerCase()}${rec.error ? `: ${rec.error}` : ""}`);
    }
  }
  throw new Error(`Higgsfield ${opts.label} timed out`);
}

/** Map the pipeline's "16:9"/"9:16"/"1:1" to Higgsfield's aspect_ratio value. */
function toHiggsfieldAspect(ratio: string): string {
  if (ratio === "9:16") return "9:16";
  if (ratio === "1:1") return "1:1";
  return "16:9";
}

// ── Text→image (Soul / third-party image models) ─────────────────────────────

/** Generate one image from a text prompt. Returns the image URL. */
export async function generateHiggsfieldImageUrl(runId: string, prompt: string, aspectRatio = "16:9"): Promise<string> {
  const model = getSetting("HIGGSFIELD_IMAGE_MODEL") || defaultAiModel("higgsfield", "image");
  const resolution = getSetting("HIGGSFIELD_RESOLUTION") || "1080p";
  return runHiggsfieldTask(
    runId,
    model,
    {
      prompt: prompt.slice(0, 5000),
      aspect_ratio: toHiggsfieldAspect(aspectRatio),
      resolution,
    },
    { label: `image:${model}`, deadlineMs: 5 * 60 * 1000 }
  );
}

// ── Text/image→video (DoP / Kling / Seedance …) ──────────────────────────────

/**
 * Generate a video from a text prompt. With `firstFrameUrl` (a hosted https URL) it's
 * image→video; without it, text→video. The b-roll pipeline generates from text, so it
 * calls this with no first frame. Returns the video URL.
 */
export async function generateHiggsfieldVideoUrl(
  runId: string,
  prompt: string,
  aspectRatio = "16:9",
  durationSec = 6,
  firstFrameUrl?: string
): Promise<string> {
  const model = getSetting("HIGGSFIELD_VIDEO_MODEL") || defaultAiModel("higgsfield", "video");
  const body: Record<string, unknown> = {
    prompt: prompt.slice(0, 2000),
    aspect_ratio: toHiggsfieldAspect(aspectRatio),
    duration: Math.max(1, Math.round(durationSec)),
  };
  // Only a hosted URL is accepted as a keyframe; a local path can't be sent here.
  if (firstFrameUrl && /^https?:\/\//.test(firstFrameUrl)) body.image_url = firstFrameUrl;
  return runHiggsfieldTask(runId, model, body, { label: `video:${model}`, deadlineMs: 12 * 60 * 1000 });
}

/** Download a Higgsfield result URL to disk. */
export async function downloadHiggsfield(url: string, outPath: string): Promise<void> {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`Higgsfield download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("Higgsfield download empty");
  fs.writeFileSync(outPath, buf);
}

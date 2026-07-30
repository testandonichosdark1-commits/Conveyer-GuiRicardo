import fs from "node:fs";
import { getSetting } from "../settings";
import { checkCancelled } from "../cancellation";
import { pLimit } from "../plimit";
import { log } from "../logger";

/**
 * Magnific AI provider — text→image + image→image (Mystic) and
 * image/text→video (MiniMax Hailuo 02 1080p). One more AI b-roll backend
 * alongside kie.ai and 69labs; it never replaces them.
 *
 * API shape (confirmed against docs.magnific.com, 2026-07):
 *  - Base URL `https://api.magnific.com`; auth header `x-magnific-api-key`.
 *  - Async pattern: `POST /v1/ai/<model>` → `{ data:{ task_id, status } }`;
 *    poll `GET /v1/ai/<model>/{task_id}` → `{ data:{ status, generated:[urls] } }`
 *    until `status:"COMPLETED"` (status ∈ CREATED | IN_PROGRESS | COMPLETED | FAILED).
 *  - Mystic (`/v1/ai/mystic`): ultra-realistic image gen; `structure_reference`
 *    (base64) turns it into image→image.
 *  - Hailuo 02 1080p (`/v1/ai/image-to-video/minimax-hailuo-02-1080p`): supports
 *    text→video (prompt only) and image→video (`first_frame_image`, URL or base64);
 *    1080p renders a fixed 6-second clip.
 *
 * Resilience mirrors gemini-models.ts / elevenlabs-voiceover.ts: a process-wide
 * FIFO concurrency limiter, per-request hard timeout, and a retry loop that backs
 * off on TRANSIENT failures (429 / 5xx / timeout / network) and fails fast on
 * PERMANENT ones (400 bad request, 401/403 auth, 404). A FAILED generation task is
 * surfaced as an error so the caller's regen loop (acquireAi) can retry — exactly
 * like kie's nano-banana/Veo failures.
 */

const BASE = "https://api.magnific.com";
const REQUEST_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function magnificKey(): string {
  const k = getSetting("MAGNIFIC_API_KEY");
  if (!k) throw new Error("MAGNIFIC_API_KEY is not set — paste it in /parametres.");
  return k;
}

/** True when Magnific is switched on AND has an API key — the gate for using it. */
export function magnificConfigured(): boolean {
  return getSetting("MAGNIFIC_ENABLED") !== "0" && (getSetting("MAGNIFIC_API_KEY") || "").trim() !== "";
}

// ── Process-wide concurrency limiter (mirrors elevenlabsLimiter) ─────────────
// Shared across every simultaneous run so several videos don't blow past the
// account's concurrent-job cap. Memoized; rebuilt only when the setting changes.
let _limiter: ReturnType<typeof pLimit> | null = null;
let _limiterN = 0;
function magnificLimiter() {
  const n = Math.max(1, Math.min(15, Number(getSetting("MAGNIFIC_CONCURRENCY") || "2") || 2));
  if (!_limiter || _limiterN !== n) {
    _limiter = pLimit(n);
    _limiterN = n;
  }
  return _limiter;
}

/**
 * Transient (worth a backoff+retry) vs permanent (fail fast). Our HTTP errors are
 * thrown as `Magnific <status> (<label>): <body>`, so the status right after the
 * name is the signal (the label can contain digits, so it must NOT be parsed).
 */
export function isTransientMagnificError(message: string): boolean {
  const status = Number(message.match(/\bMagnific (\d{3})\b/)?.[1] ?? 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (status >= 400 && status < 500) return false; // 400/401/403/404 — retrying can't help
  // Non-HTTP failures: aborts/timeouts and transport drops are worth a retry.
  return /\btimeout\b|fetch failed|ECONNRESET|ETIMEDOUT|network|socket hang up|EAI_AGAIN/i.test(message);
}

/**
 * One HTTP call bounded by the concurrency limiter + a hard AbortController
 * timeout, retried on transient failures with exponential backoff (jittered).
 * Permanent failures throw immediately. Covers both the POST (submit) and every
 * poll GET, so a transient blip mid-poll doesn't kill an in-flight generation.
 */
async function magnificFetch(runId: string, pathName: string, init: RequestInit, label: string): Promise<string> {
  const retries = Math.max(0, Math.min(8, Number(getSetting("MAGNIFIC_RETRIES") || "3") || 3));
  const limiter = magnificLimiter();
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
            ? new Error(`Magnific timeout after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s (${label})`)
            : new Error(`Magnific network error (${label}): ${(e as Error).message}`);
        } finally {
          clearTimeout(tt);
        }
        const text = await r.text();
        if (!r.ok) throw new Error(`Magnific ${r.status} (${label}): ${text.slice(0, 250)}`);
        return text;
      });
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt < retries && isTransientMagnificError(lastErr)) {
        const backoff = 2000 * 2 ** attempt + Math.floor(Math.random() * 400);
        log(runId, "warn", `Magnific ${label} transient error (${lastErr.slice(0, 90)}) — retry ${attempt + 1}/${retries} in ${(backoff / 1000).toFixed(1)}s`, { stage: "visual" });
        await sleep(backoff);
        continue;
      }
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr || `Magnific ${label} failed`);
}

function parseMagnific<T>(label: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Magnific ${label}: non-JSON response: ${text.slice(0, 200)}`);
  }
}

async function magnificPost<T>(runId: string, pathName: string, body: unknown, label: string): Promise<T> {
  const text = await magnificFetch(
    runId,
    pathName,
    {
      method: "POST",
      headers: { "x-magnific-api-key": magnificKey(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    label
  );
  return parseMagnific<T>(label, text);
}

async function magnificGet<T>(runId: string, pathName: string, label: string): Promise<T> {
  const text = await magnificFetch(runId, pathName, { headers: { "x-magnific-api-key": magnificKey() } }, label);
  return parseMagnific<T>(label, text);
}

interface TaskResp {
  data?: {
    task_id?: string;
    status?: string;
    generated?: unknown;
  };
}

/**
 * Find the first result URL in a COMPLETED task payload. Magnific's async envelope
 * is uniform across models: results land in `data.generated` (an array of URL
 * strings) for images AND video — confirmed against the documented Mystic and
 * image-to-video task-status responses. We parse only that documented field.
 */
function extractResultUrl(data: TaskResp["data"]): string | null {
  const gen = data?.generated;
  if (!Array.isArray(gen)) return null;
  return (gen.find((x) => typeof x === "string" && /^https?:\/\//.test(x)) as string | undefined) ?? null;
}

/** POST an async job, then poll until COMPLETED and return the first result URL. */
async function runMagnificTask(
  runId: string,
  postPath: string,
  body: unknown,
  opts: { label: string; deadlineMs: number }
): Promise<string> {
  if (runId) checkCancelled(runId); // never start a new billable Magnific job for a cancelled run
  const created = await magnificPost<TaskResp>(runId, postPath, body, opts.label);
  const taskId = created.data?.task_id;
  if (!taskId) throw new Error(`Magnific ${opts.label} returned no task_id: ${JSON.stringify(created).slice(0, 200)}`);

  const DEADLINE = Date.now() + opts.deadlineMs;
  let delay = 4000;
  while (Date.now() < DEADLINE) {
    if (runId) checkCancelled(runId);
    await sleep(delay);
    delay = Math.min(delay + 1500, 12000);
    const rec = await magnificGet<TaskResp>(runId, `${postPath}/${encodeURIComponent(taskId)}`, opts.label);
    const status = String(rec.data?.status || "").toUpperCase();
    if (status === "COMPLETED") {
      const url = extractResultUrl(rec.data);
      if (url) return url;
      throw new Error(`Magnific ${opts.label} completed but returned no result URL`);
    }
    if (status === "FAILED") throw new Error(`Magnific ${opts.label} task failed`);
  }
  throw new Error(`Magnific ${opts.label} timed out`);
}

/** Map the pipeline's "16:9"/"9:16"/"1:1" to Magnific's aspect-ratio enum. */
function toMagnificAspect(ratio: string): string {
  if (ratio === "9:16") return "social_story_9_16";
  if (ratio === "1:1") return "square_1_1";
  return "widescreen_16_9";
}

// ── Text→image (Mystic) ──────────────────────────────────────────────────────

/** Generate one image from a text prompt via Mystic. Returns the image URL. */
export async function generateMagnificImageUrl(runId: string, prompt: string, aspectRatio = "16:9"): Promise<string> {
  const model = getSetting("MAGNIFIC_IMAGE_MODEL") || "realism";
  const resolution = getSetting("MAGNIFIC_RESOLUTION") || "2k";
  return runMagnificTask(
    runId,
    "/v1/ai/mystic",
    {
      prompt: prompt.slice(0, 5000),
      model,
      resolution,
      aspect_ratio: toMagnificAspect(aspectRatio),
      filter_nsfw: true,
    },
    { label: "mystic", deadlineMs: 5 * 60 * 1000 }
  );
}

// ── Image→image (Mystic structure_reference) ─────────────────────────────────

/**
 * Regenerate an image guided by an input image (image→image) via Mystic's
 * `structure_reference` (base64). Returns the new image URL. Not currently wired
 * into the b-roll pipeline (which generates from text), but exported so image
 * editing has a real, documented implementation.
 */
export async function editMagnificImageUrl(runId: string, prompt: string, inputImagePath: string, aspectRatio = "16:9"): Promise<string> {
  const model = getSetting("MAGNIFIC_IMAGE_MODEL") || "realism";
  const resolution = getSetting("MAGNIFIC_RESOLUTION") || "2k";
  const b64 = fs.readFileSync(inputImagePath).toString("base64");
  return runMagnificTask(
    runId,
    "/v1/ai/mystic",
    {
      prompt: prompt.slice(0, 5000),
      model,
      resolution,
      aspect_ratio: toMagnificAspect(aspectRatio),
      structure_reference: b64,
      structure_strength: 50,
      filter_nsfw: true,
    },
    { label: "mystic-edit", deadlineMs: 5 * 60 * 1000 }
  );
}

// ── Text/image→video (MiniMax Hailuo 02 1080p) ───────────────────────────────

/**
 * Generate a video via MiniMax Hailuo 02 1080p. With `firstFramePath` it's
 * image→video; without it, text→video. 1080p renders a fixed 6-second clip
 * (assemble trims each beat to its exact length). Returns the video URL.
 */
export async function generateMagnificVideoUrl(
  runId: string,
  prompt: string,
  _aspectRatio = "16:9",
  _durationSec = 6,
  firstFramePath?: string
): Promise<string> {
  const model = getSetting("MAGNIFIC_VIDEO_MODEL") || "minimax-hailuo-02-1080p";
  const body: Record<string, unknown> = {
    prompt: prompt.slice(0, 2000),
    duration: 6, // Hailuo 1080p only supports 6s (documented)
    prompt_optimizer: true,
  };
  if (firstFramePath) body.first_frame_image = fs.readFileSync(firstFramePath).toString("base64");
  return runMagnificTask(runId, `/v1/ai/image-to-video/${model}`, body, { label: model, deadlineMs: 12 * 60 * 1000 });
}

/** Download a Magnific result URL to disk. */
export async function downloadMagnific(url: string, outPath: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Magnific download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("Magnific download empty");
  fs.writeFileSync(outPath, buf);
}

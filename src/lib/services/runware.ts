import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { getSetting } from "../settings";
import { defaultAiModel } from "../providers";
import { checkCancelled } from "../cancellation";
import { pLimit } from "../plimit";
import { log } from "../logger";

/**
 * Runware provider — text→image via the unified inference API.
 *
 * EXPERIMENTAL: offered alongside kie.ai / 69labs / Magnific so an operator can
 * evaluate it on real runs. It never replaces them.
 *
 * API shape (confirmed against runware.ai/docs, 2026-07):
 *  - ONE endpoint for everything: `POST https://api.runware.ai/v1`, auth header
 *    `Authorization: Bearer <RUNWARE_API_KEY>`.
 *  - The body is an ARRAY of task objects discriminated by `taskType`
 *    (`imageInference` here). Each task carries a caller-generated `taskUUID`
 *    (UUID v4) that the response echoes back, so results can be matched.
 *  - Models are addressed by AIR id — `creator:model@version`, e.g.
 *    `runware:101@1` (FLUX.1 dev), `google:4@2` (Nano Banana Pro).
 *  - Success → `{ data: [ { taskUUID, imageUUID, imageURL, cost } ] }`.
 *    Failure → `{ errors: [ { code, message, parameter, taskUUID } ] }`.
 *  - `includeCost: true` returns the REAL billed USD for the task. That is why
 *    Runware is the only backend here whose cost ledger entry need not be an
 *    estimate — see `cost` on RunwareImage.
 *  - Delivery is synchronous by default: the POST returns the finished image, so
 *    there is no task/poll pair (unlike kie and Magnific).
 *
 * Resilience mirrors kie.ts / magnific.ts: a process-wide FIFO concurrency
 * limiter, a hard per-request timeout, and a retry loop that backs off on
 * TRANSIENT failures and fails fast on PERMANENT ones. The one rule taken from
 * kie.ts rather than magnific.ts is deliberate and load-bearing: OUR OWN timeout
 * is never retried — see `isOurAbort` below.
 */

const BASE = "https://api.runware.ai/v1";

/** Generation is synchronous, so this covers the whole render, not just a handshake.
 *  Runware treats sub-30s as healthy, so 180s can only fire on a genuinely dead
 *  socket — a DEAD-CONNECTION DETECTOR, not a performance limit. */
const REQUEST_TIMEOUT_MS = 180_000;

/** Result media rides a CDN and is already paid for, so it gets a looser ceiling. */
const DOWNLOAD_TIMEOUT_MS = 300_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runwareKey(): string {
  const k = getSetting("RUNWARE_API_KEY");
  if (!k) throw new Error("RUNWARE_API_KEY is not set — paste it in /parametres.");
  return k;
}

/** True when Runware has an API key — the gate for using it. */
export function runwareConfigured(): boolean {
  return (getSetting("RUNWARE_API_KEY") || "").trim() !== "";
}

// ── Process-wide concurrency limiter (mirrors magnificLimiter) ───────────────
// Shared across every simultaneous run so several videos don't saturate Runware's
// queues. Their docs recommend 2–4 concurrent requests and warn that hundreds of
// concurrent requests degrade into timeouts rather than clean 429s — so the client
// must self-limit. Memoized; rebuilt only when the setting changes.
let _limiter: ReturnType<typeof pLimit> | null = null;
let _limiterN = 0;
function runwareLimiter() {
  const n = Math.max(1, Math.min(15, Number(getSetting("RUNWARE_CONCURRENCY") || "3") || 3));
  if (!_limiter || _limiterN !== n) {
    _limiter = pLimit(n);
    _limiterN = n;
  }
  return _limiter;
}

/**
 * Transient (worth a backoff+retry) vs permanent (fail fast). Our HTTP errors are
 * thrown as `Runware <status> (<label>): <body>`, so the status right after the
 * name is the signal (the label can contain digits, so it must NOT be parsed).
 *
 * Runware documents 429 (queue capacity exceeded), 503 (temporary capacity) and
 * 504 (queue wait exceeded) as the capacity-pressure codes, all with exponential
 * backoff as the prescribed response.
 */
export function isTransientRunwareError(message: string): boolean {
  const status = Number(message.match(/\bRunware (\d{3})\b/)?.[1] ?? 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (status >= 400 && status < 500) return false; // 400/401/403/404 — retrying can't help
  // Non-HTTP failures: transport drops are worth a retry. Our own timeout is NOT
  // listed here on purpose — see isOurAbort.
  return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket hang up/i.test(message);
}

/**
 * Did WE hang up (our timeout ceiling, or a caller's cancellation)? Classified by
 * the structured `name` first, with the message as a fallback guard.
 *
 * This matters because Runware's imageInference POST is BILLABLE and SYNCHRONOUS:
 * an aborted request may well have reached Runware and generated (and charged for)
 * an image we simply never saw. Re-sending would generate a SECOND one and charge
 * twice — the bug already shipped and fixed in elevenlabs-voiceover.ts, and the
 * reason kie.ts marks createTask non-retryable. Losing one beat's image (it falls
 * back to stock/AI) is vastly cheaper than a double charge.
 */
function isOurAbort(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

// ── Dimensions ───────────────────────────────────────────────────────────────

/** Snap to the nearest multiple of 64 and clamp to Runware's documented 128–2048 band. */
function snap64(n: number): number {
  const snapped = Math.round(n / 64) * 64;
  return Math.max(128, Math.min(2048, snapped));
}

/**
 * The pixel size to generate for a run's output format ("1920x1080", "1080x1920", …).
 *
 * Runware takes explicit `width`/`height`, NOT an aspect-ratio string like kie
 * ("16:9") or 69labs ("landscape") — which is why this maps from the run's real
 * resolution instead of from `aiAspect()`. Both sides are snapped to a multiple of
 * 64 and clamped to 2048, the constraint Runware's API reference documents for
 * image inference. 1920x1080 → 1920x1088 (0.7% taller than 16:9, imperceptible
 * once Ken Burns re-frames it to the exact output size).
 *
 * Generating at the channel's own resolution — rather than a fixed 1024px tile —
 * keeps `format` threaded end-to-end the way every other stage already honors it,
 * and avoids handing Ken Burns a source it has to upscale.
 */
export function runwareSize(resolution?: string): { width: number; height: number } {
  const m = (resolution || "").match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  const w = m ? Number(m[1]) : 1920;
  const h = m ? Number(m[2]) : 1080;
  return { width: snap64(w), height: snap64(h) };
}

// ── Request / response types ─────────────────────────────────────────────────

interface RunwareErrorItem {
  code?: string;
  message?: string;
  parameter?: string | string[];
  taskUUID?: string;
  /** Present on `unsupportedDimensions`: aspect-ratio → "WxH" for every size the model takes. */
  allowedValues?: Record<string, string>;
}

/**
 * A rejection Runware described STRUCTURALLY, carrying the error item verbatim.
 *
 * The flattened message is what the retry loop and the logs use, but a constraint
 * error also tells us how to satisfy it (`allowedValues`), and that survives only if
 * the object does. The message keeps its exact previous shape so
 * `isTransientRunwareError` classifies it identically.
 */
class RunwareTaskError extends Error {
  readonly detail: RunwareErrorItem;
  constructor(message: string, detail: RunwareErrorItem) {
    super(message);
    this.name = "RunwareTaskError";
    this.detail = detail;
  }
}

interface RunwareImageItem {
  taskUUID?: string;
  imageUUID?: string;
  imageURL?: string;
  cost?: number;
}

interface RunwareEnvelope {
  data?: RunwareImageItem[];
  errors?: RunwareErrorItem[];
}

export interface RunwareImage {
  /** Signed CDN URL of the generated image (valid for the task's ttl, 7 days by default). */
  url: string;
  /**
   * REAL billed USD for this generation, as reported by `includeCost`, or null when
   * Runware did not report one. Not an estimate — the caller records it verbatim.
   */
  cost: number | null;
  /** The AIR id actually requested (echoed for logging / cost attribution). */
  model: string;
  width: number;
  height: number;
}

/**
 * Surface Runware's application-level errors. The documented failure envelope is
 * an `errors` array; we check it regardless of HTTP status so an error that arrives
 * with a 200 cannot masquerade as success (the trap kie.ts's parseKie exists for).
 */
function firstError(env: RunwareEnvelope): string | null {
  const e = env.errors?.[0];
  if (!e) return null;
  const param = Array.isArray(e.parameter) ? e.parameter.join("/") : e.parameter;
  return [e.code, e.message, param && `(parameter: ${param})`].filter(Boolean).join(" ") || "unknown error";
}

/** The structured error item inside a response body, when there is one. */
function errorItem(body: string): RunwareErrorItem | null {
  try {
    return (JSON.parse(body) as RunwareEnvelope).errors?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * One POST bounded by the concurrency limiter + a hard AbortController timeout,
 * retried on transient failures with jittered exponential backoff. Permanent
 * failures — and our own aborts — throw immediately.
 */
async function runwarePost(runId: string, tasks: unknown[], label: string): Promise<RunwareEnvelope> {
  const retries = Math.max(0, Math.min(8, Number(getSetting("RUNWARE_RETRIES") || "3") || 3));
  const limiter = runwareLimiter();
  const key = runwareKey();
  let lastErr = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await limiter(async () => {
        const ctrl = new AbortController();
        const tt = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        let r: Response;
        try {
          r = await fetch(BASE, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify(tasks),
            signal: ctrl.signal,
          });
        } catch (e) {
          // We hung up on a BILLABLE request — terminal, never retried.
          if (isOurAbort(e)) {
            throw new Error(
              `Runware ${label}: timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s — not retried ` +
                `(a retry could bill a second generation)`
            );
          }
          throw new Error(`Runware network error (${label}): ${(e as Error).message}`);
        } finally {
          clearTimeout(tt);
        }
        const body = await r.text();
        // The server answered and rejected → it definitely did not generate anything,
        // so this IS safe to re-send (isTransientRunwareError decides whether to).
        if (!r.ok) {
          const msg = `Runware ${r.status} (${label}): ${body.slice(0, 250)}`;
          const detail = errorItem(body);
          throw detail ? new RunwareTaskError(msg, detail) : new Error(msg);
        }
        return body;
      });

      let env: RunwareEnvelope;
      try {
        env = JSON.parse(text) as RunwareEnvelope;
      } catch {
        throw new Error(`Runware ${label}: non-JSON response: ${text.slice(0, 200)}`);
      }
      const err = firstError(env);
      if (err) throw new RunwareTaskError(`Runware ${label} rejected: ${err}`, env.errors![0]);
      return env;
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt < retries && isTransientRunwareError(lastErr)) {
        const backoff = 1000 * 2 ** attempt + Math.floor(Math.random() * 400);
        log(runId, "warn", `Runware ${label} transient error (${lastErr.slice(0, 90)}) — retry ${attempt + 1}/${retries} in ${(backoff / 1000).toFixed(1)}s`, {
          stage: "visual",
        });
        await sleep(backoff);
        continue;
      }
      // Rethrow the structured rejection as-is: same message, but `detail` survives so
      // a constraint error can be acted on. Anything else keeps the old normalization.
      throw e instanceof RunwareTaskError ? e : new Error(lastErr);
    }
  }
  throw new Error(lastErr || `Runware ${label} failed`);
}

// ── Per-model request constraints, learned from the API ──────────────────────
/**
 * Not every model accepts every field, and the differences are per-model rather than
 * per-provider. Two are confirmed live (2026-07-27):
 *
 *   - Nano Banana / Nano Banana Pro (`google:4@1`, `google:4@2`) take only a FIXED SET
 *     of sizes; our free-form 1920x1088 is `unsupportedDimensions`, a permanent 400.
 *   - Seedream 4.0 (`bytedance:5@0`) rejects `negativePrompt` outright —
 *     `unsupportedArchitectureNegativePrompt`, also a permanent 400.
 *
 * Both would silently cost the operator every beat that used those models. Rather than
 * hardcode a per-model capability table — which drifts the moment Runware adds a model,
 * and which we would have to guess at for models we have not probed — the constraint is
 * LEARNED from the rejection itself: Runware's error payload states exactly which sizes
 * are allowed, and which architecture refused the field. The same principle the avatar
 * code follows for HeyGen's `supported_api_engines`: follow the API, not a local guess.
 *
 * Re-sending after one of these is SAFE and cannot double-bill: the server rejected the
 * task before generating (`data: []`), which is the same reasoning that already lets
 * `runwarePost` retry a non-2xx. Only OUR OWN abort is unsafe to repeat.
 *
 * Memoized per process, so exactly one beat per model ever pays the corrective round
 * trip (~200 ms — Runware validates before queueing).
 */
interface ModelQuirks {
  /** "WxH" strings the model accepts, when it accepts only a fixed set. */
  dimensions?: string[];
  /** The model's architecture refuses `negativePrompt`. */
  noNegativePrompt?: boolean;
}
const modelQuirks = new Map<string, ModelQuirks>();

/** Every "WxH" Runware named as allowed — from the structured field, else the prose. */
function allowedDimensions(detail: RunwareErrorItem): string[] {
  const listed = detail.allowedValues && typeof detail.allowedValues === "object" ? Object.values(detail.allowedValues) : [];
  const src = listed.length ? listed.join(" ") : detail.message || "";
  return [...new Set(src.match(/\b\d{3,4}\s*x\s*\d{3,4}\b/g)?.map((s) => s.replace(/\s+/g, "")) ?? [])];
}

/**
 * The allowed size closest to what we wanted: nearest ASPECT first, then nearest AREA.
 *
 * Aspect dominates because Ken Burns rescales to the output size anyway but cannot undo
 * a wrong shape without cropping the subject out of frame; it is compared as a log
 * ratio so overshoot and undershoot are penalized evenly. Aspects within ASPECT_TOL of
 * the best count as EQUAL — 1344x768 (1.750) and 640x360 (1.778) are both within 1% of
 * a 1920x1088 frame, so letting the second win on a 0.1% edge and then upscaling it 3x
 * would trade an invisible difference for a visible one.
 *
 * Among the sizes sharing the best aspect: the SMALLEST that still covers the target,
 * else the LARGEST available. That is "big enough, and no bigger" — the same intent
 * `runwareSize` states, applied to a fixed menu:
 *   - never upscale when the model offers a size that avoids it (Ken Burns zooms IN,
 *     so a short source is visibly soft);
 *   - never pay for pixels the downscale throws away. Nano Banana Pro offers 16:9 at
 *     1376x768, 2752x1536 and 5504x3072 — the largest cost $0.244 and 49s for a
 *     16.9-megapixel image feeding a 2-megapixel video, the smallest upscales 1.4x,
 *     and 2752x1536 is the one that is simply right.
 */
export function pickAllowedSize(
  allowed: string[],
  want: { width: number; height: number }
): { width: number; height: number } | null {
  const targetAspect = want.width / want.height;
  type Cand = { width: number; height: number; aspect: number };
  const cands: Cand[] = [];
  for (const s of allowed) {
    const [w, h] = s.split(/x/i).map(Number);
    if (!w || !h) continue;
    cands.push({ width: w, height: h, aspect: Math.abs(Math.log(w / h / targetAspect)) });
  }
  if (!cands.length) return null;
  const ASPECT_TOL = 0.02; // ~2% — below the threshold of noticing, and Ken Burns re-frames
  const bestAspect = Math.min(...cands.map((c) => c.aspect));
  const shortlist = cands.filter((c) => c.aspect <= bestAspect + ASPECT_TOL);
  const area = (c: Cand) => c.width * c.height;
  const covering = shortlist.filter((c) => c.width >= want.width && c.height >= want.height);
  const chosen = covering.length
    ? covering.reduce((a, b) => (area(b) < area(a) ? b : a)) // smallest that avoids upscaling
    : shortlist.reduce((a, b) => (area(b) > area(a) ? b : a)); // none big enough — upscale least
  return { width: chosen.width, height: chosen.height };
}

/**
 * Record what a rejection taught us about this model. Returns a human description when
 * something NEW was learned (so the caller may re-send), or null when it was not a
 * constraint error — or was one we had already recorded, which guarantees termination.
 */
function learnQuirk(model: string, e: unknown): string | null {
  if (!(e instanceof RunwareTaskError)) return null;
  const q = modelQuirks.get(model) ?? {};
  if (e.detail.code === "unsupportedDimensions" && !q.dimensions?.length) {
    const dimensions = allowedDimensions(e.detail);
    if (!dimensions.length) return null; // nothing actionable — surface the original error
    modelQuirks.set(model, { ...q, dimensions });
    return `accepts only fixed sizes (${dimensions.join(", ")})`;
  }
  if (e.detail.code === "unsupportedArchitectureNegativePrompt" && !q.noNegativePrompt) {
    modelQuirks.set(model, { ...q, noNegativePrompt: true });
    return "does not support negativePrompt";
  }
  return null;
}

/**
 * Generate ONE image from a text prompt. Returns its URL plus the real billed cost.
 *
 * `negativePrompt` is a first-class field here (kie has nowhere to put one), so the
 * caller can move its "no text, no captions, no logos" ban list out of the positive
 * prompt where it belongs. `fallbackPrompt` is the caller's SAME prompt with those bans
 * left inline the legacy way — used only for a model that refuses a negative prompt, so
 * the bans still reach the model instead of being quietly dropped (an image full of
 * garbled captions is exactly what the ban list exists to prevent).
 */
export async function generateRunwareImage(
  runId: string,
  prompt: string,
  opts: { negativePrompt?: string; fallbackPrompt?: string; resolution?: string; model?: string } = {}
): Promise<RunwareImage> {
  const model = opts.model || getSetting("RUNWARE_IMAGE_MODEL") || defaultAiModel("runware", "image");
  const want = runwareSize(opts.resolution);
  if (runId) checkCancelled(runId); // never start a new billable Runware job for a cancelled run
  const negative = (opts.negativePrompt || "").trim();

  for (;;) {
    const quirks = modelQuirks.get(model) ?? {};
    const size = (quirks.dimensions?.length && pickAllowedSize(quirks.dimensions, want)) || want;
    // A model that refuses negativePrompt gets the legacy prompt, bans and all.
    const positive = quirks.noNegativePrompt && opts.fallbackPrompt ? opts.fallbackPrompt : prompt;

    const task: Record<string, unknown> = {
      taskType: "imageInference",
      taskUUID: randomUUID(),
      model,
      positivePrompt: positive.slice(0, 5000),
      width: size.width,
      height: size.height,
      numberResults: 1,
      outputType: "URL",
      outputFormat: "PNG",
      includeCost: true,
    };
    if (negative && !quirks.noNegativePrompt) task.negativePrompt = negative.slice(0, 5000);

    let env: RunwareEnvelope;
    try {
      env = await runwarePost(runId, [task], "imageInference");
    } catch (e) {
      const learned = learnQuirk(model, e);
      if (!learned) throw e;
      log(runId, "info", `Runware ${model} ${learned} — adjusting the request and re-sending (nothing was generated or billed)`, {
        stage: "visual",
      });
      continue;
    }

    const item = env.data?.find((d) => typeof d.imageURL === "string" && d.imageURL);
    if (!item?.imageURL) {
      throw new Error(`Runware imageInference returned no imageURL: ${JSON.stringify(env).slice(0, 200)}`);
    }
    return {
      url: item.imageURL,
      cost: typeof item.cost === "number" && Number.isFinite(item.cost) ? item.cost : null,
      model,
      width: size.width,
      height: size.height,
    };
  }
}

/**
 * Download a Runware result URL to disk. Bounded + freely retryable: the image is
 * already generated and paid for, so re-fetching its URL costs nothing and cannot
 * duplicate work — the same reasoning that makes a kie poll safe to retry.
 */
export async function downloadRunware(url: string, outPath: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`Runware download ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength === 0) throw new Error("Runware download empty");
      fs.writeFileSync(outPath, buf);
      return;
    } catch (e) {
      if (attempt >= 3) {
        throw isOurAbort(e)
          ? new Error(`Runware download: timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`)
          : (e as Error);
      }
      await sleep(2000 * attempt);
    }
  }
}

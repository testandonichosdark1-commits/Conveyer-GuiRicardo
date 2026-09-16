import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { defaultAiModel } from "../providers";
import { checkCancelled } from "../cancellation";
import { textWithPolicy, isOurAbort } from "./http";

/**
 * kie.ai provider — nano-banana (image) + Veo (video).
 *
 * Two API families with DIFFERENT shapes (confirmed in research):
 *  - Jobs/Market API (nano-banana): POST /api/v1/jobs/createTask → taskId;
 *    GET /api/v1/jobs/recordInfo → data.state + data.resultJson (a JSON STRING
 *    you must parse → resultUrls[0]).
 *  - Veo dedicated API: POST /api/v1/veo/generate → taskId;
 *    GET /api/v1/veo/record-info → data.successFlag (int) + data.response.resultUrls (array).
 * Auth: `Authorization: Bearer <KIE_API_KEY>`. See docs/DESIGN.md.
 */

const BASE = "https://api.kie.ai";

const FILE_UPLOAD_BASE = "https://kieai.redpandaai.co";

type ReferenceUploadCacheEntry = {
  url: string;
  expiresAtMs: number;
  mtimeMs: number;
  size: number;
};

// Kie upload URLs are temporary. Keep one warm URL per local reference image and
// refresh it well before the documented expiry. This avoids re-uploading the same
// portrait for every beat while still making app restarts self-healing.
const referenceUploadCache = new Map<string, ReferenceUploadCacheEntry>();

function imageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

interface FileUploadResp {
  success?: boolean;
  code?: number;
  msg?: string;
  data?: {
    fileUrl?: string;
    downloadUrl?: string;
    expiresAt?: string;
  };
}

/**
 * Upload a LOCAL reference portrait to Kie's temporary file service and return a
 * public URL suitable for Nano Banana Edit's `image_urls`. Uploading is free; the
 * generation task remains the only billable image call.
 */
export async function ensureKieReferenceUrl(filePath: string): Promise<string> {
  const abs = path.resolve(filePath);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error(`Character reference is not a file: ${abs}`);
  if (stat.size <= 0) throw new Error("Character reference image is empty");
  if (stat.size > 10 * 1024 * 1024) throw new Error("Character reference image exceeds Kie's 10 MB limit");

  const cached = referenceUploadCache.get(abs);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.expiresAtMs > Date.now() + 10 * 60 * 1000) {
    return cached.url;
  }

  const mime = imageMime(abs);
  const ext = path.extname(abs).toLowerCase() || (mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg");
  const dataUrl = `data:${mime};base64,${fs.readFileSync(abs).toString("base64")}`;
  const fileName = `character-reference-${Math.floor(stat.mtimeMs)}${ext}`;

  const text = await textWithPolicy(
    `${FILE_UPLOAD_BASE}/api/file-base64-upload`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${kieKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        base64Data: dataUrl,
        uploadPath: "conveyer/character-reference",
        fileName,
      }),
    },
    "kie.ai reference upload",
    // File uploads are free and overwrite the same deterministic filename, so a
    // timeout retry cannot create a second billable generation task.
    { timeoutMs: KIE_API_TIMEOUT_MS, retryOnTimeout: true }
  );

  let parsed: FileUploadResp;
  try {
    parsed = JSON.parse(text) as FileUploadResp;
  } catch {
    throw new Error(`kie.ai reference upload: non-JSON response: ${text.slice(0, 200)}`);
  }
  if (parsed.success === false || (typeof parsed.code === "number" && parsed.code !== 200)) {
    throw new Error(`kie.ai reference upload code ${parsed.code ?? "?"}: ${parsed.msg || text.slice(0, 200)}`);
  }
  const url = parsed.data?.fileUrl || parsed.data?.downloadUrl;
  if (!url) throw new Error(`kie.ai reference upload returned no file URL: ${text.slice(0, 200)}`);

  const documentedExpiry = parsed.data?.expiresAt ? Date.parse(parsed.data.expiresAt) : NaN;
  // Kie's docs describe the public URL as temporary (24h in the quickstart). Cache
  // for at most 20h even if a longer file-retention timestamp is returned.
  const expiresAtMs = Number.isFinite(documentedExpiry)
    ? Math.min(documentedExpiry, Date.now() + 20 * 60 * 60 * 1000)
    : Date.now() + 20 * 60 * 60 * 1000;
  referenceUploadCache.set(abs, { url, expiresAtMs, mtimeMs: stat.mtimeMs, size: stat.size });
  return url;
}

function kieKey(): string {
  const k = getSetting("KIE_API_KEY");
  if (!k) throw new Error("KIE_API_KEY is not set — paste it in /parametres.");
  return k;
}

/**
 * kie.ai returns application-level errors as HTTP 200 with a non-200 `code` in
 * the body (401 auth, 402 no credits, 422 validation, 429 rate limit, 500 …).
 * Surface those as real errors instead of letting them masquerade as success.
 */
function parseKie<T>(label: string, text: string): T {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`kie.ai ${label}: non-JSON response: ${text.slice(0, 200)}`);
  }
  const code = (j as { code?: number }).code;
  const msg = (j as { msg?: string }).msg;
  if (typeof code === "number" && code !== 200) {
    throw new Error(`kie.ai ${label} code ${code}: ${msg || text.slice(0, 200)}`);
  }
  return j as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── request resilience ───────────────────────────────────────────────────────
// The dead-socket detection + billable-vs-idempotent retry split now lives in the
// shared ./http helper (used by every provider). kie.ai just picks the right policy:
// createTask/generate are BILLABLE (our timeout must never re-send — double charge),
// recordInfo polls + result downloads are FREE + IDEMPOTENT (re-asking rescues a dead
// socket). See ./http.ts for the full rationale.

/** ~1000× headroom: a healthy poll returns in ~50ms and a healthy createTask in
 *  ~1–2s. At 60s this can only fire on a genuinely dead socket, never on
 *  healthy-but-slow traffic. A DEAD-CONNECTION DETECTOR, not a performance limit. */
const KIE_API_TIMEOUT_MS = 60_000;

/** Result media (a Veo 1080p mp4) is far bigger than an API JSON and rides a CDN,
 *  so it gets a much looser ceiling: minutes are legitimate on a slow line, and
 *  only a socket that is actually dead stays silent for 5 whole minutes. */
const KIE_DOWNLOAD_TIMEOUT_MS = 300_000;

export async function kiePost<T>(pathName: string, body: unknown): Promise<T> {
  const text = await textWithPolicy(
    `${BASE}${pathName}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${kieKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    `kie.ai ${pathName}`,
    // creates a billable task — our own timeout must never re-send it
    { timeoutMs: KIE_API_TIMEOUT_MS, retryOnTimeout: false }
  );
  return parseKie<T>(pathName, text);
}

export async function kieGet<T>(pathWithQuery: string): Promise<T> {
  const text = await textWithPolicy(
    `${BASE}${pathWithQuery}`,
    { headers: { Authorization: `Bearer ${kieKey()}` } },
    `kie.ai ${pathWithQuery}`,
    // free poll — hanging up and re-asking is the dead-socket rescue
    { timeoutMs: KIE_API_TIMEOUT_MS, retryOnTimeout: true }
  );
  return parseKie<T>(pathWithQuery, text);
}

function toBananaAspect(ratio: string): string {
  // Accept "16:9"/"9:16"/"1:1" etc.; default 16:9 for landscape documentary.
  return /^\d+:\d+$/.test(ratio) ? ratio : "16:9";
}

// ── nano-banana image (Jobs API) ─────────────────────────────────────────────

interface CreateTaskResp {
  code?: number;
  msg?: string;
  data?: { taskId?: string };
}
interface JobRecordResp {
  data?: {
    state?: string; // waiting | queuing | generating | success | fail
    resultJson?: string;
    failCode?: string;
    failMsg?: string;
    progress?: number;
  };
}

export interface GenerateImageOptions {
  /** Local portrait to use as an identity reference. When present, the request is
   * sent to Nano Banana Edit with `image_urls`; otherwise the legacy text-to-image
   * request is byte-for-byte equivalent in shape. */
  referenceImagePath?: string;
}

/** Generate one image via Nano Banana. With a reference image this switches to
 * Nano Banana Edit (image-to-image); without one it remains text-to-image. */
export async function generateImageUrl(
  runId: string,
  prompt: string,
  aspectRatio = "16:9",
  options: GenerateImageOptions = {}
): Promise<string> {
  if (runId) checkCancelled(runId); // never start a new billable kie job for a cancelled run

  const refPath = options.referenceImagePath?.trim();
  const referenceUrl = refPath ? await ensureKieReferenceUrl(refPath) : "";
  const model = referenceUrl
    ? (getSetting("KIE_IMAGE_EDIT_MODEL") || "google/nano-banana-edit")
    : (getSetting("KIE_IMAGE_MODEL") || defaultAiModel("kie", "image"));

  const input: Record<string, unknown> = {
    prompt: prompt.slice(0, 5000),
    output_format: "png",
    aspect_ratio: toBananaAspect(aspectRatio),
  };
  // The current Nano Banana Edit contract accepts image_urls and does not document
  // nsfw_checker, while the text-to-image contract does. Keep each shape faithful.
  if (referenceUrl) input.image_urls = [referenceUrl];
  else input.nsfw_checker = false;

  const created = await kiePost<CreateTaskResp>("/api/v1/jobs/createTask", { model, input });
  const taskId = created.data?.taskId;
  if (!taskId) throw new Error(`kie.ai createTask returned no taskId: ${JSON.stringify(created).slice(0, 200)}`);

  const DEADLINE = Date.now() + 5 * 60 * 1000;
  let delay = 4000;
  while (Date.now() < DEADLINE) {
    if (runId) checkCancelled(runId);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1500, 12000);
    const rec = await kieGet<JobRecordResp>(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
    const state = rec.data?.state;
    if (state === "success" && rec.data?.resultJson) {
      try {
        const parsed = JSON.parse(rec.data.resultJson) as { resultUrls?: string[] };
        const url = parsed.resultUrls?.[0];
        if (url) return url;
      } catch {}
      throw new Error("kie.ai nano-banana success but no resultUrls");
    }
    if (state === "fail") throw new Error(`kie.ai nano-banana failed: ${rec.data?.failMsg || rec.data?.failCode || "unknown"}`);
  }
  throw new Error("kie.ai nano-banana timed out");
}

// ── Veo video (dedicated API) ────────────────────────────────────────────────

interface VeoRecordResp {
  data?: {
    successFlag?: number; // 0 generating, 1 success, 2/3 failed
    response?: { resultUrls?: string[] };
    errorMessage?: string;
    errorCode?: string | null;
  };
}

function toVeoAspect(ratio: string): string {
  if (ratio === "9:16") return "9:16";
  return "16:9";
}

/** Generate a video from a text prompt via Veo. Returns the video URL. */
export async function generateVideoUrl(
  runId: string,
  prompt: string,
  aspectRatio = "16:9",
  durationSec = 8
): Promise<string> {
  const model = getSetting("KIE_VIDEO_MODEL") || defaultAiModel("kie", "video");
  const duration = durationSec <= 4 ? 4 : durationSec <= 6 ? 6 : 8;
  if (runId) checkCancelled(runId); // never start a new billable kie job for a cancelled run
  const created = await kiePost<CreateTaskResp>("/api/v1/veo/generate", {
    prompt: prompt.slice(0, 5000),
    model,
    generationType: "TEXT_2_VIDEO",
    aspect_ratio: toVeoAspect(aspectRatio),
    duration,
    resolution: "1080p",
    enableTranslation: false,
  });
  const taskId = created.data?.taskId;
  if (!taskId) throw new Error(`kie.ai veo generate returned no taskId: ${JSON.stringify(created).slice(0, 200)}`);

  const DEADLINE = Date.now() + 12 * 60 * 1000;
  let delay = 6000;
  while (Date.now() < DEADLINE) {
    if (runId) checkCancelled(runId);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 2000, 20000);
    const rec = await kieGet<VeoRecordResp>(`/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`);
    const flag = rec.data?.successFlag;
    if (flag === 1) {
      const url = rec.data?.response?.resultUrls?.[0];
      if (url) return url;
      throw new Error("kie.ai Veo success but no resultUrls");
    }
    if (flag === 2 || flag === 3) {
      throw new Error(`kie.ai Veo failed: ${rec.data?.errorMessage || rec.data?.errorCode || "unknown"}`);
    }
  }
  throw new Error("kie.ai Veo timed out");
}

/** Download a kie.ai result URL to disk. Bounded + freely retryable: the result is
 *  already generated and paid for, so re-fetching its URL costs nothing and cannot
 *  duplicate work — the same reasoning that makes a poll safe to retry. The signal
 *  covers the body stream too, so a socket that dies mid-download aborts instead of
 *  hanging the beat forever. */
export async function downloadKie(url: string, outPath: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(KIE_DOWNLOAD_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`kie.ai download ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength === 0) throw new Error("kie.ai download empty");
      fs.writeFileSync(outPath, buf);
      return;
    } catch (e) {
      if (attempt >= 3) {
        throw isOurAbort(e)
          ? new Error(`kie.ai download: timed out after ${KIE_DOWNLOAD_TIMEOUT_MS / 1000}s`)
          : (e as Error);
      }
      await sleep(2000 * attempt);
    }
  }
}

/**
 * Generate an AI portrait image from a description and save it to `outPath`
 * (used to create an avatar from text). Returns outPath.
 */
export async function generateAvatarImage(prompt: string, outPath: string): Promise<string> {
  // 16:9 on purpose: HeyGen renders a talking photo at the photo's own aspect,
  // so a wide reference photo = a true full-frame 16:9 presenter (no pillarbox,
  // no blur-fill needed). Waist-up framing keeps the face large enough for good
  // lip-sync while still showing a believable environment.
  const styled =
    `${prompt}. Photorealistic medium shot, waist-up, centered, looking straight at the camera, ` +
    `natural realistic environment with soft depth of field, natural lighting, ultra-detailed, 4k. ` +
    `Wide 16:9 cinematic framing. No text, no watermark.`;
  const url = await generateImageUrl("", styled, "16:9");
  await downloadKie(url, outPath);
  return outPath;
}

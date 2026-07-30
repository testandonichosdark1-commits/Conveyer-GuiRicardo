import fs from "node:fs";
import { log } from "../logger";
import { getSetting } from "../settings";
import { checkCancelled } from "../cancellation";
import { uploadAsset, heygenPost, heygenGet, type HeygenAsset } from "./heygen-client";

/**
 * HeyGen talking-head video generation, driven by OUR ElevenLabs voiceover.
 *
 * Flow (docs/DESIGN.md):
 *  1. Upload the voiceover MP3 as a HeyGen audio asset → audio_asset_id.
 *  2. POST /v2/video/generate with the avatar character + voice.type "audio".
 *  3. Poll /v1/video_status.get until completed → time-limited video_url.
 *  4. Download the MP4 to disk immediately (the URL expires).
 */

export interface AvatarHandle {
  /** "talking_photo" → talking_photo_id; "photo_avatar_group"/"avatar" → avatar_id. */
  engine: "talking_photo" | "photo_avatar_group";
  heygenId: string;
  imageKey?: string | null;
  useAvatarIv?: boolean;
  motionPrompt?: string | null;
}

interface GenerateResp {
  error?: unknown;
  data?: { video_id?: string };
  message?: string;
}
interface StatusResp {
  code?: number;
  data?: {
    id?: string;
    status?: string;
    video_url?: string | null;
    error?: { code?: number; message?: string; detail?: string } | string | null;
    duration?: number | null;
  };
  message?: string;
}

function dimension(resolution?: string): { width: number; height: number } {
  const res = resolution || getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const m = res.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  return { width: 1920, height: 1080 };
}

function buildCharacter(avatar: AvatarHandle): Record<string, unknown> {
  if (avatar.engine === "talking_photo") {
    const c: Record<string, unknown> = {
      type: "talking_photo",
      talking_photo_id: avatar.heygenId,
      scale: 1.0,
      talking_photo_style: "square",
    };
    if (avatar.useAvatarIv) c.use_avatar_iv_model = true;
    return c;
  }
  return { type: "avatar", avatar_id: avatar.heygenId, avatar_style: "normal" };
}

/**
 * Generate one HeyGen talking-head clip for `avatar`, lip-synced to the MP3 at
 * `audioPath`, and download it to `outPath`. Returns outPath.
 */
export async function generateAvatarClip(
  runId: string,
  avatar: AvatarHandle,
  audioPath: string,
  outPath: string,
  opts: { background?: string; title?: string; resolution?: string } = {}
): Promise<string> {
  if (!fs.existsSync(audioPath)) throw new Error(`Voiceover not found for HeyGen: ${audioPath}`);

  // Never start a new billable HeyGen job for a cancelled run. This guards the
  // upload + generate below (the poll loop already checks); without it, beats
  // still queued in pLimit when the user cancelled would each create a fresh clip.
  checkCancelled(runId);
  log(runId, "info", `Uploading voiceover to HeyGen (audio asset)`, { stage: "avatar_video" });
  const asset = await uploadWithRetry(runId, audioPath);
  const audioAssetId = asset.id;

  // Only force a background colour when one is explicitly configured. Otherwise
  // omit it so the avatar keeps its OWN photo background (a flat colour makes the
  // avatar look like a floating head — the "no background" issue).
  const bgColor = (opts.background ?? getSetting("AVATAR_BACKGROUND") ?? "").trim();
  const videoInput: Record<string, unknown> = {
    character: buildCharacter(avatar),
    voice: { type: "audio", audio_asset_id: audioAssetId },
  };
  if (bgColor) videoInput.background = { type: "color", value: bgColor };

  const body = {
    video_inputs: [videoInput],
    dimension: dimension(opts.resolution),
    test: false,
    title: opts.title || `Avatar ${runId.slice(0, 8)}`,
  };

  // Re-check between upload and the (billable) generate — the upload+retries may
  // have spanned a cancellation.
  checkCancelled(runId);
  const videoId = await createWithRetry(runId, body);
  log(runId, "info", `HeyGen video queued (${videoId.slice(0, 10)}…) — waiting for render`, {
    stage: "avatar_video",
  });

  const url = await pollVideo(runId, videoId);
  log(runId, "info", `HeyGen render complete — downloading MP4`, { stage: "avatar_video" });
  await download(runId, url, outPath);
  log(runId, "success", `Avatar video saved`, { stage: "avatar_video", data: { videoId } });
  return outPath;
}

/**
 * A freshly uploaded talking photo can be briefly unavailable (moderation).
 * Retry the generate call a few times if HeyGen reports a not-ready/processing
 * style error before giving up.
 */
async function createWithRetry(runId: string, body: unknown): Promise<string> {
  const MAX = 4;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const resp = await heygenPost<GenerateResp>("/v2/video/generate", body);
      const videoId = resp.data?.video_id;
      if (!videoId) throw new Error(`No video_id: ${JSON.stringify(resp).slice(0, 200)}`);
      return videoId;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      const retryable = /not ready|processing|moderation|try again|in progress|400/i.test(lastErr);
      if (attempt < MAX && retryable) {
        const wait = 15000 * attempt;
        log(runId, "warn", `HeyGen generate attempt ${attempt}/${MAX} failed (${lastErr.slice(0, 120)}) — retry in ${wait / 1000}s`, {
          stage: "avatar_video",
        });
        await new Promise((r) => setTimeout(r, wait));
        checkCancelled(runId); // don't re-submit a billable generate for a cancelled run
        continue;
      }
      throw e;
    }
  }
  throw new Error(`HeyGen generate failed after ${MAX} attempts: ${lastErr}`);
}

/**
 * Flatten an error to message + the UNDERLYING cause code. undici surfaces a bare
 * `TypeError: fetch failed` and hides the real reason (DNS/connect/reset) in
 * `.cause.code` (ETIMEDOUT / ECONNRESET / EAI_AGAIN / UND_ERR_CONNECT_TIMEOUT …).
 * Exposing it is the whole point — so the REAL failure is visible in every run's log.
 */
function errDetail(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const cause = err?.cause?.code || err?.cause?.message;
  const msg = err?.message || String(e);
  return cause ? `${msg} [cause: ${cause}]` : msg;
}

/** Transient upload failures worth retrying: any transport/timeout error, plus HTTP 429/5xx. Permanent 4xx (auth/validation) fail fast. */
function isTransientUpload(detail: string): boolean {
  const m = detail.match(/asset upload (\d{3})/);
  if (m) {
    const code = Number(m[1]);
    return code === 429 || code >= 500;
  }
  return true; // no HTTP status → transport/DNS/timeout → transient
}

/**
 * The raw audio upload (upload.heygen.com) was a ONE-SHOT call: a single transient
 * DNS/connect stall or a 5xx/429 dropped the whole beat to b-roll. Retry it on
 * transport-level + transient-HTTP failures, logging the underlying cause each time
 * so the real reason is visible on every machine. The file is read once; uploadAsset
 * rebuilds its own body per call, so retries are safe. HEYGEN_UPLOAD_RETRIES = extra
 * attempts (attempts = retries + 1; default 2 → 3 tries; 0 = one-shot, old behavior).
 */
async function uploadWithRetry(runId: string, audioPath: string): Promise<HeygenAsset> {
  const retries = Math.max(0, Math.min(5, Number(getSetting("HEYGEN_UPLOAD_RETRIES") || "2")));
  const MAX = retries + 1;
  const bytes = fs.readFileSync(audioPath);
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      return await uploadAsset(bytes, "audio/mpeg");
    } catch (e) {
      lastErr = errDetail(e);
      if (attempt < MAX && isTransientUpload(lastErr)) {
        const wait = attempt * 2000; // 2s, 4s, …
        log(runId, "warn", `HeyGen audio upload attempt ${attempt}/${MAX} failed (${lastErr.slice(0, 160)}) — retry in ${wait / 1000}s`, {
          stage: "avatar_video",
        });
        await new Promise((r) => setTimeout(r, wait));
        checkCancelled(runId); // stop re-uploading for a cancelled run
        continue;
      }
      throw new Error(`HeyGen audio upload failed after ${attempt} attempt(s): ${lastErr}`);
    }
  }
  throw new Error(`HeyGen audio upload failed after ${MAX} attempts: ${lastErr}`);
}

async function pollVideo(runId: string, videoId: string): Promise<string> {
  const DEADLINE = Date.now() + 20 * 60 * 1000; // 20 min ceiling
  let delay = 8000;
  while (Date.now() < DEADLINE) {
    checkCancelled(runId);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 2000, 20000);
    const st = await heygenGet<StatusResp>(
      `/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`
    );
    const status = st.data?.status;
    if (status === "completed" && st.data?.video_url) return st.data.video_url;
    if (status === "failed") {
      const err = st.data?.error;
      const detail = typeof err === "string" ? err : err?.message || JSON.stringify(err);
      throw new Error(`HeyGen render failed: ${detail}`);
    }
    log(runId, "debug", `HeyGen status: ${status ?? "?"}`, { stage: "avatar_video" });
  }
  throw new Error("HeyGen render timed out (20 min)");
}

// H1b — the finished-MP4 download was a bare `fetch(url)` with NO timeout and NO
// retry, so a transient connect stall (UND_ERR_CONNECT_TIMEOUT) after a successful
// render still dropped the beat to b-roll. Give it the same treatment as the upload.
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** One download attempt: hard AbortController timeout, normalized to a clear message on abort. */
async function downloadOnce(url: string, outPath: string): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`Download HeyGen video ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength === 0) throw new Error("HeyGen video download was empty");
    fs.writeFileSync(outPath, buf);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Transient download failures worth retrying: transport/timeout/empty, plus HTTP 429/5xx. Permanent 4xx (e.g. an expired signed URL) fail fast. */
function isTransientDownload(detail: string): boolean {
  const m = detail.match(/Download HeyGen video (\d{3})/);
  if (m) {
    const code = Number(m[1]);
    return code === 429 || code >= 500;
  }
  return true; // transport/DNS/timeout/empty → transient
}

/**
 * Download the finished MP4 with timeout + retry, surfacing the underlying cause each
 * time (mirrors uploadWithRetry). HEYGEN_DOWNLOAD_RETRIES = extra attempts (attempts =
 * retries + 1; default 2 → 3 tries; 0 = one-shot, old behavior). The signed URL from
 * pollVideo stays valid for a short window, so re-fetching the same URL is safe.
 */
async function download(runId: string, url: string, outPath: string): Promise<void> {
  const retries = Math.max(0, Math.min(5, Number(getSetting("HEYGEN_DOWNLOAD_RETRIES") || "2")));
  const MAX = retries + 1;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      return await downloadOnce(url, outPath);
    } catch (e) {
      lastErr = errDetail(e);
      if (attempt < MAX && isTransientDownload(lastErr)) {
        const wait = attempt * 2000; // 2s, 4s, …
        log(runId, "warn", `HeyGen MP4 download attempt ${attempt}/${MAX} failed (${lastErr.slice(0, 160)}) — retry in ${wait / 1000}s`, {
          stage: "avatar_video",
        });
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new Error(`HeyGen MP4 download failed after ${attempt} attempt(s): ${lastErr}`);
    }
  }
  throw new Error(`HeyGen MP4 download failed after ${MAX} attempts: ${lastErr}`);
}

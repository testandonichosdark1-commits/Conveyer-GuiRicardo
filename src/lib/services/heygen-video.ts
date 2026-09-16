import fs from "node:fs";
import { log } from "../logger";
import { getSetting } from "../settings";
import { checkCancelled } from "../cancellation";
import { uploadAsset, heygenPost, heygenGet, type HeygenAsset } from "./heygen-client";

/**
 * HeyGen talking-head video generation, driven by OUR ElevenLabs voiceover.
 *
 * TWO renderers, chosen by the run's snapshotted `apiEngine` — never by anything live:
 *
 *   shared  1. Upload the voiceover MP3 as a HeyGen audio asset → audio_asset_id.
 *              (One upload path for both: v3 accepts the v1 endpoint's asset id.)
 *
 *   v2      2. POST /v2/video/generate — character + voice.type "audio"
 *      (Avatar IV / Legacy; use_avatar_iv_model picks between them)
 *           3. Poll /v1/video_status.get → time-limited video_url.
 *
 *   v3      2. POST /v3/videos — type:"avatar" + engine.type:"avatar_v"
 *      (Avatar V)  3. Poll GET /v3/videos/{id} → video_url on completion.
 *
 *   shared  4. Download the MP4 to disk immediately (the URL expires).
 *
 * The two request bodies share NOTHING and must not be merged: /v3/videos rejects
 * unknown fields outright (400 "Extra inputs are not permitted"), so every v2 field is
 * fatal there. See buildV3Body. Docs: docs/DESIGN.md (v2), CLAUDE.md (probed v3).
 */

export interface AvatarHandle {
  /** "talking_photo" → talking_photo_id; "photo_avatar_group"/"avatar" → avatar_id. */
  engine: "talking_photo" | "photo_avatar_group";
  heygenId: string;
  imageKey?: string | null;
  useAvatarIv?: boolean;
  motionPrompt?: string | null;
  /**
   * "avatar_v" → render on v3. NULL/undefined → v2, where useAvatarIv picks Avatar IV
   * vs Legacy. An ENGINE, not an avatar type: `engine` above still says what the avatar
   * IS. Read from the run snapshot, never from live capability.
   */
  apiEngine?: "avatar_v" | null;
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

/* ───────────────────────── Avatar V (HeyGen v3) ─────────────────────────
 * A SEPARATE request model from v2 on purpose. /v3/videos validates strictly —
 * an unknown field is a 400 ("Extra inputs are not permitted"), not a silent
 * ignore — and it shares almost nothing with the v2 body. Verified live:
 *   • v2's `dimension: {width,height}`  → 400 Extra inputs are not permitted
 *   • `resolution`   → enum '4k' | '1080p' | '720p'   (NOT "1920x1080")
 *   • `aspect_ratio` → enum '16:9' | '9:16' | '4:5' | '5:4' | '1:1' | 'auto'
 *   • `expressiveness` → 400 "not supported with engine 'avatar_v'"
 *   • body is a tagged union on top-level `type`: 'avatar' | 'image' | 'cinematic_avatar'
 *   • `engine.type`: 'avatar_v' | 'avatar_iv' | 'avatar_iii'
 * Sharing a builder with v2 would turn every v2-only field into a 400 here.
 */

export type V3Resolution = "720p" | "1080p" | "4k";
export type V3AspectRatio = "16:9" | "9:16" | "4:5" | "5:4" | "1:1";

/**
 * Map our WxH format onto v3's two enums.
 *
 * The quality tier keys off the SHORTER side, which is what 720p/1080p/4k mean in both
 * orientations (1920x1080 and 1080x1920 are both "1080p"). Unknown/garbage input lands
 * on 1080p 16:9 — the same default `dimension()` already uses, so a bad setting behaves
 * identically on both paths.
 */
export function v3Size(resolution?: string): { resolution: V3Resolution; aspect_ratio: V3AspectRatio } {
  const { width, height } = dimension(resolution);
  const short = Math.min(width, height);
  const tier: V3Resolution = short >= 2160 ? "4k" : short >= 1080 ? "1080p" : "720p";

  // Nearest supported aspect by ratio, not by string matching: a channel's format is a
  // pixel size, and 1024x576 is as much 16:9 as 1920x1080 is.
  const r = width / height;
  const candidates: Array<[V3AspectRatio, number]> = [
    ["16:9", 16 / 9], ["9:16", 9 / 16], ["4:5", 4 / 5], ["5:4", 5 / 4], ["1:1", 1],
  ];
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(c[1] - r) < Math.abs(best[1] - r)) best = c;
  return { resolution: tier, aspect_ratio: best[0] };
}

/** The v3 create body. Only fields verified to be accepted alongside engine avatar_v. */
export function buildV3Body(
  avatar: AvatarHandle,
  audioAssetId: string,
  opts: { title?: string; resolution?: string }
): Record<string, unknown> {
  const { resolution, aspect_ratio } = v3Size(opts.resolution);
  return {
    // Required discriminator — omitting it 400s with "Unable to extract tag using
    // discriminator 'type'" before any other validation runs.
    type: "avatar",
    avatar_id: avatar.heygenId,
    audio_asset_id: audioAssetId,
    // ALWAYS explicit. `engine` is optional to the API, and an omitted engine silently
    // renders on HeyGen's default — the substitution we exist to prevent.
    engine: { type: "avatar_v" },
    resolution,
    aspect_ratio,
    title: opts.title || "Avatar V clip",
  };
}

interface V3CreateResp {
  data?: { video_id?: string; status?: string; output_format?: string };
}
interface V3StatusResp {
  data?: {
    id?: string;
    status?: string;
    video_url?: string | null;
    duration?: number | null;
    error?: { message?: string; detail?: string } | string | null;
  };
}

/**
 * Build the /v2/video/generate `character` object.
 *
 * `use_avatar_iv_model` applies to BOTH character types. HeyGen's v2 character
 * table annotates the talking-photo-only fields explicitly (talking_photo_style,
 * talking_style, expression, super_resolution, use_legacy_photo_avatar_model);
 * use_avatar_iv_model carries no such note, so it is valid alongside avatar_id.
 * It therefore has to be set OUTSIDE the type branch — nesting it in the
 * talking_photo branch silently dropped Avatar IV for every "avatar"-type row
 * (imported avatars and trained groups), rendering them on the cheaper legacy
 * engine while the UI and the Costs page both still said Avatar IV.
 */
function buildCharacter(avatar: AvatarHandle): Record<string, unknown> {
  const c: Record<string, unknown> =
    avatar.engine === "talking_photo"
      ? {
          type: "talking_photo",
          talking_photo_id: avatar.heygenId,
          scale: 1.0,
          talking_photo_style: "square",
        }
      : { type: "avatar", avatar_id: avatar.heygenId, avatar_style: "normal" };
  if (avatar.useAvatarIv) c.use_avatar_iv_model = true;
  return c;
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

  // Avatar V renders on v3. The upload above is shared deliberately: verified live that
  // an asset from the v1 raw endpoint IS accepted as /v3/videos `audio_asset_id` (it
  // resolves via GET /v3/assets/{id} and rendered end-to-end), so there is no second
  // upload path to build — and none of uploadWithRetry's retry/cancel handling to
  // duplicate. Everything AFTER the upload differs, so it forks here.
  if (avatar.apiEngine === "avatar_v") {
    return await generateAvatarClipV3(runId, avatar, audioAssetId, outPath, opts);
  }

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
 * Avatar V clip: create on v3, poll v3, download with the SAME downloader as v2.
 * Called only after the shared audio upload, and only when apiEngine === "avatar_v".
 */
async function generateAvatarClipV3(
  runId: string,
  avatar: AvatarHandle,
  audioAssetId: string,
  outPath: string,
  opts: { title?: string; resolution?: string }
): Promise<string> {
  const body = buildV3Body(avatar, audioAssetId, opts);
  // Re-check between upload and the (billable) create — the upload+retries may have
  // spanned a cancellation. Mirrors the v2 path exactly.
  checkCancelled(runId);

  const resp = await heygenPost<V3CreateResp>("/v3/videos", body);
  const videoId = resp.data?.video_id;
  // NOTE: create returns `video_id`; the status payload calls the same thing `id`.
  if (!videoId) throw new Error(`HeyGen /v3/videos returned no video_id: ${JSON.stringify(resp).slice(0, 200)}`);
  log(runId, "info", `HeyGen Avatar V video queued (${videoId.slice(0, 10)}…) — waiting for render`, {
    stage: "avatar_video",
  });

  const url = await pollVideoV3(runId, videoId);
  log(runId, "info", `HeyGen Avatar V render complete — downloading MP4`, { stage: "avatar_video" });
  await download(runId, url, outPath);
  log(runId, "success", `Avatar V video saved`, { stage: "avatar_video", data: { videoId } });
  return outPath;
}

/**
 * Poll `GET /v3/videos/{id}`. Same cadence, deadline and cancellation as the v2 poll —
 * only the URL and payload differ. Observed live: waiting → processing → completed,
 * with video_url appearing only on completion (a 1s clip took ~52s).
 *
 * No retry-on-create equivalent to v2's createWithRetry: that exists for freshly
 * uploaded talking photos clearing moderation, which cannot apply here — an Avatar V
 * avatar is one HeyGen already has and already reports as Avatar V-capable.
 */
async function pollVideoV3(runId: string, videoId: string): Promise<string> {
  const DEADLINE = Date.now() + 20 * 60 * 1000; // 20 min ceiling, as v2
  let delay = 8000;
  while (Date.now() < DEADLINE) {
    checkCancelled(runId);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 2000, 20000);
    const st = await heygenGet<V3StatusResp>(`/v3/videos/${encodeURIComponent(videoId)}`);
    const status = st.data?.status;
    if (status === "completed" && st.data?.video_url) return st.data.video_url;
    // The failure payload was never observed live (no failed render to inspect), so
    // treat any failure-ish status as fatal and surface whatever detail came with it
    // rather than assuming a shape.
    if (status === "failed" || status === "error") {
      const err = st.data?.error;
      const detail = typeof err === "string" ? err : err?.message || JSON.stringify(err ?? st.data);
      throw new Error(`HeyGen Avatar V render failed: ${String(detail).slice(0, 200)}`);
    }
    log(runId, "debug", `HeyGen Avatar V status: ${status ?? "?"}`, { stage: "avatar_video" });
  }
  throw new Error("HeyGen Avatar V render timed out (20 min)");
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

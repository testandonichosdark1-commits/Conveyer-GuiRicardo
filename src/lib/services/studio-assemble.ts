import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { resolveFfmpeg, resolveFfprobe, STRIP_TOOLCHAIN_TAGS } from "../ffmpeg-bin";
import { log } from "../logger";
import { masterLoudness } from "./audio-loudness";
import { buildOverlayPlan } from "./overlay-renderer";
import type { Beat } from "./studio-plan";

/**
 * Studio compositor — DRIFT-FREE by construction.
 *
 * Every beat is rendered SILENT with an EXACT frame count taken from the beat's
 * absolute boundaries on the fps grid:
 *
 *     frames(i) = round(end_i · fps) − round(start_i · fps)
 *
 * The counts telescope, so the concatenated video timeline lands every beat
 * boundary within half a frame of its true position — errors do NOT accumulate.
 * The ONE master voiceover is then muxed over the whole concat as the only
 * audio track.
 *
 * Why not per-beat audio? Video lengths round to the frame grid (33 ms @30fps)
 * and AAC lengths round to 1024-sample frames (~23 ms) — concat sums the two
 * streams independently, so with per-beat audio the A/V offset is a random walk
 * that grows with beat count: lips start fine and drift visibly by the end of a
 * long video (reported by a tester on a 43-beat run). With silent exact-length
 * beats + one continuous narration track there is nothing to drift: HeyGen lip
 * clips are generated from slices of that same narration at the same offsets.
 */

export interface RenderBeat extends Beat {
  /** Visual mp4 for broll/split beats; null for full "avatar" beats. */
  visualPath: string | null;
  /** Per-beat HeyGen talking-head clip for avatar/split beats; null otherwise. */
  avatarClipPath: string | null;
}

function dims(resolution?: string): { w: number; h: number; fps: number } {
  const res = resolution || getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const m = res.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  const fps = Math.max(1, Number(getSetting("VIDEO_FPS") || "30"));
  return m ? { w: Number(m[1]), h: Number(m[2]), fps } : { w: 1920, h: 1080, fps };
}

function ffmpegBin(): string {
  return resolveFfmpeg();
}

function runFfmpeg(args: string[]): void {
  const r = spawnSync(ffmpegBin(), args, { stdio: "pipe" });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed (rc=${r.status}): ${(r.stderr?.toString() ?? "").slice(-400)}`);
  }
}

/** On-disk size in bytes, or -1 if the file is missing/unreadable. */
function fileSize(p: string | null): number {
  if (!p) return -1;
  try { return fs.statSync(p).size; } catch { return -1; }
}

/** Exact coded-frame count of a clip's video stream (nb_read_packets), or null if unmeasurable. */
function probeFrameCount(clipPath: string): number | null {
  const r = spawnSync(
    resolveFfprobe(),
    ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", clipPath],
    { encoding: "utf8", timeout: 60000 }
  );
  const v = Number((r.stdout || "").trim());
  return r.status === 0 && Number.isFinite(v) && v > 0 ? v : null;
}

/** Container duration in seconds, or null if unmeasurable. */
function probeDurationSec(clipPath: string): number | null {
  const r = spawnSync(
    resolveFfprobe(),
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clipPath],
    { encoding: "utf8", timeout: 30000 }
  );
  const v = Number((r.stdout || "").trim());
  return r.status === 0 && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Identical video encode params across beats → the concat is a safe stream copy.
 *
 * This is the SECOND generation for a still (Ken Burns already encoded it) and the
 * second for downloaded footage too, so `veryfast`/crf 21 was compounding: the preset
 * decides how much of a high-detail frame — fur, foliage, crowds — survives at a given
 * crf, and veryfast discards the most. crf 18 at `medium` is the usual
 * visually-transparent point. Costs roughly 1.5x the bytes and a few seconds per beat.
 */
function encodeV(fps: number): string[] {
  return [
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-an",
    "-movflags", "+faststart",
    "-y",
  ];
}

/** Exact frame count for a beat — boundaries snapped to the fps grid (telescoping). */
function beatFrames(beat: { startMs: number; endMs: number }, fps: number): number {
  return Math.max(1, Math.round((beat.endMs * fps) / 1000) - Math.round((beat.startMs * fps) / 1000));
}

/**
 * Decode the master narration to PCM WAV once. Input-seeking (-ss before -i) on
 * MP3 lands on MP3-frame boundaries and is only approximate (±tens of ms,
 * worse with VBR) — which made every avatar slice except the first (start=0)
 * slightly offset, so lips looked fine on the opening avatar and wrong on the
 * later ones. WAV (CBR PCM) input-seeks sample-exactly.
 */
export function decodeToWav(srcPath: string, outPath: string): string {
  runFfmpeg(["-i", srcPath, "-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2", "-y", outPath]);
  return outPath;
}

/** Slice [startMs,endMs] of the narration into its own mp3 (drives HeyGen lip-sync). Pass the WAV master for sample-exact cuts. */
export function sliceAudio(voiceoverPath: string, startMs: number, endMs: number, outPath: string): void {
  const ss = (startMs / 1000).toFixed(3);
  const t = Math.max(0.2, (endMs - startMs) / 1000).toFixed(3);
  runFfmpeg(["-ss", ss, "-t", t, "-i", voiceoverPath, "-c:a", "libmp3lame", "-b:a", "192k", "-y", outPath]);
}

/** Video stream size of a clip ("WxH"), or null if unmeasurable. */
function probeVideoSize(clipPath: string): { w: number; h: number } | null {
  const r = spawnSync(
    resolveFfprobe(),
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", clipPath],
    { encoding: "utf8", timeout: 30000 }
  );
  const m = (r.stdout || "").trim().match(/^(\d+)x(\d+)/);
  if (r.status !== 0 || !m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * A crop is only plausible if it really is a BAR STRIP, never a crop INTO the picture.
 *
 * cropdetect returns the bounding box of everything BRIGHTER than its threshold. On a
 * genuinely pillarboxed talking-photo that box is the photo — correct. But on an avatar
 * rendered against a DARK studio background (luma ≈26, i.e. below our limit=48) the
 * "bars" it finds are the background itself, so it hands back the FACE:
 *
 *   crop=400:500:760:250   on 1920x1080  ← the confirmed client bug. That 400x500 sliver
 *   becomes the whole avatar: top of the head cut off, and the blur-fill path below blows
 *   it up ~4.9x into a mush background with the face letterboxed on top.
 *
 * The structural tell: a real pillarbox/letterbox always preserves ONE full dimension —
 * bars left+right keep the source HEIGHT, bars top+bottom keep the source WIDTH. The bug
 * case shrinks BOTH. So:
 *
 *   crop=608:1080:656:0    on 1920x1080  ← the 9:16 talking-photo pillarbox this crop was
 *   added for. height 1080 == source 1080 → ACCEPT (must keep working).
 *
 * Second, independent guard: an area floor. "Keep one full dimension" alone still admits a
 * degenerate sliver like crop=50:1080:900:0 (full height, 50px wide), which would be blown
 * up ~38x and fail exactly like the bug. The floor is 15% of the source area — a BALLPARK,
 * not derived from any measured distribution of HeyGen outputs; it is simply far below the
 * must-accept case (608·1080 / 1920·1080 ≈ 31.6%) and far above the bug (400·500 / 1920·1080
 * ≈ 9.6%). Both guards reject the bug on their own; that redundancy is deliberate.
 */
const MIN_CROP_AREA_FRACTION = 0.15;
/** cropdetect's round=2 can shave a pixel off a full-size dimension — don't fail on that. */
const CROP_DIM_TOLERANCE_PX = 2;

export function isPlausibleContentCrop(crop: string, srcW: number, srcH: number): boolean {
  if (!(srcW > 0 && srcH > 0)) return false;
  const m = /^(-?\d+):(-?\d+):(-?\d+):(-?\d+)$/.exec((crop ?? "").trim());
  if (!m) return false;
  const [w, h, x, y] = m.slice(1, 5).map(Number);
  if (!(w > 0 && h > 0) || x < 0 || y < 0) return false;
  if (x + w > srcW || y + h > srcH) return false;

  const keepsFullDimension = w >= srcW - CROP_DIM_TOLERANCE_PX || h >= srcH - CROP_DIM_TOLERANCE_PX;
  if (!keepsFullDimension) return false;

  return (w * h) / (srcW * srcH) >= MIN_CROP_AREA_FRACTION;
}

/**
 * The rectangles a crop would REMOVE, as ffmpeg `crop=w:h:x:y` argument strings.
 * Pure; exported for tests. Order is left, right, top, bottom; zero-width strips
 * are omitted.
 */
export function removedStrips(crop: string, srcW: number, srcH: number): string[] {
  const m = /^(\d+):(\d+):(\d+):(\d+)$/.exec((crop ?? "").trim());
  if (!m || !(srcW > 0 && srcH > 0)) return [];
  const [w, h, x, y] = m.slice(1, 5).map(Number);
  const strips: string[] = [];
  if (x > 0) strips.push(`${x}:${srcH}:0:0`);
  const right = srcW - (x + w);
  if (right > 0) strips.push(`${right}:${srcH}:${x + w}:0`);
  if (y > 0) strips.push(`${srcW}:${y}:0:0`);
  const bottom = srcH - (y + h);
  if (bottom > 0) strips.push(`${srcW}:${bottom}:0:${y + h}`);
  return strips;
}

/**
 * A genuine pillarbox/letterbox bar is a FLAT FILL — every pixel the same value.
 * Picture content is not. Measured on real files (2026-07-29):
 *   HeyGen's black bar around a portrait talking-photo → YMIN 16, YMAX 16, spread 0
 *   the dark corner of a client's garage photo         → YMIN 13, YMAX 116, spread 103
 * 12 sits far from both; it tolerates encoder ringing along a real bar's edge without
 * coming near the picture case.
 */
const BAR_MAX_LUMA_SPREAD = 12;
/** ...and a bar is DARK. cropdetect's limit=48 is a luma threshold, so anything it
 *  treats as "bar" should average well under it; 64 leaves headroom without admitting
 *  a bright wall or a blown-out window as a "bar". */
const BAR_MAX_LUMA_AVG = 64;

/** Pure verdict from a strip's measured luma, exported so the thresholds are testable
 *  without running ffmpeg. */
export function readsAsFlatBar(spread: number, avg: number): boolean {
  return spread <= BAR_MAX_LUMA_SPREAD && avg <= BAR_MAX_LUMA_AVG;
}

/**
 * How far an avatar clip's aspect may sit from the frame's and still be COVER-cropped
 * instead of blur-filled. 5% is far above the cases it must catch (our own 4px shave
 * moves 16:9 by 0.33%) and far below the case blur-fill exists for (a 9:16 talking-photo
 * pillarbox is ~68% away).
 */
const AVATAR_COVER_ASPECT_TOLERANCE = 0.05;

/** Exported for tests: does this clip shape get cover-crop (true) or blur-fill (false)? */
export function usesCoverCrop(clipW: number, clipH: number, frameW: number, frameH: number): boolean {
  if (!(clipW > 0 && clipH > 0 && frameW > 0 && frameH > 0)) return false;
  const target = frameW / frameH;
  return Math.abs(clipW / clipH - target) / target <= AVATAR_COVER_ASPECT_TOLERANCE;
}

/**
 * The avatar clip's dimensions as the filter chain will see them — after contentCrop's
 * crop (when one was accepted) and after the fixed 4px-per-edge shave. Returns null when
 * the clip is unmeasurable, which makes the caller fall back to blur-fill (today's path).
 */
function avatarPostCropSize(clipPath: string, avCrop: string | null): { w: number; h: number } | null {
  let base = probeVideoSize(clipPath);
  if (avCrop) {
    const m = /^(\d+):(\d+):/.exec(avCrop);
    if (m) base = { w: Number(m[1]), h: Number(m[2]) };
  }
  if (!base) return null;
  const w = base.w - 8;
  const h = base.h - 8;
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Measure one strip's luma spread + average via ffmpeg signalstats. null = unmeasurable. */
function stripLuma(clipPath: string, strip: string): { spread: number; avg: number } | null {
  const r = spawnSync(
    ffmpegBin(),
    ["-ss", "0.5", "-i", clipPath, "-vf", `crop=${strip},signalstats,metadata=print:file=-`, "-frames:v", "3", "-an", "-f", "null", "-"],
    { stdio: "pipe", encoding: "utf8", timeout: 30000 }
  );
  const out = ((r.stdout ?? "") as string) + ((r.stderr ?? "") as string);
  const mins = [...out.matchAll(/signalstats\.YMIN=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const maxs = [...out.matchAll(/signalstats\.YMAX=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const avgs = [...out.matchAll(/signalstats\.YAVG=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (mins.length === 0 || maxs.length === 0 || avgs.length === 0) return null;
  // Worst case across the sampled frames — a bar that is flat in one frame and not in
  // another is not a bar.
  return { spread: Math.max(...maxs) - Math.min(...mins), avg: Math.max(...avgs) };
}

/**
 * Detect a clip's non-black content rectangle ("w:h:x:y") via cropdetect, so we
 * can strip the black pillarbox bars HeyGen adds around a portrait talking-photo
 * (otherwise the avatar shows as a phone-style 9:16 strip inside the 16:9 frame).
 * Returns null when nothing meaningful — or nothing TRUSTWORTHY — is detected;
 * null simply means "no crop", which is the pre-2026-06 behaviour (bars visible).
 * That is strictly better than an unvalidated crop, which destroys the frame.
 */
// Exported for src/lib/services/avatar-bar-guard.test.ts so the tests exercise THIS
// function rather than a re-implementation of it. Nothing else imports it.
export function contentCrop(clipPath: string, runId?: string): string | null {
  // limit=48: video is limited-range (black = Y'16), and HeyGen's near-black
  // backgrounds (e.g. #101418 → Y'≈33) sit ABOVE the cropdetect default of 24,
  // which silently disabled the crop. 48 catches black and dark-gray bars.
  const r = spawnSync(
    ffmpegBin(),
    ["-ss", "0.5", "-i", clipPath, "-vf", "cropdetect=48:2:0", "-frames:v", "60", "-an", "-f", "null", "-"],
    { stdio: "pipe", encoding: "utf8" }
  );
  const out = (r.stderr ?? "").toString();
  const m = [...out.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)];
  const crop = m.length ? m[m.length - 1][1] : null;
  if (!crop) return null;

  // No source dimensions ⇒ the crop cannot be validated ⇒ don't trust it.
  const src = probeVideoSize(clipPath);
  if (!src) {
    if (runId) log(runId, "debug", `Avatar crop ${crop} discarded — source size unmeasurable`, { stage: "assemble" });
    return null;
  }
  if (!isPlausibleContentCrop(crop, src.w, src.h)) {
    if (runId) {
      log(
        runId,
        "debug",
        `Avatar crop ${crop} REJECTED on ${src.w}x${src.h} — cropdetect cut into the picture ` +
          `(dark background below limit=48), rendering uncropped instead`,
        { stage: "assemble" }
      );
    }
    return null;
  }

  // FINAL guard — is what we are about to remove actually a BAR?
  //
  // The two guards above only check the crop's SHAPE, and a modest edge shave passes
  // both: crop=1886:1080:0:0 keeps the full height and 98% of the area. But on a real
  // client clip (2026-07-29) that crop was cutting 34px off a photo whose right side is
  // a dark corner of a garage — cropdetect's limit=48 cannot tell a dark PICTURE from a
  // black BAR. The 34px loss then made the clip 1886x1080, which no longer matches 16:9,
  // so renderBeat's blur-fill padded it back out with 14px of blurred smear down each
  // side. That smear is what the client saw and reported as "grey lateral spaces".
  //
  // A bar is a flat fill; a photo is not. Measuring the removed strip settles it
  // directly, instead of guessing from the crop's geometry.
  for (const strip of removedStrips(crop, src.w, src.h)) {
    const luma = stripLuma(clipPath, strip);
    if (!luma) continue; // unmeasurable → don't block a legitimate crop on a probe failure
    if (!readsAsFlatBar(luma.spread, luma.avg)) {
      if (runId) {
        log(
          runId,
          "debug",
          `Avatar crop ${crop} REJECTED on ${src.w}x${src.h} — the strip it removes (${strip}) is ` +
            `picture, not a bar (luma spread ${luma.spread.toFixed(0)}, avg ${luma.avg.toFixed(0)}); rendering uncropped`,
          { stage: "assemble" }
        );
      }
      return null;
    }
  }
  return crop;
}

/**
 * Render one SILENT beat clip of exactly `beatFrames(beat)` frames to outPath.
 * Sources shorter than the beat are padded by cloning the last frame (tpad);
 * looping visuals just keep flowing; `-frames:v` cuts everything to the exact
 * count. The narration is muxed once over the final concat — never per beat.
 */
function renderBeat(
  beat: RenderBeat,
  outPath: string,
  dim: { w: number; h: number; fps: number },
  fade?: { inSec: number; outSec: number },
  runId?: string
): void {
  const { w, h, fps } = dim;
  const frames = beatFrames(beat, fps);

  // Phase 1 — optional dip-to-black transition, folded into THIS beat's existing
  // encode (no extra ffmpeg pass) and LENGTH-NEUTRAL: the fades live inside the
  // beat's own exact frame budget, so the drift-free telescoping invariant and the
  // voiceover sync are untouched. Each side is clamped to beatDur/3 so fade-in and
  // fade-out can never overlap on a very short beat. Empty string when off → the
  // ffmpeg commands below are byte-identical to today.
  const beatDurSec = frames / fps;
  const maxFade = beatDurSec / 3;
  const fin = fade ? Math.min(Math.max(0, fade.inSec), maxFade) : 0;
  const fout = fade ? Math.min(Math.max(0, fade.outSec), maxFade) : 0;
  const fadeParts: string[] = [];
  if (fin > 0) fadeParts.push(`fade=t=in:st=0:d=${fin.toFixed(3)}`);
  if (fout > 0) fadeParts.push(`fade=t=out:st=${(beatDurSec - fout).toFixed(3)}:d=${fout.toFixed(3)}`);
  const fadeFx = fadeParts.length ? "," + fadeParts.join(",") : "";
  // Clone-pad well past the beat length so -frames:v always has enough input.
  const pad = `tpad=stop_mode=clone:stop_duration=15`;
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps}`;

  // Strip HeyGen's pillarbox bars from the avatar clip so it fills the frame,
  // then shave 4px off every edge: HeyGen renders the talking photo with a
  // 1–2px near-white fringe (photo on a white canvas) that cropdetect can't
  // catch (it only detects dark bars) and that reads as "white borders".
  const avCrop = beat.avatarClipPath ? contentCrop(beat.avatarClipPath, runId) : null;
  const avPre = (avCrop ? `crop=${avCrop},` : "") + "crop=iw-8:ih-8:4:4,";

  // Is the avatar clip essentially the frame's shape already? The blur-fill below exists
  // for a PORTRAIT talking-photo, which genuinely cannot fill 16:9. For a clip that is
  // already ~16:9 it is not just unnecessary, it is harmful: our own 4px-per-edge shave
  // moves 1920x1080 to 1912x1072, a 0.3% aspect change, and fitting THAT inside the frame
  // leaves a 2px blurred smear along the top and bottom of every full-screen avatar shot.
  // Cropping those 2px away instead is invisible; the smear is not.
  const avSrc = beat.avatarClipPath ? avatarPostCropSize(beat.avatarClipPath, avCrop) : null;
  const nearFrameAspect = avSrc !== null && usesCoverCrop(avSrc.w, avSrc.h, w, h);

  // Optional lip-timing trim for HeyGen's own render latency (AVATAR_SYNC_OFFSET_MS):
  // positive = avatar video starts LATER (use when lips run ahead of the voice),
  // negative = earlier (lips behind the voice). 0 (default) = off.
  const syncMs = Math.round(Number(getSetting("AVATAR_SYNC_OFFSET_MS") || "0")) || 0;
  const avSeek = syncMs < 0 ? ["-ss", (Math.abs(syncMs) / 1000).toFixed(3)] : [];
  const avDelay = syncMs > 0 ? `tpad=start_mode=clone:start_duration=${(syncMs / 1000).toFixed(3)},` : "";

  // Full-screen avatar — blur-fill: a portrait talking-photo can never fill
  // 16:9, and zoom-cropping it would cut the head. Background = the same clip
  // scaled to fill + blurred, foreground = the clip fitted by height, centered.
  // For an already-16:9 clip the foreground covers the frame exactly (no-op).
  if (beat.avatarClipPath && (beat.layout === "avatar" || !beat.visualPath)) {
    // Already the frame's shape → cover-crop (identical to the split path), no blur, no bars.
    if (nearFrameAspect) {
      runFfmpeg([
        ...avSeek, "-i", beat.avatarClipPath,
        "-filter_complex", `[0:v]${avPre}${fit},${avDelay}${pad}${fadeFx}[v]`,
        "-map", "[v]", "-frames:v", String(frames),
        ...encodeV(fps), outPath,
      ]);
      return;
    }
    runFfmpeg([
      ...avSeek, "-i", beat.avatarClipPath,
      "-filter_complex",
      `[0:v]${avPre}split=2[bgs][fgs];` +
        `[bgs]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=32:2,setsar=1[bg];` +
        `[fgs]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${fps},${avDelay}${pad}${fadeFx}[v]`,
      "-map", "[v]", "-frames:v", String(frames),
      ...encodeV(fps), outPath,
    ]);
    return;
  }

  // Split: avatar left half + visual right half (visual loops; avatar pads).
  if (beat.layout === "split" && beat.avatarClipPath && beat.visualPath) {
    const halfW = Math.round(w / 2);
    runFfmpeg([
      ...avSeek, "-i", beat.avatarClipPath,
      "-stream_loop", "-1", "-i", beat.visualPath,
      "-filter_complex",
      `[0:v]${avPre}scale=${halfW}:${h}:force_original_aspect_ratio=increase,crop=${halfW}:${h},setsar=1,fps=${fps},${avDelay}${pad}[l];` +
        `[1:v]scale=${halfW}:${h}:force_original_aspect_ratio=increase,crop=${halfW}:${h},setsar=1,fps=${fps}[r];` +
        `[l][r]hstack=inputs=2${fadeFx}[v]`,
      "-map", "[v]", "-frames:v", String(frames),
      ...encodeV(fps), outPath,
    ]);
    return;
  }

  // Full-screen B-roll (loops if shorter than the beat).
  if (beat.visualPath) {
    runFfmpeg([
      "-stream_loop", "-1", "-i", beat.visualPath,
      "-vf", fit + fadeFx, "-map", "0:v:0", "-frames:v", String(frames),
      ...encodeV(fps), outPath,
    ]);
    return;
  }

  throw new Error(`Beat ${beat.index} has neither a visual nor an avatar clip to render`);
}

/** Neutral filler of exactly the beat's frames — keeps the timeline aligned when a beat fails to render. */
function renderFiller(beat: RenderBeat, outPath: string, dim: { w: number; h: number; fps: number }): void {
  const { w, h, fps } = dim;
  runFfmpeg([
    "-f", "lavfi", "-i", `color=c=0x101418:s=${w}x${h}:r=${fps}`,
    "-frames:v", String(beatFrames(beat, fps)),
    ...encodeV(fps), outPath,
  ]);
}

export async function assembleStudioVideo(
  runId: string,
  voiceoverPath: string,
  beats: RenderBeat[],
  outDir: string,
  resolution?: string,
  sceneTransitions?: boolean,
  overlays?: boolean
): Promise<string> {
  const beatsDir = path.join(outDir, "beats");
  fs.mkdirSync(beatsDir, { recursive: true });
  const dim = dims(resolution);
  log(runId, "info", `Compositing ${beats.length} beats over the voiceover (${dim.w}x${dim.h})`, { stage: "assemble" });

  // Phase 1 — optional dip-to-black transitions. OFF (default) → fade={in:0,out:0}
  // for every beat → renderBeat emits today's exact ffmpeg commands. Internal beats
  // fade in AND out; first beat never fades in, last beat never fades out (the video
  // doesn't start/end from black). Length-neutral: concat + voiceover mux below are
  // untouched, so timing/sync are byte-identical.
  // Per-run toggle (Create Video → Advanced Options) wins when set; otherwise fall
  // back to the global SCENE_TRANSITIONS default (off). Duration stays global (ms).
  const tv = (getSetting("SCENE_TRANSITIONS") || "off").trim().toLowerCase();
  const globalOn = tv === "on" || tv === "1" || tv === "true";
  const transitionsOn = sceneTransitions ?? globalOn;
  const transitionSec = transitionsOn ? Math.max(0, Number(getSetting("SCENE_TRANSITION_MS") || "300")) / 1000 : 0;
  if (transitionsOn) log(runId, "info", `Scene transitions ON — dip-to-black ${Math.round(transitionSec * 1000)}ms`, { stage: "assemble" });

  const clipPaths: string[] = [];
  const fillerBeats: number[] = []; // beats that fell back to a black filler — surfaced at run level below
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const fade = {
      inSec: transitionSec > 0 && i > 0 ? transitionSec : 0,
      outSec: transitionSec > 0 && i < beats.length - 1 ? transitionSec : 0,
    };
    const clip = path.join(beatsDir, `beat_${String(clipPaths.length).padStart(4, "0")}.mp4`);
    try {
      renderBeat(beat, clip, dim, fade, runId);
      // A source that decodes just enough to pass retrieval (freeze probe ok) can
      // still exhaust/error mid-encode and yield a SHORT clip — which would slide
      // every later beat off the narration. Verify the exact frame count; if it's
      // materially short (>~100ms), drop to an exact-length filler so sync holds.
      const want = beatFrames(beat, dim.fps);
      const got = probeFrameCount(clip);
      if (got !== null && got < want - Math.ceil(dim.fps * 0.1)) {
        throw new Error(`short render: ${got}/${want} frames`);
      }
      clipPaths.push(clip);
    } catch (e) {
      // A skipped beat would shift every later beat off the narration — render an
      // exact-length neutral filler instead so the timeline stays aligned. This is
      // a SILENT BLACK substitution, so log it LOUDLY + attributably: which asset
      // failed and its on-disk size (0/tiny ⇒ a truncated or error-body download).
      const src = beat.visualPath ?? beat.avatarClipPath;
      const size = fileSize(src);
      log(
        runId,
        "error",
        `Beat ${beat.index} (${beat.layout}) render FAILED → black filler: ${(e as Error).message.slice(0, 150)} ` +
          `[src=${src ?? "none"} size=${size < 0 ? "?" : size + "B"}]`,
        { stage: "assemble" }
      );
      try {
        renderFiller(beat, clip, dim);
        clipPaths.push(clip);
        fillerBeats.push(beat.index);
      } catch {
        log(runId, "error", `Beat ${beat.index} filler failed too — skipped (timing may shift)`, { stage: "assemble" });
      }
    }
  }
  if (clipPaths.length === 0) throw new Error("No beats rendered — cannot assemble");
  if (fillerBeats.length > 0) {
    log(
      runId,
      "error",
      `${fillerBeats.length} beat(s) fell back to a black filler: [${fillerBeats.join(", ")}] — these visuals need investigation`,
      { stage: "assemble" }
    );
  }

  // Concat the silent beats (identical params → stream copy), then mux the ONE
  // master narration over the whole video. Audio is continuous by construction.
  const listFile = path.join(beatsDir, "concat.txt");
  fs.writeFileSync(
    listFile,
    clipPaths.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
    "utf-8"
  );
  const silentPath = path.join(beatsDir, "video_silent.mp4");
  runFfmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-y", silentPath]);

  // Defense-in-depth: the final mux uses -shortest, so if the concatenated video
  // came out materially shorter than the narration (a beat rendered short despite
  // the per-beat guard), the audio TAIL would be silently truncated. Surface it.
  const silentDur = probeDurationSec(silentPath);
  const voiceDur = probeDurationSec(voiceoverPath);
  if (silentDur !== null && voiceDur !== null && silentDur < voiceDur - 0.5) {
    log(
      runId,
      "error",
      `Silent video ${silentDur.toFixed(2)}s is shorter than the narration ${voiceDur.toFixed(2)}s ` +
        `(by ${(voiceDur - silentDur).toFixed(2)}s) — -shortest will clip the audio tail; a beat likely rendered short`,
      { stage: "assemble" }
    );
  }

  // Informational Overlays (Stage 1) — a DEDICATED pass between concat and mux.
  // OFF (default) → `videoForMux` stays `silentPath` and every ffmpeg call below is
  // byte-identical to before this feature. ON → the OverlayRenderer draws the cards
  // and returns a filter; we composite them over the concatenated timeline (one extra
  // re-encode) and mux that instead. Fully fail-open: any problem here (no cards, a
  // render error, an ffmpeg failure) delivers the exact same video as OFF — overlays
  // never fail a render. Recomputed on every assemble/resume from beats.json, so no
  // per-beat clip is touched and nothing is re-billed.
  let videoForMux = silentPath;
  if (overlays === true) {
    try {
      const plan = await buildOverlayPlan(beats, dim, path.join(beatsDir, "overlays"), runId);
      if (plan) {
        const overlaidPath = path.join(beatsDir, "video_overlaid.mp4");
        // The card inputs are looped (`-loop 1`) and therefore INFINITE, while the base video
        // is finite. Neither overlay's primary-EOF nor `-shortest` reliably stops the encode
        // (the looped image streams keep driving the graph), so we HARD-CAP the output to the
        // base video's exact length with `-t`. This keeps the overlaid video the same
        // duration/frame count as silentPath, so the downstream mux and A/V sync are
        // unaffected. WITHOUT this bound the pass never terminates.
        const capSec = silentDur ?? Math.max(...beats.map((b) => b.endMs)) / 1000;
        runFfmpeg([
          "-i", silentPath,
          ...plan.inputs.flatMap((p) => ["-loop", "1", "-i", p]),
          "-filter_complex", plan.filter,
          "-map", "[vout]",
          "-t", capSec.toFixed(3),
          ...encodeV(dim.fps),
          overlaidPath,
        ]);
        videoForMux = overlaidPath;
        log(runId, "info", `Overlays: composited ${plan.inputs.length} card(s) onto the timeline`, { stage: "assemble" });
      } else {
        // warn, not info: the operator switched text ON and is getting a video without it. The
        // plan stage already logged WHY (quota vs. nothing card-worthy); this is the delivery fact.
        log(runId, "warn", "Overlays enabled, but the plan produced no cards — delivering without overlays", { stage: "assemble" });
      }
    } catch (e) {
      log(runId, "error", `Overlay pass FAILED — delivering the video WITHOUT overlays: ${(e as Error).message.slice(0, 180)}`, { stage: "assemble" });
      videoForMux = silentPath; // fail-open: a failed overlay must never fail the render
    }
  }

  const finalPath = path.join(outDir, "final.mp4");
  runFfmpeg([
    "-i", videoForMux,
    "-i", voiceoverPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
    // Ship the operator's video without our toolchain stamped on it. ffmpeg
    // otherwise writes encoder=Lavf.../Lavc... libx264 into the container, so the
    // delivered file advertises how it was made. This strips inherited tags and
    // clears the encoder tag — a product-hygiene change, NOT an attempt to
    // impersonate another editor (we set no fake NLE identity). The deeper
    // fingerprints (stsd/avc1 vendor_id=FFMP, ftyp minor_version=512) need an
    // in-place binary patch and are deliberately out of scope here.
    ...STRIP_TOOLCHAIN_TAGS,
    "-movflags", "+faststart",
    "-shortest",
    "-y", finalPath,
  ]);

  // Final mastering: normalize the delivered audio to the loudness target (see
  // audio-loudness.ts). Safe no-op when disabled or unmeasurable.
  masterLoudness(runId, finalPath);

  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });
  return finalPath;
}

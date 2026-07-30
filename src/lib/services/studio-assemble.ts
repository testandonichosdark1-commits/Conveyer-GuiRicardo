import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { resolveFfmpeg, resolveFfprobe } from "../ffmpeg-bin";
import { log } from "../logger";
import { masterLoudness } from "./audio-loudness";
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

/** Identical video encode params across beats → the concat is a safe stream copy. */
function encodeV(fps: number): string[] {
  return [
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
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

/**
 * Detect a clip's non-black content rectangle ("w:h:x:y") via cropdetect, so we
 * can strip the black pillarbox bars HeyGen adds around a portrait talking-photo
 * (otherwise the avatar shows as a phone-style 9:16 strip inside the 16:9 frame).
 * Returns null when nothing meaningful is detected.
 */
function contentCrop(clipPath: string): string | null {
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
  return m.length ? m[m.length - 1][1] : null;
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
  fade?: { inSec: number; outSec: number }
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
  const avCrop = beat.avatarClipPath ? contentCrop(beat.avatarClipPath) : null;
  const avPre = (avCrop ? `crop=${avCrop},` : "") + "crop=iw-8:ih-8:4:4,";

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
  sceneTransitions?: boolean
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
      renderBeat(beat, clip, dim, fade);
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

  const finalPath = path.join(outDir, "final.mp4");
  runFfmpeg([
    "-i", silentPath,
    "-i", voiceoverPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
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

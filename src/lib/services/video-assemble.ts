import path from "node:path";
import fs from "node:fs";
import ffmpeg from "fluent-ffmpeg";
import { getSetting } from "../settings";
import { resolveFfmpeg, resolveFfprobe } from "../ffmpeg-bin";
import { log } from "../logger";
import { pLimit } from "../plimit";
import { masterLoudness } from "./audio-loudness";
import type { Scene } from "./scene-split";
import type { TtsResult } from "./tts";

export interface AssembleInput {
  scene: Scene;
  imagePath: string;
  videoPath?: string | null;
  audio: TtsResult;
}

/**
 * Builds the final video using random Ken-Burns clips + xfade transitions.
 *
 * Steps:
 *  1. For each scene render a clip whose duration matches its audio (measured via ffprobe).
 *     - Ken-Burns: random zoom-in (1.0→1.18) or zoom-out (1.18→1.0)
 *     - If videoPath (img2vid) is provided, that clip is used as the base instead
 *  2. Concat all clips with xfade on the boundaries (smooth crossfade).
 *     - If TRANSITION_DURATION = 0 → simple concat without transitions.
 */
export async function assembleVideo(
  runId: string,
  scenes: AssembleInput[],
  outDir: string
): Promise<string> {
  ensureFfmpegPaths();

  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const transitionSec = Number(getSetting("TRANSITION_DURATION") || "0.5");
  const tailSilence = Math.max(0, Number(getSetting("SCENE_TAIL_SILENCE") || "0.4"));
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  log(runId, "info", `Assembling ${scenes.length} clips (${resolution} @${fps}fps, ${assembleConcurrency} in parallel)`, {
    stage: "assemble",
  });

  // 1. Render individual clips in PARALLEL (was sequential before).
  //    Preserve ordering by index — Promise.all does not guarantee completion order.
  const limitClip = pLimit(assembleConcurrency);
  const indexed: ({ path: string; durationSec: number; index: number })[] = await Promise.all(
    scenes.map((item) =>
      limitClip(async () => {
        const clipPath = path.join(
          clipsDir,
          `clip_${String(item.scene.index).padStart(3, "0")}.mp4`
        );
        const audioDuration = await probeDuration(item.audio.filePath);
        // Total clip duration = audio + silence padding at the end so consecutive
        // scenes get a natural breath between them after concat.
        const clipDuration = audioDuration + tailSilence;
        if (item.videoPath) {
          await renderAnimatedClip(item.videoPath, item.audio.filePath, clipPath, w, h, fps, clipDuration, tailSilence);
        } else {
          const zoomDirection: "in" | "out" = Math.random() < 0.5 ? "in" : "out";
          await renderKenBurnsClip(item.imagePath, item.audio.filePath, clipPath, w, h, fps, clipDuration, zoomDirection, tailSilence);
        }
        log(
          runId,
          "info",
          `Clip #${item.scene.index} (${audioDuration.toFixed(1)}s audio + ${tailSilence}s silence = ${clipDuration.toFixed(1)}s, ${item.videoPath ? "img2vid" : "ken-burns"}) done`,
          { stage: "assemble" }
        );
        return { path: clipPath, durationSec: clipDuration, index: item.scene.index };
      })
    )
  );
  indexed.sort((a, b) => a.index - b.index);
  const clipInfos = indexed.map((c) => ({ path: c.path, durationSec: c.durationSec }));

  // 2. Concat
  const finalPath = path.join(outDir, "final.mp4");
  // Safety: ffmpeg's chained xfade graph holds every input filter in memory.
  // On 200+ scene runs (Resumes especially), this OOMs even on 15GB machines.
  // ASSEMBLE_XFADE_MAX_SCENES caps the count above which we fall back to a
  // plain concat (hard cuts, no transitions, near-zero RAM).
  const xfadeMaxScenes = Number(getSetting("ASSEMBLE_XFADE_MAX_SCENES") || "150");
  const overXfadeCap = xfadeMaxScenes > 0 && clipInfos.length > xfadeMaxScenes;
  if (overXfadeCap && transitionSec > 0) {
    log(
      runId,
      "warn",
      `${clipInfos.length} scenes exceed ASSEMBLE_XFADE_MAX_SCENES (${xfadeMaxScenes}) — using simple concat to avoid ffmpeg OOM. Raise the setting if your machine has plenty of RAM.`,
      { stage: "assemble" }
    );
  }
  if (transitionSec > 0 && clipInfos.length >= 2 && !overXfadeCap) {
    // For large clip counts, split into N chunks and crossfade each chunk
    // in parallel before doing one final crossfade across the chunks.
    // FFmpeg's chained xfade graph is serial (each xfade depends on the
    // previous output), so a single 100-clip xfade can't use multiple cores.
    // Running 4 chunk xfades in parallel saturates a modern CPU.
    const xfadeChunks = Math.max(1, Number(getSetting("ASSEMBLE_XFADE_CHUNKS") || "4"));
    if (xfadeChunks > 1 && clipInfos.length >= xfadeChunks * 3) {
      await concatWithCrossfadeChunked(runId, clipInfos, clipsDir, finalPath, transitionSec, fps, xfadeChunks);
    } else {
      await concatWithCrossfade(clipInfos, finalPath, transitionSec, fps);
      log(runId, "info", `Crossfade ${transitionSec}s across ${clipInfos.length} scenes`, { stage: "assemble" });
    }
  } else {
    await concatSimple(clipInfos.map((c) => c.path), clipsDir, finalPath);
  }

  // Final mastering: normalize delivered audio to the loudness target (shared with the
  // studio pipeline so every render path lands at the same level). Safe no-op if off.
  masterLoudness(runId, finalPath);

  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });
  return finalPath;
}

/** Points fluent-ffmpeg at the resolved ffmpeg/ffprobe (FFMPEG_PATH -> bundled ./bin -> system PATH). */
function ensureFfmpegPaths(): void {
  const ffmpegBin = resolveFfmpeg();
  // Bare "ffmpeg"/"ffprobe" are fluent-ffmpeg's own defaults — only override when
  // we resolved a real path (FFMPEG_PATH or a bundled ./bin binary).
  if (ffmpegBin !== "ffmpeg") ffmpeg.setFfmpegPath(ffmpegBin);
  const ffprobeBin = resolveFfprobe();
  if (ffprobeBin !== "ffprobe" && fs.existsSync(ffprobeBin)) ffmpeg.setFfprobePath(ffprobeBin);
}

/** Reads the exact audio duration via ffprobe. */
function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const d = data.format?.duration;
      if (typeof d !== "number" || !isFinite(d)) {
        // Fallback: estimate from file size
        const stat = fs.statSync(filePath);
        return resolve(Math.max(1, stat.size / 16000));
      }
      resolve(d);
    });
  });
}

/**
 * Best-effort media duration in seconds — safe to call from any pipeline stage.
 *
 * Unlike probeDuration(), this sets the ffmpeg/ffprobe paths first, so it works
 * standalone (e.g. from tts.ts right after a file is written, long before
 * assembleVideo runs). On ANY ffprobe failure it falls back to a rough
 * file-size estimate and never throws.
 */
export async function probeDurationSafe(filePath: string): Promise<number> {
  try {
    ensureFfmpegPaths();
    return await probeDuration(filePath);
  } catch {
    try {
      return Math.max(1, fs.statSync(filePath).size / 16000);
    } catch {
      return 1;
    }
  }
}

/**
 * Ken-Burns clip: still image with a slow zoom plus optional gentle pan.
 * direction = 'in' → 1.0 → 1.18, 'out' → 1.18 → 1.0.
 */
function renderKenBurnsClip(
  imagePath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  direction: "in" | "out",
  tailSilenceSec: number = 0
): Promise<void> {
  const totalFrames = Math.max(2, Math.ceil(durationSec * fps));
  const minZoom = 1.0;
  const maxZoom = 1.18;

  // zoom expression — linear interpolation through `on` (output frame index)
  const zoomExpr =
    direction === "in"
      ? `min(${minZoom}+(${maxZoom}-${minZoom})*on/${totalFrames - 1},${maxZoom})`
      : `max(${maxZoom}-(${maxZoom}-${minZoom})*on/${totalFrames - 1},${minZoom})`;

  // Slight random pan: choose one of 5 trajectories
  const panChoice = Math.floor(Math.random() * 5);
  let xExpr = `iw/2-(iw/zoom/2)`; // center
  let yExpr = `ih/2-(ih/zoom/2)`;
  switch (panChoice) {
    case 1: // top-left → bottom-right drift
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 2: // top-right → bottom-left
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 3: // bottom-left → top-right
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    case 4: // bottom-right → top-left
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    // case 0 — center, no pan
  }

  // Upscale the input ×2 so the zoom doesn't blur
  const filter = `scale=${w * 2}:${h * 2}:flags=lanczos,zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop 1"])
      .input(audioPath)
      .videoFilters(filter);
    // Pad audio with silence at the end so consecutive scenes get a breath.
    if (tailSilenceSec > 0) {
      cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
    }
    cmd
      .outputOptions([
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** img2vid clip: render the Veo clip with its length matched to the TTS audio.
 *
 *  Veo always produces a fixed-length clip (4/6/8 s — capped at 8 s). When the
 *  TTS narration for a scene runs LONGER than the Veo clip we used to loop the
 *  Veo input with `-stream_loop -1` and rely on `-t` to cut. That made the clip
 *  visibly restart from frame 1 around the 7-8 s mark — the "scene replays"
 *  glitch users noticed on long sentences.
 *
 *  New strategy (no more abrupt loop):
 *    1. If audio ≤ video: just cut with `-t` (no transform).
 *    2. If audio overruns up to 1.5×: time-stretch the Veo clip with `setpts`
 *       (subtle slow-motion that documentary viewers won't notice).
 *    3. If audio overruns more: stretch to 1.5× then freeze the LAST frame
 *       via `tpad=stop_mode=clone` for the remaining time. Better than a
 *       jarring restart, and feels like the camera "settling".
 *
 *  Audio comes ONLY from the TTS mp3 (input 1) — Veo's own audio (input 0) is
 *  dropped via explicit -map.
 */
async function renderAnimatedClip(
  videoPath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  tailSilenceSec: number = 0
): Promise<void> {
  const videoDur = await probeDuration(videoPath);

  let videoFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  if (durationSec > videoDur + 0.05) {
    // Drop MAX_STRETCH from 1.5 to 1.15. Past ~1.15 the effective motion FPS
    // drops below ~21 (24 / 1.15) and the image looks juddery — that's the
    // "low FPS / picture jumps" symptom users have complained about.
    // We'd rather freeze the last frame than stretch into ugly slow-mo.
    const MAX_STRETCH = 1.15;
    const stretchFactor = Math.min(durationSec / videoDur, MAX_STRETCH);
    if (stretchFactor > 1.01) {
      // CRITICAL: setpts alone makes ffmpeg space the SAME frames over a
      // longer timeline → effective motion FPS = source_fps / stretchFactor.
      // Pair it with `fps=N` so ffmpeg duplicates frames at the target rate
      // and the playback timing stays uniform. (Real motion interpolation
      // would need `minterpolate`, but that's too slow for batch.)
      videoFilter = `setpts=${stretchFactor.toFixed(3)}*PTS,fps=${fps},${videoFilter}`;
    }
    const stretchedDur = videoDur * stretchFactor;
    const freezeNeeded = Math.max(0, durationSec - stretchedDur);
    if (freezeNeeded > 0.05) {
      videoFilter = `${videoFilter},tpad=stop_mode=clone:stop_duration=${freezeNeeded.toFixed(3)}`;
    }
  }

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .videoFilters(videoFilter);
    if (tailSilenceSec > 0) {
      cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
    }
    cmd
      .outputOptions([
        // Explicit stream mapping — drops Veo's audio even if `mute` didn't work
        "-map", "0:v:0",
        "-map", "1:a:0",
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** Simple stream-copy concat (no transitions). */
function concatSimple(clipPaths: string[], clipsDir: string, finalPath: string): Promise<void> {
  const listFile = path.join(clipsDir, "concat.txt");
  // Escape single quotes for ffmpeg's concat-demuxer line syntax `file '...'`.
  // An apostrophe in the path (e.g. a run titled "Woman's Fountain of Youth")
  // would otherwise terminate the quote early → ffmpeg "No such file".
  fs.writeFileSync(
    listFile,
    clipPaths.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
    "utf-8"
  );
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(finalPath);
  });
}

/**
 * Chunked parallel concat-with-crossfade.
 *
 * Splits clips into N groups, runs one FFmpeg per group in parallel to xfade
 * each group into an intermediate file, then xfades the intermediates into
 * the final output. This parallelizes what is otherwise a serial xfade chain
 * (FFmpeg's xfade filter is single-threaded per pair, and consecutive xfades
 * in one filter_complex are sequentially dependent).
 *
 * On an 8-core CPU, 4 chunks of ~25 clips each gives roughly a 3-4× speedup
 * on the assembly stage versus a monolithic 100-clip xfade chain.
 */
async function concatWithCrossfadeChunked(
  runId: string,
  clips: { path: string; durationSec: number }[],
  clipsDir: string,
  finalPath: string,
  fadeDur: number,
  fps: number,
  chunkCount: number
): Promise<void> {
  // Distribute clips evenly across chunks (no chunk smaller than ~floor(N/chunks))
  const total = clips.length;
  const chunks: { path: string; durationSec: number }[][] = [];
  const baseSize = Math.floor(total / chunkCount);
  const extra = total % chunkCount;
  let cursor = 0;
  for (let i = 0; i < chunkCount; i++) {
    const size = baseSize + (i < extra ? 1 : 0);
    if (size === 0) continue;
    chunks.push(clips.slice(cursor, cursor + size));
    cursor += size;
  }

  log(
    runId,
    "info",
    `Chunked xfade: ${chunks.length} chunks × ~${baseSize}+ clips, running in parallel`,
    { stage: "assemble" }
  );

  // Build each chunk in parallel
  const chunkOutputs: { path: string; durationSec: number }[] = await Promise.all(
    chunks.map(async (chunkClips, idx) => {
      const chunkPath = path.join(clipsDir, `chunk_${String(idx).padStart(2, "0")}.mp4`);
      await concatWithCrossfade(chunkClips, chunkPath, fadeDur, fps);
      // Total duration of a chunk = sum(clip durations) - (N-1) × fadeDur (each xfade overlaps)
      const chunkDuration =
        chunkClips.reduce((s, c) => s + c.durationSec, 0) - (chunkClips.length - 1) * fadeDur;
      log(
        runId,
        "info",
        `Chunk #${idx}: ${chunkClips.length} clips → ${chunkPath} (${chunkDuration.toFixed(1)}s)`,
        { stage: "assemble" }
      );
      return { path: chunkPath, durationSec: chunkDuration };
    })
  );

  log(runId, "info", `Final pass: xfade across ${chunkOutputs.length} chunks`, { stage: "assemble" });

  // Final xfade pass across chunk outputs
  await concatWithCrossfade(chunkOutputs, finalPath, fadeDur, fps);

  // Cleanup intermediate chunk files
  for (const c of chunkOutputs) {
    try {
      fs.unlinkSync(c.path);
    } catch {}
  }
}

/**
 * Concat with xfade transitions between clips.
 * fadeDur — transition length in seconds (e.g. 0.5).
 * On each boundary, the last fadeDur seconds of clip N overlap the first fadeDur of clip N+1.
 */
function concatWithCrossfade(
  clips: { path: string; durationSec: number }[],
  finalPath: string,
  fadeDur: number,
  fps: number
): Promise<void> {
  const cmd = ffmpeg();
  for (const c of clips) cmd.input(c.path);

  // Build filter_complex: chained xfade for video + acrossfade for audio.
  let videoChain = "";
  let audioChain = "";
  let lastV = "0:v";
  let lastA = "0:a";

  // xfade offset = current output length − fade. Clamp the fade per-boundary to
  // min(fadeDur, running output length, next clip length): a clip SHORTER than
  // fadeDur used to drive `offset` negative (overlap starting before the source
  // exists → the decoder shows black frames at the join). Clamping keeps every
  // offset ≥ 0 and every fade within both clips, so a short clip just hard-cuts
  // (tiny fade) instead of tearing to black.
  let runningDur = clips[0].durationSec;
  for (let i = 1; i < clips.length; i++) {
    const eff = Math.max(0, Math.min(fadeDur, runningDur, clips[i].durationSec));
    const offset = Math.max(0, runningDur - eff);
    const vOut = `v${i}`;
    const aOut = `a${i}`;
    videoChain += `[${lastV}][${i}:v]xfade=transition=fade:duration=${eff.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}];`;
    audioChain += `[${lastA}][${i}:a]acrossfade=d=${eff.toFixed(3)}[${aOut}];`;
    runningDur = runningDur + clips[i].durationSec - eff;
    lastV = vOut;
    lastA = aOut;
  }
  // Strip trailing ;
  const filterComplex = (videoChain + audioChain).replace(/;$/, "");

  return new Promise((resolve, reject) => {
    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        `-map [${lastV}]`,
        `-map [${lastA}]`,
        `-r ${fps}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(finalPath);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Single-shot TTS assembly
// ───────────────────────────────────────────────────────────────────────────

/** Per-scene input for single-shot assembly: a Veo clip + its slice range
 *  inside the global continuous voiceover (from Whisper alignment). */
export interface SingleShotInput {
  scene: Scene;
  videoPath: string;
  startMs: number;
  endMs: number;
}

/**
 * Assemble a final video in single-shot TTS mode.
 *
 * Input shape: one continuous voiceover mp3 (synthesised in tts-align.ts)
 * plus per-scene Veo clips and per-scene [startMs, endMs] ranges from Whisper
 * word-alignment.
 *
 * Steps:
 *   1. Render each scene's Veo clip SILENTLY, with duration matched to its
 *      Whisper-aligned slice. Same trim/stretch/freeze policy as the
 *      per-scene path uses (≤1.15× stretch, then last-frame freeze for any
 *      remainder), but no audio in or out.
 *   2. Concatenate the silent clips end-to-end. No xfade — even a small
 *      crossfade would desync the visual timeline against the continuous
 *      audio (audio is one source, video must line up perfectly).
 *   3. Mux the global voiceover onto the concat'd video → final.mp4.
 *
 * Why this exists: per-scene TTS calls each produce a STANDALONE intonation
 * arc. Stitching them creates audible breaks every 4-6 s — the "choppy"
 * report from Bull Network. Synthesising once and aligning visuals to the
 * resulting word timestamps removes those boundaries entirely.
 */
export async function assembleSingleShot(
  runId: string,
  inputs: SingleShotInput[],
  globalAudioPath: string,
  outDir: string
): Promise<string> {
  ensureFfmpegPaths();

  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  log(
    runId,
    "info",
    `Single-shot assembly: ${inputs.length} silent clips → global audio mux (${resolution} @${fps}fps)`,
    { stage: "assemble" }
  );

  // 1. Render silent per-scene clips in parallel, each matched to its slice.
  const limit = pLimit(assembleConcurrency);
  const indexed = await Promise.all(
    inputs.map((item) =>
      limit(async () => {
        const clipPath = path.join(
          clipsDir,
          `clip_${String(item.scene.index).padStart(3, "0")}.mp4`
        );
        const durationSec = Math.max(0.1, (item.endMs - item.startMs) / 1000);
        await renderSilentScene(item.videoPath, clipPath, w, h, fps, durationSec);
        log(
          runId,
          "info",
          `Clip #${item.scene.index} silent ${durationSec.toFixed(2)}s done`,
          { stage: "assemble" }
        );
        return { path: clipPath, durationSec, index: item.scene.index };
      })
    )
  );
  indexed.sort((a, b) => a.index - b.index);

  // 2. Concat silent clips (simple, no xfade — see header comment).
  const silentConcat = path.join(outDir, "silent_concat.mp4");
  await concatSimple(indexed.map((c) => c.path), clipsDir, silentConcat);
  log(runId, "info", `Concatenated ${indexed.length} silent clips into one track`, {
    stage: "assemble",
  });

  // 3. Mux the global voiceover onto the silent concat.
  const finalPath = path.join(outDir, "final.mp4");
  await muxAudioOntoVideo(silentConcat, globalAudioPath, finalPath);
  // Final mastering: normalize delivered audio to the loudness target (shared helper).
  masterLoudness(runId, finalPath);
  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });

  // 4. Clean up the intermediate silent concat.
  try {
    fs.unlinkSync(silentConcat);
  } catch {}

  return finalPath;
}

/**
 * Render ONE scene's Veo clip silently, with duration trimmed / stretched /
 * freeze-padded to match `durationSec`. Same policy as renderAnimatedClip
 * (≤1.15× stretch, then last-frame freeze) but no audio input or output.
 * Audio joins later in the global mux.
 */
async function renderSilentScene(
  videoPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number
): Promise<void> {
  const videoDur = await probeDuration(videoPath);

  let videoFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  if (durationSec > videoDur + 0.05) {
    const MAX_STRETCH = 1.15;
    const stretchFactor = Math.min(durationSec / videoDur, MAX_STRETCH);
    if (stretchFactor > 1.01) {
      videoFilter = `setpts=${stretchFactor.toFixed(3)}*PTS,fps=${fps},${videoFilter}`;
    }
    const stretchedDur = videoDur * stretchFactor;
    const freezeNeeded = Math.max(0, durationSec - stretchedDur);
    if (freezeNeeded > 0.05) {
      videoFilter = `${videoFilter},tpad=stop_mode=clone:stop_duration=${freezeNeeded.toFixed(3)}`;
    }
  }

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .videoFilters(videoFilter)
      .outputOptions([
        "-an", // explicitly drop any audio from the Veo clip
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** Mux: copy video stream from `videoPath`, attach audio from `audioPath`. */
async function muxAudioOntoVideo(
  videoPath: string,
  audioPath: string,
  outPath: string
): Promise<void> {
  // The voiceover is the source of truth for length. If the silent video came
  // out even slightly shorter than the audio (alignment drift, a capped scene,
  // a failed clip), a plain `-shortest` mux would DROP the tail of the
  // narration — that was the "large section of audio missing" bug. So measure
  // both: if the video is short, hold its last frame to cover the gap (needs a
  // video re-encode); otherwise stream-copy the video (fast path).
  const [videoDur, audioDur] = await Promise.all([
    probeDuration(videoPath),
    probeDuration(audioPath),
  ]);
  const gap = audioDur - videoDur;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(videoPath).input(audioPath);
    const out: string[] = ["-map", "0:v:0", "-map", "1:a:0"];
    if (gap > 0.15) {
      // Freeze the last frame past the audio end; -shortest then trims the
      // whole thing back to the (now-shorter) audio → audio is never cut.
      cmd.videoFilters(`tpad=stop_mode=clone:stop_duration=${(gap + 0.5).toFixed(3)}`);
      out.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
    } else {
      out.push("-c:v", "copy");
    }
    out.push("-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart");
    cmd
      .outputOptions(out)
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveFfmpeg } from "../ffmpeg-bin";
import { log } from "../logger";
import type { AvatarBeat } from "./avatar-plan";

/**
 * AVATAR MODE — compositor.
 *
 * Cuts the uploaded talking-head video into beats and composites each beat in
 * one of three layouts over the avatar's OWN audio:
 *   "avatar" → the avatar segment full-screen
 *   "broll"  → full-screen B-roll, avatar audio underneath
 *   "split"  → avatar (left half) + B-roll (right half)
 * Then concatenates the beats into the final MP4.
 *
 * v1 targets a standard 16:9 talking-head (avatar roughly centred). Split
 * geometry (left/right halves, crop) may be refined once we see real HeyGen
 * output, but the graph itself is format-agnostic via scale+crop.
 */

export interface RenderBeat extends AvatarBeat {
  /** Local path to the B-roll clip for this beat. null → render avatar full-screen. */
  brollPath: string | null;
}

const VW = 1920;
const VH = 1080;
const FPS = 30;

function ffmpegBin(): string {
  return resolveFfmpeg();
}

function runFfmpeg(args: string[]): void {
  const r = spawnSync(ffmpegBin(), args, { stdio: "pipe" });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed (rc=${r.status}): ${(r.stderr?.toString() ?? "").slice(-400)}`);
  }
}

const ENCODE = [
  "-r", String(FPS),
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "23",
  "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  "-b:a", "192k",
  "-movflags", "+faststart",
  "-y",
];

/** Render one beat clip (1920x1080 / 30fps / aac) to outPath. */
function renderBeat(avatarPath: string, beat: RenderBeat, outPath: string): void {
  const startSec = (beat.startMs / 1000).toFixed(3);
  const durSec = Math.max(0.2, (beat.endMs - beat.startMs) / 1000).toFixed(3);

  // Avatar full-screen (also the fallback when a B-roll clip is missing).
  if (beat.layout === "avatar" || !beat.brollPath) {
    runFfmpeg([
      "-ss", startSec, "-t", durSec, "-i", avatarPath,
      "-vf", `scale=${VW}:${VH}:force_original_aspect_ratio=increase,crop=${VW}:${VH},setsar=1,fps=${FPS}`,
      "-map", "0:v:0", "-map", "0:a:0", "-t", durSec,
      ...ENCODE, outPath,
    ]);
    return;
  }

  // Full-screen B-roll with the avatar's audio underneath.
  if (beat.layout === "broll") {
    runFfmpeg([
      "-ss", startSec, "-t", durSec, "-i", avatarPath,        // 0: avatar (audio source)
      "-stream_loop", "-1", "-i", beat.brollPath,             // 1: B-roll (looped to fill)
      "-filter_complex",
      `[1:v]scale=${VW}:${VH}:force_original_aspect_ratio=increase,crop=${VW}:${VH},setsar=1,fps=${FPS}[v]`,
      "-map", "[v]", "-map", "0:a:0", "-t", durSec,
      ...ENCODE, outPath,
    ]);
    return;
  }

  // Split: avatar left half, B-roll right half.
  const halfW = Math.round(VW / 2);
  runFfmpeg([
    "-ss", startSec, "-t", durSec, "-i", avatarPath,          // 0: avatar (video + audio)
    "-stream_loop", "-1", "-i", beat.brollPath,               // 1: B-roll
    "-filter_complex",
    `[0:v]scale=${halfW}:${VH}:force_original_aspect_ratio=increase,crop=${halfW}:${VH},setsar=1,fps=${FPS}[l];` +
      `[1:v]scale=${halfW}:${VH}:force_original_aspect_ratio=increase,crop=${halfW}:${VH},setsar=1,fps=${FPS}[r];` +
      `[l][r]hstack=inputs=2[v]`,
    "-map", "[v]", "-map", "0:a:0", "-t", durSec,
    ...ENCODE, outPath,
  ]);
}

/** Composite all beats over the avatar's own audio and concatenate → final.mp4. */
export async function assembleAvatarVideo(
  runId: string,
  avatarPath: string,
  beats: RenderBeat[],
  outDir: string
): Promise<string> {
  const beatsDir = path.join(outDir, "beats");
  fs.mkdirSync(beatsDir, { recursive: true });

  log(runId, "info", `Compositing ${beats.length} beats (avatar / split / broll)`, { stage: "assemble" });

  const clipPaths: string[] = [];
  for (const beat of beats) {
    const clip = path.join(beatsDir, `beat_${String(clipPaths.length).padStart(4, "0")}.mp4`);
    try {
      renderBeat(avatarPath, beat, clip);
      clipPaths.push(clip);
      log(
        runId,
        "info",
        `Beat ${clipPaths.length}/${beats.length} · ${beat.layout} · ${((beat.endMs - beat.startMs) / 1000).toFixed(1)}s`,
        { stage: "assemble" }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Beat ${clipPaths.length + 1} (${beat.layout}) failed: ${msg.slice(0, 150)} — skipped`, {
        stage: "assemble",
      });
    }
  }
  if (clipPaths.length === 0) throw new Error("No beats rendered — cannot assemble avatar video");

  // Concat (every beat is encoded with identical params → stream copy is safe).
  const listFile = path.join(beatsDir, "concat.txt");
  fs.writeFileSync(
    listFile,
    clipPaths.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
    "utf-8"
  );
  const finalPath = path.join(outDir, "final.mp4");
  runFfmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", "-y", finalPath]);

  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });
  return finalPath;
}

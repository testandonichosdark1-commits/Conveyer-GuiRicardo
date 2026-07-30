import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { resolveFfmpeg } from "../ffmpeg-bin";

/**
 * Ken Burns — turn a STILL image into an N-second motion clip with a slow,
 * smooth zoom (alternating in/out by index for variety).
 *
 * The key anti-jitter trick (confirmed in research): pre-upscale the source very
 * large (`scale=8000:-1`) before zoompan, so each frame's motion is many pixels
 * and zoompan's integer-pixel rounding is invisible. `format=yuv420p` is
 * mandatory for browser/QuickTime playback. See docs/DESIGN.md.
 */

function ffmpegBin(): string {
  return resolveFfmpeg();
}

export function parseResolution(res: string | undefined): { w: number; h: number } {
  const m = (res || "").match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1920, h: 1080 };
}

/**
 * Render `imagePath` → `outPath` as a `durationSec` clip with a gentle zoom.
 * `zoomOut` flips the direction (pull back instead of push in).
 * `resolutionStr` ("WxH") overrides the global VIDEO_RESOLUTION when provided.
 */
export function kenBurns(
  imagePath: string,
  outPath: string,
  durationSec: number,
  zoomOut = false,
  resolutionStr?: string
): void {
  const { w, h } = parseResolution(resolutionStr || getSetting("VIDEO_RESOLUTION") || "1920x1080");
  const fps = Math.max(1, Number(getSetting("VIDEO_FPS") || "30"));
  const dur = Math.max(0.5, durationSec);
  const frames = Math.max(1, Math.round(dur * fps));

  // Duration-scaled zoom: the old fixed +0.0015/frame hit the 1.5 cap at ~333 frames
  // (~11s @30fps) and then FROZE for the rest of a long beat — a ~20s still zoomed for
  // 11s and sat static for 9s. Drive the zoom off `on` (output frame index, 0..frames-1)
  // and spread a gentle RANGE across the WHOLE clip so it moves end-to-end at any length.
  // RANGE≈0.18 matches the old short-beat feel (a 4s beat used to reach ~1.18).
  const RANGE = 0.18;
  const step = RANGE / Math.max(1, frames - 1);
  const z = zoomOut
    ? `z='max(${(1 + RANGE).toFixed(4)}-on*${step.toFixed(6)},1.0)'`
    : `z='min(1.0+on*${step.toFixed(6)},${(1 + RANGE).toFixed(4)})'`;
  const filter =
    `scale=8000:-1,zoompan=${z}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps},format=yuv420p`;

  const r = spawnSync(
    ffmpegBin(),
    [
      "-loop", "1",
      "-framerate", String(fps),
      "-i", imagePath,
      "-t", dur.toFixed(3),
      "-filter_complex", filter,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-t", dur.toFixed(3),
      "-an",
      "-movflags", "+faststart",
      "-y", outPath,
    ],
    { stdio: "pipe" }
  );
  if (r.status !== 0) {
    throw new Error(`Ken Burns ffmpeg failed (rc=${r.status}): ${(r.stderr?.toString() ?? "").slice(-400)}`);
  }
}

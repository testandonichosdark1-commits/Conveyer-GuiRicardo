import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { resolveFfmpeg } from "../ffmpeg-bin";

/**
 * Ken Burns — turn a STILL image into an N-second motion clip with a slow,
 * smooth zoom (alternating in/out by index for variety).
 *
 * The anti-jitter trick: pre-upscale before zoompan, so each frame's motion is many
 * pixels and zoompan's integer-pixel rounding is invisible. `format=yuv420p` is
 * mandatory for browser/QuickTime playback. See docs/DESIGN.md.
 *
 * ── The filter ORDER is the load-bearing part ────────────────────────────────────
 *
 * `zoompan`'s `s=WxH` does not letterbox and does not crop: it STRETCHES its window
 * into that size. So the source must already be at the output aspect by the time it
 * gets there, or every still that isn't 16:9 is rendered anamorphically — measured at
 * 2.667x on an ordinary 2:3 portrait photo (a circle came out an ellipse). Fur, hair
 * and any fine texture smear along the squashed axis, which reads as "low quality
 * upscale" rather than as distortion, so it hid here for months.
 *
 * Hence: crop to the target aspect FIRST, at native resolution, and only then scale.
 * Cover-crop (not pillarbox) matches what studio-assemble does for every other source.
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
/**
 * The filter chain, built separately so a test can assert its SHAPE without running
 * ffmpeg. The order is the thing that matters and the thing that regressed before
 * (see the note at the top of this file), and a string is the only place it is visible.
 */
export function kenBurnsFilter(
  w: number,
  h: number,
  frames: number,
  fps: number,
  zoomOut: boolean
): string {
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
  // 1. Cover-crop to the output aspect at NATIVE resolution — the whole point (see above).
  //    Centred (crop's default x/y), keeping the largest rectangle of the right shape.
  const cover = `crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})'`;
  // 2. Zoompan headroom. The old `scale=8000:-1` was fixed and output-blind: on a 2772x4158
  //    photo it built a 8000x12000 (96 MP) intermediate to feed a 1920x1080 filter, paying
  //    for a huge resample twice over. Three times the output width is past the point where
  //    zoompan's rounding shows, and it scales with the channel's resolution instead of
  //    ignoring it. `-2` keeps the height even for yuv420p; lanczos beats the default bicubic.
  const headroom = `scale=${w * 3}:-2:flags=lanczos`;
  return `${cover},${headroom},zoompan=${z}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps},format=yuv420p`;
}

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
  const filter = kenBurnsFilter(w, h, frames, fps, zoomOut);

  const r = spawnSync(
    ffmpegBin(),
    [
      "-loop", "1",
      "-framerate", String(fps),
      "-i", imagePath,
      "-t", dur.toFixed(3),
      "-filter_complex", filter,
      "-c:v", "libx264",
      // This clip is an INTERMEDIATE: studio-assemble re-encodes it into the beat, so its
      // artifacts get baked in and then compressed a second time. Spending bits here is
      // what stops fine texture dissolving over two generations; the file is transient.
      "-preset", "medium",
      "-crf", "16",
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

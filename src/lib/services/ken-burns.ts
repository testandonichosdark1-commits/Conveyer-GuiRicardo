import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { resolveFfmpeg, resolveFfprobe } from "../ffmpeg-bin";

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
/**
 * How a still moves. "in"/"out" are the original push-in / pull-back (centred). "up" holds a
 * fixed zoom and tilts from the bottom of the picture to the top (hands → face on a portrait);
 * "pan" holds a fixed zoom and slides left → right. Archive style cycles all four per beat.
 */
export type KenBurnsMotion = "in" | "out" | "up" | "pan";

export interface KenBurnsOptions {
  /** Total zoom across the clip (0.18 = 18%). Default 0.18. */
  range?: number;
  /** Overrides `zoomOut` when set. */
  motion?: KenBurnsMotion;
  /** Bias the cover-crop toward the TOP of the source (portraits: keep the face, not the chest). */
  topBias?: boolean;
}

const DEFAULT_RANGE = 0.18;
const MOTION_CYCLE: readonly KenBurnsMotion[] = ["in", "out", "up", "pan"];

/** The motion for a beat in "varied" mode — a fixed cycle, so a resumed run moves identically. */
export function variedMotion(beatIndex: number): KenBurnsMotion {
  const i = Math.abs(Math.trunc(beatIndex)) % MOTION_CYCLE.length;
  return MOTION_CYCLE[i];
}

export function kenBurnsFilter(
  w: number,
  h: number,
  frames: number,
  fps: number,
  zoomOut: boolean,
  opts?: KenBurnsOptions
): string {
  // Duration-scaled zoom: the old fixed +0.0015/frame hit the 1.5 cap at ~333 frames
  // (~11s @30fps) and then FROZE for the rest of a long beat — a ~20s still zoomed for
  // 11s and sat static for 9s. Drive the zoom off `on` (output frame index, 0..frames-1)
  // and spread a gentle RANGE across the WHOLE clip so it moves end-to-end at any length.
  // RANGE≈0.18 matches the old short-beat feel (a 4s beat used to reach ~1.18).
  const r = opts?.range;
  const RANGE = typeof r === "number" && Number.isFinite(r) && r > 0 && r <= 1 ? r : DEFAULT_RANGE;
  const last = Math.max(1, frames - 1);
  const step = RANGE / last;
  const motion: KenBurnsMotion = opts?.motion ?? (zoomOut ? "out" : "in");
  const held = `z='${(1 + RANGE).toFixed(4)}'`;
  const z =
    motion === "out"
      ? `z='max(${(1 + RANGE).toFixed(4)}-on*${step.toFixed(6)},1.0)'`
      : motion === "in"
        ? `z='min(1.0+on*${step.toFixed(6)},${(1 + RANGE).toFixed(4)})'`
        : held;
  // Tilt-up: start at the bottom edge of the zoomed window and end at the top.
  const xExpr = motion === "pan" ? `'(iw-iw/zoom)*on/${last}'` : `'iw/2-(iw/zoom/2)'`;
  const yExpr = motion === "up" ? `'(ih-ih/zoom)*(1-on/${last})'` : `'ih/2-(ih/zoom/2)'`;
  // 1. Cover-crop to the output aspect at NATIVE resolution — the whole point (see above).
  //    Centred (crop's default x/y), keeping the largest rectangle of the right shape.
  //    topBias keeps the upper part of a portrait (where the face is) instead of its middle.
  const cover =
    `crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})'` + (opts?.topBias ? `:'(iw-ow)/2':'(ih-oh)*0.2'` : "");
  // 2. Zoompan headroom. The old `scale=8000:-1` was fixed and output-blind: on a 2772x4158
  //    photo it built a 8000x12000 (96 MP) intermediate to feed a 1920x1080 filter, paying
  //    for a huge resample twice over. Three times the output width is past the point where
  //    zoompan's rounding shows, and it scales with the channel's resolution instead of
  //    ignoring it. `-2` keeps the height even for yuv420p; lanczos beats the default bicubic.
  const headroom = `scale=${w * 3}:-2:flags=lanczos`;
  return `${cover},${headroom},zoompan=${z}:x=${xExpr}:y=${yExpr}:d=${frames}:s=${w}x${h}:fps=${fps},format=yuv420p`;
}

/**
 * Extra seconds rendered past the beat when crossfades are on: the NEXT beat dissolves out of
 * this clip's continuation, so the motion keeps flowing under the dissolve instead of freezing.
 * 0 unless SCENE_TRANSITIONS=crossfade. Exported so the compositor uses the same number.
 */
export function crossfadeTailSec(): number {
  if ((getSetting("SCENE_TRANSITIONS") || "").trim().toLowerCase() !== "crossfade") return 0;
  const ms = Number(getSetting("SCENE_TRANSITION_MS") || "400");
  return Number.isFinite(ms) ? Math.min(1.5, Math.max(0, ms / 1000)) : 0.4;
}

/** Source image size via ffprobe, or null. Used only by the archive look (portrait top-bias). */
function probeImageSize(imagePath: string): { w: number; h: number } | null {
  try {
    const r = spawnSync(resolveFfprobe(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", imagePath], { encoding: "utf8", timeout: 15000 });
    const m = (r.stdout || "").trim().match(/^(\d+)x(\d+)/);
    return r.status === 0 && m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

/**
 * `beatIndex` is passed only by callers that know the beat (animateStill). Without it — and
 * with nothing configured — this is byte-for-byte the original command.
 */
export function kenBurns(
  imagePath: string,
  outPath: string,
  durationSec: number,
  zoomOut = false,
  resolutionStr?: string,
  beatIndex?: number
): void {
  const { w, h } = parseResolution(resolutionStr || getSetting("VIDEO_RESOLUTION") || "1920x1080");
  const fps = Math.max(1, Number(getSetting("VIDEO_FPS") || "30"));
  const dur = Math.max(0.5, durationSec) + crossfadeTailSec();
  const frames = Math.max(1, Math.round(dur * fps));
  const rangeRaw = getSetting("KEN_BURNS_RANGE");
  const range = rangeRaw ? Number(rangeRaw) : undefined;
  const varied = (getSetting("KEN_BURNS_MOTION") || "").trim().toLowerCase() === "varied" && beatIndex !== undefined;
  let opts: KenBurnsOptions | undefined;
  if (varied || (range !== undefined && Number.isFinite(range) && range !== DEFAULT_RANGE)) {
    opts = { range };
    if (varied) {
      opts.motion = variedMotion(beatIndex!);
      const src = probeImageSize(imagePath);
      opts.topBias = src !== null && src.h >= src.w; // portrait/square source → keep the face
    }
  }
  const filter = kenBurnsFilter(w, h, frames, fps, zoomOut, opts);

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

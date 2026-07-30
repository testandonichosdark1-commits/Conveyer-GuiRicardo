import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { resolveFfmpeg } from "../ffmpeg-bin";
import { log } from "../logger";

/**
 * Final loudness MASTERING step (the ONLY audio-level stage in the pipeline).
 *
 * Every pipeline renders its narration at the TTS provider's native level with no
 * normalization, so the delivered video is as quiet (or loud) as the provider happened
 * to output — typically well below the YouTube/broadcast reference (~-14 LUFS), which
 * YouTube will NOT boost. This normalizes the FINISHED video's audio to
 * AUDIO_TARGET_LUFS with TWO-PASS `linear` loudnorm:
 *   pass 1 measures integrated loudness; pass 2 applies a single constant gain.
 * Because the gain is constant (linear), an already-correct track is left unchanged
 * (0 dB), a quiet track is boosted, and a loud track is reduced — all true-peak limited
 * to -1.5 dBTP so it can never clip. Video is stream-copied (no re-encode).
 *
 * Called once, at the end of each assembler (studio-assemble, video-assemble). OFF when
 * AUDIO_LOUDNORM != "1". Any measurement/encode failure is a safe no-op that keeps the
 * original file, so mastering can never break a render.
 */

const TP = "-1.5";
const LRA = "11";

function ffmpegBin(): string {
  return resolveFfmpeg();
}

/** Target integrated loudness (LUFS). Must be negative; falls back to -14 (YouTube ref). */
function targetLufs(): number {
  const n = Number(getSetting("AUDIO_TARGET_LUFS"));
  return Number.isFinite(n) && n < 0 ? n : -14;
}

interface Measured {
  i: string;
  tp: string;
  lra: string;
  thresh: string;
  offset: string;
}

/** loudnorm analysis pass — returns the measured params, or null if unmeasurable. */
function measure(ff: string, srcPath: string, target: number): Measured | null {
  const r = spawnSync(
    ff,
    // `-vn`: the analysis pass only measures audio — skip decoding the video entirely
    // (measurably faster on long/HD renders; video is untouched anyway).
    ["-hide_banner", "-vn", "-i", srcPath, "-af", `loudnorm=I=${target}:TP=${TP}:LRA=${LRA}:print_format=json`, "-f", "null", "-"],
    { encoding: "utf8", timeout: 600000 }
  );
  const out = `${r.stderr ?? ""}${r.stdout ?? ""}`;
  const g = (k: string) => out.match(new RegExp(`"${k}"\\s*:\\s*"(-?[0-9.]+|-?inf)"`))?.[1];
  const i = g("input_i");
  const tp = g("input_tp");
  const lra = g("input_lra");
  const thresh = g("input_thresh");
  const offset = g("target_offset");
  if (!i || !tp || !lra || !thresh || offset === undefined) return null;
  // Silent / degenerate audio reports -inf — skip (nothing to normalize).
  if (![i, tp, lra, thresh].every((v) => Number.isFinite(Number(v)))) return null;
  return { i, tp, lra, thresh, offset };
}

/** Normalize `finalPath`'s audio to AUDIO_TARGET_LUFS in place. Safe no-op on any failure. */
export function masterLoudness(runId: string, finalPath: string): void {
  if ((getSetting("AUDIO_LOUDNORM") || "1").trim() !== "1") return;
  const ff = ffmpegBin();
  const target = targetLufs();

  const m = measure(ff, finalPath, target);
  if (!m) {
    log(runId, "warn", "Loudness master skipped — audio unmeasurable (left at source level)", { stage: "assemble" });
    return;
  }

  const tmp = finalPath.replace(/\.mp4$/i, ".loudnorm.mp4");
  const filter =
    `loudnorm=I=${target}:TP=${TP}:LRA=${LRA}:` +
    `measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true`;
  const r = spawnSync(
    ff,
    [
      "-hide_banner", "-y",
      "-i", finalPath,
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "copy",
      "-af", filter,
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
      "-movflags", "+faststart",
      tmp,
    ],
    { stdio: "pipe" }
  );
  if (r.status !== 0) {
    try { fs.unlinkSync(tmp); } catch {}
    log(runId, "warn", `Loudness master failed (rc=${r.status}) — keeping source-level audio: ${(r.stderr?.toString() ?? "").slice(-200)}`, { stage: "assemble" });
    return;
  }
  try {
    fs.renameSync(tmp, finalPath);
  } catch {
    try { fs.copyFileSync(tmp, finalPath); fs.unlinkSync(tmp); } catch {}
  }
  log(runId, "info", `Loudness master: ${m.i} → ${target} LUFS (two-pass linear)`, { stage: "assemble" });
}

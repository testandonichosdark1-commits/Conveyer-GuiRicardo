import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveFfmpeg } from "../ffmpeg-bin";
import { getSetting } from "../settings";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import { alignWords, type Voiceover } from "./elevenlabs-voiceover";
import { probeAudioStrict } from "./video-assemble";

/**
 * VOICEOVER FROM A FILE — the upload-mode counterpart to synthesizeVoiceover().
 *
 * Both produce the SAME `Voiceover` { filePath, durationSec, words }, which is the single
 * seam the studio pipeline consumes. Everything downstream — beat planning, avatar audio
 * slicing, assembly, Resume — already treats the audio as opaque, so swapping the source
 * changes nothing after this point.
 *
 *   synthesizeVoiceover(script) → TTS → mp3 → alignWords → Voiceover
 *   voiceoverFromFile(upload)   →       mp3 → alignWords → Voiceover
 *
 * Two invariants this module exists to guarantee:
 *
 * 1. The output is ALWAYS `<outDir>/voiceover.mp3`. That exact filename is load-bearing:
 *    canResumeStudioRun() and resumeStudioPipeline() look for it by name, so normalizing
 *    here is what makes an upload-sourced run resumable with zero changes to Resume.
 *
 * 2. Timings are real or the run fails. There is no script to fall back on, and
 *    proportionalWords() would return [] for an empty one anyway — but more importantly,
 *    fabricated evenly-spaced timings are exactly the defect that made every pre-Groq
 *    non-ElevenLabs run drift. Better a clear failure than a silently desynced video.
 *
 * This module does NOT create runs, read the DB, or touch the planner. It is called by the
 * pipeline in a later stage.
 */

/** Transcode any decodable input to the canonical master mp3. `-vn` lets a video file work too. */
function transcodeToMasterMp3(srcPath: string, outPath: string): void {
  const ff = resolveFfmpeg();
  const r = spawnSync(
    ff,
    ["-y", "-i", srcPath, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", outPath],
    { stdio: "pipe" }
  );
  if (r.status !== 0) {
    const detail = (r.stderr?.toString() || "").trim().split("\n").slice(-2).join(" ").slice(0, 200);
    throw new Error(`Could not decode the uploaded audio${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Build a `Voiceover` from an operator-supplied audio file.
 *
 * @param srcPath  the staged upload (already format-validated at upload time)
 * @param outDir   the run's audio directory; the master lands at <outDir>/voiceover.mp3
 */
export async function voiceoverFromFile(runId: string, srcPath: string, outDir: string): Promise<Voiceover> {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Uploaded voiceover not found on disk: ${srcPath}`);
  }
  // Fail BEFORE the transcode: without Whisper there is no way to time an uploaded
  // voiceover, and the run would only die later having done more work for nothing.
  if (!getSetting("GROQ_API_KEY").trim()) {
    throw new Error(
      "Transcription requires a Groq API key — an uploaded voiceover has no script to time against. Add GROQ_API_KEY in Settings."
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "voiceover.mp3");
  log(runId, "info", `Ingesting uploaded voiceover (${path.basename(srcPath)})`, { stage: "voiceover" });
  transcodeToMasterMp3(srcPath, outPath);

  // Duration comes from the TRANSCODED master, never the upload: a truncated source can
  // declare a longer duration in its header than it actually contains, and every beat
  // timing is derived from this number.
  const { durationSec } = await probeAudioStrict(outPath);

  checkCancelled(runId); // don't start a billable transcription for a cancelled run
  // "" as the script: the Whisper branch never reads it, and the proportional fallback
  // must NOT produce anything here — see the zero-words guard below.
  const words = await alignWords(runId, outPath, "", durationSec);
  if (words.length === 0) {
    throw new Error(
      "No speech was detected in the uploaded audio. Check that the file contains spoken narration (not music or silence), and that the Groq API key is valid."
    );
  }

  log(runId, "success", `Uploaded voiceover ready: ${durationSec.toFixed(1)}s, ${words.length} words timed`, {
    stage: "voiceover",
  });
  return { filePath: outPath, durationSec, words };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { resolveFfmpeg } from "../ffmpeg-bin";
import { log } from "../logger";

/**
 * Media transcription for AVATAR MODE.
 *
 * The user uploads a finished talking-head MP4 (e.g. a HeyGen avatar video).
 * We transcribe its narration into timestamped segments so the avatar planner
 * can decide, per segment, what to show on screen (avatar full / split / B-roll)
 * and the assembler can cut visuals to the avatar's own speech.
 *
 * Uses Groq Whisper (whisper-large-v3) — the same engine single-shot TTS uses.
 * We first extract a small mono mp3 with ffmpeg so even a long HD video stays
 * well under Groq's 25 MB upload limit (a few minutes of speech ≈ 1-3 MB).
 */

export interface TranscriptSegment {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface MediaTranscript {
  segments: TranscriptSegment[];
  durationSec: number;
}

/** Extract a small mono 16 kHz mp3 from any media file (video or audio). */
function extractAudio(inputPath: string, outPath: string): void {
  const ffmpegBin = resolveFfmpeg();
  const r = spawnSync(
    ffmpegBin,
    ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", outPath],
    { stdio: "pipe" }
  );
  if (r.status !== 0) {
    throw new Error(
      `ffmpeg audio extract failed (rc=${r.status}): ${r.stderr?.toString().slice(-300)}`
    );
  }
}

/**
 * Transcribe a media file into timestamped segments via Groq Whisper.
 * Returns sentence-level segments (start/end ms + text) plus total duration.
 */
export async function transcribeMedia(filePath: string, runId?: string): Promise<MediaTranscript> {
  const apiKey = getSetting("GROQ_API_KEY");
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not set — required to transcribe the avatar video. Paste it in /settings."
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Avatar media not found on disk: ${filePath}`);
  }

  const tmpAudio = path.join(os.tmpdir(), `transcribe-${process.pid}-${path.basename(filePath)}.mp3`);
  if (runId) log(runId, "info", `Extracting audio for transcription`, { stage: "transcribe" });
  extractAudio(filePath, tmpAudio);

  try {
    const buffer = fs.readFileSync(tmpAudio);
    const blob = new Blob([buffer], { type: "audio/mpeg" });
    const fd = new FormData();
    fd.append("file", blob, "audio.mp3");
    fd.append("model", "whisper-large-v3");
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "segment");

    if (runId) {
      log(runId, "info", `Transcribing with Groq Whisper (whisper-large-v3)`, { stage: "transcribe" });
    }
    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!r.ok) {
      throw new Error(`Groq Whisper ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
    const json = (await r.json()) as {
      segments?: { start: number; end: number; text: string }[];
      duration?: number;
    };
    const rawSegs = Array.isArray(json.segments) ? json.segments : [];
    const segments: TranscriptSegment[] = rawSegs
      .map((s, i) => ({
        index: i,
        startMs: Math.round((s.start ?? 0) * 1000),
        endMs: Math.round((s.end ?? 0) * 1000),
        text: (s.text ?? "").trim(),
      }))
      .filter((s) => s.text.length > 0)
      .map((s, i) => ({ ...s, index: i }));

    const lastEndMs = segments.length > 0 ? segments[segments.length - 1].endMs : 0;
    const durationSec = typeof json.duration === "number" ? json.duration : lastEndMs / 1000;

    if (runId) {
      log(runId, "success", `Transcript: ${segments.length} segments · ${durationSec.toFixed(1)}s`, {
        stage: "transcribe",
      });
    }
    return { segments, durationSec };
  } finally {
    try {
      fs.unlinkSync(tmpAudio);
    } catch {}
  }
}

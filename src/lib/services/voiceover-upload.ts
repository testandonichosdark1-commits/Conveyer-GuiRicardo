import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../run-paths";
import { getSetting } from "../settings";
import { probeAudioStrict, AudioProbeError, type AudioProbe } from "./video-assemble";

/**
 * VOICEOVER UPLOAD — staging + validation.
 *
 * An operator can supply a finished narration instead of having us synthesize one. The
 * file is streamed to a staging area BEFORE any run row exists, so a rejection costs
 * nothing: no run, no voiceover spend, no HeyGen call. Only a validated upload is later
 * consumed by the pipeline (a separate stage — nothing here starts a run).
 *
 * The validation logic lives here rather than in the route handler so it can be unit
 * tested without an HTTP server.
 */

/** Staging area for uploads awaiting a run. Outside the repo, beside the DB. */
export function uploadsDir(): string {
  const dir = path.join(DATA_DIR, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Extension for a staged upload, taken from the client's filename.
 *
 * Purely cosmetic — ffmpeg/ffprobe sniff the real container, so a wrong or missing
 * extension changes nothing about whether the file is accepted. We keep a known one
 * only so the staged file is recognizable on disk; anything unknown becomes ".bin".
 */
const KNOWN_AUDIO_EXT = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".webm", ".mp4", ".mov", ".mkv", ".wma", ".aiff", ".aif",
]);
export function extForUpload(filename: string | null | undefined): string {
  const ext = path.extname((filename || "").trim()).toLowerCase();
  return KNOWN_AUDIO_EXT.has(ext) ? ext : ".bin";
}

/** A v4-shaped UUID, the only thing we will ever look up in the staging directory. */
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a client-supplied uploadId to its staged file, or null if it isn't there.
 *
 * The id comes straight from a request body, so it is matched against a strict UUID
 * pattern BEFORE touching the filesystem: that is what stops "../../etc/passwd" (or any
 * other traversal) from ever being joined onto the staging path. The extension is
 * discovered by listing the directory rather than trusted from input.
 */
export function resolveStagedUpload(uploadId: string): string | null {
  const id = (uploadId || "").trim();
  if (!UPLOAD_ID_RE.test(id)) return null;
  const dir = uploadsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const match = entries.find((f) => f.startsWith(`${id}.`));
  return match ? path.join(dir, match) : null;
}

/** Upload ceiling in seconds, from UPLOAD_MAX_MINUTES (see the settings comment for why 50). */
export function maxUploadSeconds(): number {
  const min = Number(getSetting("UPLOAD_MAX_MINUTES"));
  return (Number.isFinite(min) && min > 0 ? min : 50) * 60;
}

/** "45s" · "2m 14s" · "1h 12m" — for messages a non-technical operator reads. */
export function formatDurationHuman(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export type UploadRejection =
  | "empty"
  | "unreadable"
  | "no_audio_stream"
  | "no_duration"
  | "too_long";

export type ValidationResult =
  | { ok: true; probe: AudioProbe }
  | { ok: false; reason: UploadRejection; error: string };

/**
 * Validate a staged audio file. Never throws — every failure is a typed rejection with a
 * message written for the operator, not a stack trace.
 *
 * Uses probeAudioStrict (not probeDurationSafe): the safe probe invents a duration from
 * file size for unreadable input, which would let a renamed text file through this gate.
 */
export async function validateUploadedAudio(filePath: string): Promise<ValidationResult> {
  // A zero-byte upload is its own case: ffprobe would just say "unreadable", but the real
  // cause is a failed/empty transfer and the operator should be told exactly that.
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { ok: false, reason: "empty", error: "The uploaded file could not be read from disk." };
  }
  if (size === 0) {
    return { ok: false, reason: "empty", error: "The uploaded file was empty." };
  }

  let probe: AudioProbe;
  try {
    probe = await probeAudioStrict(filePath);
  } catch (e) {
    if (e instanceof AudioProbeError) {
      switch (e.reason) {
        case "no_audio_stream":
          return { ok: false, reason: "no_audio_stream", error: "This file has no audio track — upload a voiceover, not a silent video." };
        case "no_duration":
          return { ok: false, reason: "no_duration", error: "This file's duration could not be determined — it may be corrupt." };
        default:
          return { ok: false, reason: "unreadable", error: "This file could not be read as audio — it may be corrupt, or not an audio file." };
      }
    }
    return { ok: false, reason: "unreadable", error: "This file could not be read as audio." };
  }

  const maxSec = maxUploadSeconds();
  if (probe.durationSec > maxSec) {
    return {
      ok: false,
      reason: "too_long",
      // Says both numbers: "too long" alone leaves the operator guessing by how much.
      error: `That audio is ${formatDurationHuman(probe.durationSec)}. The maximum is ${formatDurationHuman(maxSec)}.`,
    };
  }

  return { ok: true, probe };
}

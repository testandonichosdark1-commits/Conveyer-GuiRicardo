import path from "node:path";
import { getSetting } from "../settings";
import { log } from "../logger";
import { probeDurationSafe } from "./video-assemble";
import { generateSpeech, alignLocally } from "./voicebox-client";
import { alignWords, type Voiceover, type WordTiming } from "./elevenlabs-voiceover";

/**
 * Full-script narration via Voicebox (free, local TTS + voice cloning,
 * github.com/jamiepine/voicebox). Selected via VOICEOVER_PROVIDER=voicebox.
 *
 * Unlike ElevenLabs, Voicebox's /generate returns audio only — no word-level
 * timestamps — so word timing is recovered AFTER synthesis via a fallback
 * chain: local faster-whisper (free, set up by `npm run setup:voicebox`)
 * → Groq Whisper (free tier, needs GROQ_API_KEY, shared with the other
 * non-ElevenLabs providers via elevenlabs-voiceover.ts's alignWords) → an
 * even proportional split across the audio duration (always available).
 */

/**
 * Synthesizes the whole script as one Voicebox performance and recovers word
 * timings. `opts.voiceOverride` is a Voicebox profile id (per-run/channel
 * pick); falls back to the global VOICEBOX_PROFILE_ID default.
 */
export async function synthesizeVoicebox(
  runId: string,
  script: string,
  outDir: string,
  opts: { voiceOverride?: string | null } = {}
): Promise<Voiceover> {
  const profileId = opts.voiceOverride?.trim() || getSetting("VOICEBOX_PROFILE_ID");
  if (!profileId) {
    throw new Error(
      "No Voicebox voice profile selected — set VOICEBOX_PROFILE_ID in /settings, or pick one on /voices."
    );
  }

  log(runId, "info", `Voicebox voiceover (profile ${profileId})`, { stage: "voiceover" });
  const outPath = path.join(outDir, "voiceover.mp3");
  const text = script.trim();
  const { durationSec: reportedDuration } = await generateSpeech(profileId, text, outPath);
  const durationSec = reportedDuration > 0 ? reportedDuration : await probeDurationSafe(outPath);

  const words = await alignVoiceboxWords(runId, outPath, text, durationSec);
  log(runId, "success", `Voiceover ready: ${durationSec.toFixed(1)}s, ${words.length} words timed`, {
    stage: "voiceover",
  });
  return { filePath: outPath, durationSec, words };
}

/**
 * Recover per-word timings for a Voicebox mp3. Prefers the local (free)
 * faster-whisper pass — set up via `npm run setup:voicebox` — before falling
 * back to the shared Groq Whisper / proportional-split chain used by the
 * other non-ElevenLabs providers.
 */
async function alignVoiceboxWords(runId: string, mp3Path: string, script: string, durationSec: number): Promise<WordTiming[]> {
  const local = await alignLocally(mp3Path);
  if (local && local.length > 0) {
    log(runId, "info", `Voicebox word timing via local faster-whisper (${local.length} words)`, { stage: "voiceover" });
    return local;
  }
  return alignWords(runId, mp3Path, script, durationSec);
}

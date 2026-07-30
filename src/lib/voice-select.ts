/**
 * Per-pipeline resolution of the voice id stored on a run (`runs.preset_voice_id`).
 *
 * That column is OVERLOADED — it means different things depending on which
 * pipeline consumes the run, so the two cases are centralized here (and covered by
 * voice-select.test.ts) to keep them from being re-crossed by a future refactor:
 *
 *  - The STUDIO pipeline narrates with ElevenLabs, so its stored voice may ONLY be
 *    an ElevenLabs voice (a channel's `voice_id`). A preset's HeyGen voice must
 *    never land here — sending a HeyGen id to ElevenLabs returns `voice_not_found`.
 *    null → the pipeline falls back to the global ELEVENLABS_VOICE_ID setting.
 *
 *  - The LEGACY pipeline drives `TTS_PROVIDER` (default HeyGen), where the preset's
 *    HeyGen voice (`heygen_voice_id`) is exactly the right value.
 */

/** Voice stored on a run for the ElevenLabs-narrated studio pipeline. */
export function studioRunVoiceId(channel?: { voice_id?: string | null } | null): string | null {
  return channel?.voice_id?.trim() || null;
}

/** Voice stored on a run for the legacy TTS_PROVIDER pipeline (HeyGen by default). */
export function legacyRunVoiceId(preset?: { heygen_voice_id?: string | null } | null): string | null {
  return preset?.heygen_voice_id?.trim() || null;
}

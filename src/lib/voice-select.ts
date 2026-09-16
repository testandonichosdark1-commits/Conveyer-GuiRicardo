/**
 * Per-pipeline resolution of the voice id stored on a run (`runs.preset_voice_id`).
 *
 * That column is OVERLOADED — it means different things depending on which
 * pipeline consumes the run, so the two cases are centralized here (and covered by
 * voice-select.test.ts) to keep them from being re-crossed by a future refactor:
 *
 *  - The STUDIO pipeline stores the CHANNEL's `voice_id`, never a preset's HeyGen voice
 *    (sending a HeyGen id to a narration provider returns `voice_not_found`).
 *    null → the pipeline falls back to that provider's global voice setting.
 *
 *    CAUTION — this value is PROVIDER-BLIND. The studio pipeline no longer always
 *    narrates with ElevenLabs: it narrates with whatever VOICEOVER_PROVIDER is set to
 *    (ElevenLabs, AI84, Fish Audio, Hume, GenAIPro…), and this one column is handed to
 *    ALL of them — where it WINS over that provider's own global voice setting. So a
 *    channel voice_id entered while one provider was selected is silently sent to the
 *    next one. The /channels field's LABEL follows the provider (providerVoiceLabel);
 *    its CONTENT does not. That mismatch is how an AI84 run was sent an id belonging to
 *    a different provider and died mid-run on a voice rejection. Callers must not assume
 *    the value is an ElevenLabs id.
 *
 *  - The LEGACY pipeline drives `TTS_PROVIDER` (default HeyGen), where the preset's
 *    HeyGen voice (`heygen_voice_id`) is exactly the right value.
 */
import { ai84Backend, ai84ModelForBackend, isAi84ClonedVoiceId, type Ai84Backend } from "./providers";

/**
 * Voice stored on a run by the studio pipeline.
 *
 * Precedence: the voice chosen for THIS video on the create page → the channel's voice →
 * null, which leaves the provider to read its own global setting exactly as before.
 *
 * `explicit` is what makes two videos with different voices possible at once: the global
 * setting is read at SYNTHESIS time, so without a per-run value two runs racing each other
 * necessarily share one voice.
 */
export function studioRunVoiceId(
  channel?: { voice_id?: string | null } | null,
  explicit?: string | null
): string | null {
  return explicit?.trim() || channel?.voice_id?.trim() || null;
}

/**
 * The AI84 model to snapshot on a run, or null to leave the global setting in charge.
 *
 * THE ENGINE FOLLOWS THE VOICE — whichever voice this video will actually be narrated
 * with, and wherever it came from: the create page, the channel, or the global setting.
 *
 * It used to follow only a voice picked on the create page, on the reasoning that a channel
 * voice should keep reading AI84_MODEL live so nothing changed for existing installs. That
 * reasoning was wrong, and a client found the hole: they run some channels on ElevenLabs and
 * some on MiniMax, and one global model cannot serve two engines — whichever they set, every
 * channel on the other engine failed. A voice is no less chosen for being chosen on the
 * channel.
 *
 * Nothing shifts for an install whose voice and model already agree: `ai84ModelForBackend`
 * returns the operator's own model untouched when it is already on the right engine.
 *
 * A cloned voice FORCES MiniMax regardless of what the caller said. That is a local
 * certainty, not a preference: `user_<n>_voice_<ts>` does not exist on ElevenLabs at all,
 * so honouring a contrary hint could only produce VOICE_NOT_FOUND_LOCAL.
 */
export function studioRunAi84Model(opts: {
  /** VOICEOVER_PROVIDER — anything but "ai84" means there is no model to pick. */
  provider: string;
  /** The voice this run will narrate with: create page → channel → global AI84_VOICE_ID. */
  voiceId: string | null;
  /**
   * Which engine that voice belongs to — from the create page's tagged list, or resolved
   * against AI84's catalogues (see services/ai84-voice-engine.ts). null means UNKNOWN, and
   * unknown must leave the global model alone rather than guess.
   */
  backendHint: Ai84Backend | null;
  /** Current AI84_MODEL, so a compatible choice by the operator is preserved. */
  globalModel: string;
}): string | null {
  if ((opts.provider || "").toLowerCase() !== "ai84") return null;
  const voice = opts.voiceId?.trim();
  if (!voice) return null;
  const backend = isAi84ClonedVoiceId(voice)
    ? "minimax"
    : (opts.backendHint ?? ai84Backend(opts.globalModel));
  return ai84ModelForBackend(backend, opts.globalModel);
}

/**
 * Voiceover-speed override stored on a run for the studio pipeline. Same
 * global-vs-channel model as {@link studioRunVoiceId}: a finite per-channel
 * `voice_speed` wins; NULL → the pipeline uses the global TTS_SPEED setting.
 */
export function studioRunSpeed(channel?: { voice_speed?: number | null } | null): number | null {
  const s = channel?.voice_speed;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

/** Voice stored on a run for the legacy TTS_PROVIDER pipeline (HeyGen by default). */
export function legacyRunVoiceId(preset?: { heygen_voice_id?: string | null } | null): string | null {
  return preset?.heygen_voice_id?.trim() || null;
}

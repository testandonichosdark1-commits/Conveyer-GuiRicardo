/**
 * "Does this run have a voice at all?" — asked BEFORE the run row exists.
 *
 * WHY IT LIVES HERE AND NOT IN THE PIPELINE: the pipeline already refuses an empty voice
 * id (every provider's TTS function throws on one). But it does so *after* /api/studio has
 * created the run, and — for the async providers — after a billable job may already have
 * been created. /api/studio calls the window before insertRun "the last moment this costs
 * nothing"; a missing voice is the cheapest possible thing to catch there.
 *
 * IT FAILS CLOSED, and that is not a third policy alongside verifyHeygenAvatar (open) and
 * checkAvatarVSupport (closed). Those two make NETWORK calls, so they have a "couldn't
 * verify" state and must decide what to do with it. This one makes none: an empty string
 * is a LOCAL CERTAINTY, already fatal downstream. Refusing it here only moves a guaranteed
 * failure earlier and makes it free.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: validate that a NON-EMPTY id exists at the provider.
 * That would be a second source of truth about which voices exist, and a stale one: AI84
 * alone needs up to five requests across two engines to answer it (the MiniMax library is
 * paged, and cloned voices live in their own endpoint), any of which can be a minute out
 * of date for a voice cloned just now. Blocking a valid run on our own outdated list is
 * worse than the failure it would prevent — especially since AI84's MiniMax engine already
 * rejects an unknown voice at create, for free, before anything is billed.
 *
 * The settings picker steers operators to voices proven to work, and the runtime message
 * names the id, the field and the likely cause when a provider does reject one. Neither
 * blocks a run on a guess.
 */
import { voiceProviderMeta } from "./providers";
import type { SettingKey } from "./settings";

/**
 * Providers whose TTS function throws on an empty voice id — i.e. the ones for which a
 * blank voice guarantees a dead run. Verified per provider in services/tts.ts and
 * services/elevenlabs-voiceover.ts rather than inferred from the registry:
 *
 *   elevenlabs  elevenlabs-voiceover.ts  "No ElevenLabs voice — set ELEVENLABS_VOICE_ID"
 *   heygen      tts.ts                   heygenTts throws on a missing voice
 *   minimax     tts.ts                   minimaxTts throws
 *   genaipro    tts.ts                   "No GenAIPro voice_id available"
 *   ai84        tts.ts                   "No AI84 voice_id available"
 *   ai33        tts.ts                   "No ai33 voice_id available"
 *   fishaudio   tts.ts                   fishAudioTts throws
 *   hume        tts.ts                   humeTts throws
 *
 * EXCLUDED, deliberately: `69labs` (falls back to "en-US-GuyNeural") and `openai` (falls
 * back to "alloy"). Those have real built-in defaults, so a blank voice is a working
 * configuration and refusing it would break them.
 */
const PROVIDERS_REQUIRING_A_VOICE = new Set([
  "elevenlabs",
  "heygen",
  "minimax",
  "genaipro",
  "ai84",
  "ai33",
  "fishaudio",
  "hume",
]);

/**
 * The refusal message for a studio run with no usable voice, or null when the run can
 * proceed. `channelVoiceId` is the channel's override (it WINS over the global setting —
 * see voice-select.ts), `get` reads a setting.
 */
export function missingVoiceRefusal(
  provider: string,
  channelVoiceId: string | null | undefined,
  get: (key: SettingKey) => string
): string | null {
  const id = (provider || "elevenlabs").toLowerCase();
  if (!PROVIDERS_REQUIRING_A_VOICE.has(id)) return null;
  const meta = voiceProviderMeta(id);
  // Same precedence the pipeline uses: channel override, else the provider's global key.
  const voice = (channelVoiceId?.trim() || get(meta.voiceIdKey as SettingKey) || "").trim();
  if (voice) return null;
  return (
    `No ${meta.label} voice is configured, so this video would have no narration. ` +
    `Set ${meta.voiceIdKey} in Settings (or a Voice ID on the channel) and start the run again. ` +
    `Nothing was created and nothing was charged.`
  );
}

/**
 * Turning a TTS provider's raw voice rejection into something an operator can act on.
 *
 * WHY THIS ISN'T classifyVoiceError (elevenlabs-voices.ts): that one is ElevenLabs-
 * specific by construction — it calls listElevenLabsVoices() against api.elevenlabs.io
 * and tells the operator to fix ELEVENLABS_VOICE_ID. Pointed at an AI84 failure it would
 * send an AI84 key to ElevenLabs and then name a setting that has nothing to do with the
 * run. A confidently-worded WRONG message is worse than the raw provider string, so the
 * ElevenLabs classifier stays ElevenLabs-only and this module covers everyone else.
 *
 * What a rejection message must contain, because a real run proved each one missing:
 *   - the FULL voice id (the run log truncated it to 8 chars, so we could not even tell
 *     what the client had configured),
 *   - WHICH field holds it — the global setting or the channel's own Voice ID, which
 *     silently overrides it (see voice-select.ts),
 *   - whether the id even looks like what this provider takes.
 *
 * Pure: no DB, no network. Cheap to unit-test and safe to call from anywhere (providers.ts
 * is itself pure, client-safe data).
 */
import { ai84Backend, isAi84ClonedVoiceId } from "../providers";
import { AI33_ENGINES, engineOfVoiceId } from "./ai33-response";

/**
 * Where the voice id actually came from, named as the operator would find it in the UI.
 * Parameterized by the registry's `voiceIdKey` so the next provider reuses this verbatim.
 */
export function voiceSourceLabel(fromOverride: boolean, voiceIdKey: string): string {
  return fromOverride
    ? "the Voice ID field on this run's channel (/channels)"
    : `${voiceIdKey} in /settings`;
}

/**
 * Does this look like an ElevenLabs-shaped voice id (20 alphanumerics, e.g.
 * JBFqnCBsd6RMkjVDRZzb)? Used for AI84, which is an ElevenLabs reseller and takes
 * ElevenLabs shared-voice ids.
 *
 * ADVISORY, NEVER A GATE — same rule as the Hume Octave compatibility check. A reseller's
 * accepted id forms are not documented and not something we can enumerate, so a wrong
 * guess here must never hide a voice that would have worked. It only ever adds a sentence
 * to a message the provider has ALREADY rejected.
 */
export function looksLikeElevenLabsVoiceId(id: string): boolean {
  return /^[A-Za-z0-9]{20}$/.test(id.trim());
}

export interface VoiceRejection {
  /** Human provider name, e.g. "AI84". */
  providerLabel: string;
  /** The id that was actually sent — in full, never truncated. */
  voiceId: string;
  /** The provider's global voice setting key, e.g. "AI84_VOICE_ID". */
  voiceIdKey: string;
  /** True when a channel's Voice ID overrode the global setting. */
  fromOverride: boolean;
  /** The provider's own error text, preserved verbatim at the end. */
  rawMsg: string;
  /**
   * Set when THIS request took ElevenLabs-shaped ids, to enable the shape hint. Must
   * follow the engine actually used, never the provider: AI84's MiniMax engine accepts
   * `user_<n>_voice_<ts>` cloned ids, and calling one of those "not ElevenLabs-shaped"
   * is a confidently wrong statement in the one message the operator is relying on.
   */
  expectsElevenLabsShape?: boolean;
  /**
   * Did this failed attempt cost money? AI84's ElevenLabs engine bills at create and only
   * then fails the job; its MiniMax engine rejects an unknown voice at create for free.
   * Left undefined when unknown — silence is better than a wrong claim about charges.
   */
  chargedForThisAttempt?: boolean;
  /** A concrete next step, when the cause is known (see ai84VoiceModelMismatch). */
  suggestion?: string | null;
}

/**
 * The exact trap a real client hit: an AI84 CLONED voice id sent to the ElevenLabs engine.
 * Cloned voices exist only on MiniMax, so this pairing can never succeed — and the raw
 * provider error ("This voice is not available, please choose another one") gives no hint
 * that the MODEL, not the voice, is what has to change.
 *
 * ADVISORY ONLY, NEVER A GATE — the same rule as the Hume Octave compatibility check. It
 * only ever adds a sentence to a message the provider has ALREADY rejected, so a wrong
 * guess here can never hide a voice that would have worked.
 */
export function ai84VoiceModelMismatch(voiceId: string, modelId: string): string | null {
  // Same predicate the run-creation path uses to force MiniMax — one source of truth for
  // "this is a cloned voice", so the advisory and the routing can never disagree.
  const onElevenLabs = ai84Backend(modelId) === "elevenlabs";
  if (!isAi84ClonedVoiceId(voiceId) || !onElevenLabs) return null;
  return (
    `"${voiceId}" looks like an AI84 cloned voice, and cloned voices only exist on AI84's ` +
    `MiniMax engine — but AI84_MODEL is "${modelId}", which runs on ElevenLabs. ` +
    `Switch AI84_MODEL to a "speech-…" model (e.g. speech-2.8-hd) and this voice will work.`
  );
}

/**
 * The one ai33-specific cause worth naming: a voice id with no engine prefix.
 *
 * An ai33 voice is addressed as `"<engine>:<id>"` — the engine is part of the id, which is
 * why this provider needs no engine setting at all. A bare id (pasted from another
 * provider, or typed from a voice name) therefore names no engine, and ai33 has six of
 * them. That is invisible in the raw rejection, which only says the voice is unavailable.
 *
 * ADVISORY, NEVER A GATE — the same rule as the Hume Octave check and ai84VoiceModelMismatch.
 * ai33's accepted id forms are not documented and could not be probed (no key is issued
 * without a donation), so a wrong guess here must never hide a voice that would have
 * worked. It only ever adds a sentence to a message ai33 has ALREADY rejected.
 */
export function ai33VoiceIdUnqualified(voiceId: string): string | null {
  if (engineOfVoiceId(voiceId)) return null;
  const id = voiceId.trim();
  if (!id) return null;
  return (
    `"${id}" carries no engine. ai33 voice ids are written "<engine>:<id>" — one of ` +
    `${AI33_ENGINES.join(", ")} — for example "edge:en-US-GuyNeural". Load the voice list in ` +
    `Settings and pick a voice there; the list writes the full id for you.`
  );
}

/**
 * Does an ai33 failure read as a VOICE rejection?
 *
 * The shared `isVoiceRejection` (elevenlabs-voices.ts) needs either the literal token
 * `voice_not_found` or an HTTP 400/404 next to the word "voice". ai33's async task API
 * reports a failed job in its body with neither — and its exact error vocabulary is one of
 * the facts that could not be probed — so a genuine bad-voice failure would arrive as a
 * bare provider string with no hint of which field to change.
 *
 * DELIBERATELY NARROW. It requires the word "voice" AND a not-found phrasing in the same
 * message, because the wrapper it gates says "ai33 rejected voice X — change it in
 * AI33_VOICE_ID". Firing that on an unrelated failure (no credits, engine down) would send
 * an operator to change a voice that works — a confidently wrong message, which this module
 * exists to avoid. "insufficient credits" and "task timed out" do not match.
 */
export function ai33LooksLikeVoiceRejection(msg: string): boolean {
  return /voice/i.test(msg) && /(not\s+(available|found|exist)|unavailable|invalid|unknown|unsupported|doesn'?t\s+exist)/i.test(msg);
}

/** One actionable sentence naming the id, the field to change, and the provider's reason. */
export function describeProviderVoiceRejection(r: VoiceRejection): string {
  const where = voiceSourceLabel(r.fromOverride, r.voiceIdKey);
  // The mismatch advisory is the real cause when it fires, so it replaces the generic
  // shape hint rather than piling a second, vaguer guess on top of it.
  const shape = r.suggestion
    ? ` ${r.suggestion}`
    : r.expectsElevenLabsShape && !looksLikeElevenLabsVoiceId(r.voiceId)
      ? ` "${r.voiceId}" doesn't look like an ElevenLabs-shaped voice id either (those are 20 letters/digits, e.g. JBFqnCBsd6RMkjVDRZzb), which is what ${r.providerLabel} takes.`
      : "";
  const charge =
    r.chargedForThisAttempt === false ? " Nothing was charged for this attempt." : "";
  return (
    `${r.providerLabel} rejected voice "${r.voiceId}" — change it in ${where}.${shape}${charge} ` +
    `(${r.providerLabel} said: ${r.rawMsg})`
  );
}

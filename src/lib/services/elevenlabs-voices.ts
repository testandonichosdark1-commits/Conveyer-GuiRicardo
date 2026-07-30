import { getSetting } from "../settings";

/**
 * Shared ElevenLabs voice resolution + diagnostics. Lives in its own module (no
 * heavy deps) so both the studio voiceover (elevenlabs-voiceover.ts) and the legacy
 * TTS branch (tts.ts) can enforce "ElevenLabs only ever receives a valid ElevenLabs
 * voice id" without importing each other (which would be a cycle).
 */

/** first4…last4 of a secret, for logs — never the whole key. */
export function keyFingerprint(key: string): string {
  if (!key) return "(none)";
  return key.length <= 8 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * The ElevenLabs voice actually sent to the API: an explicit run/channel override,
 * else the global ELEVENLABS_VOICE_ID, else the legacy TTS_VOICE_ID. A HeyGen id
 * must never reach here (see voice-select.ts / studioRunVoiceId). Exported so the
 * fallback precedence is unit-tested.
 */
export function resolveElevenLabsVoiceId(voiceOverride?: string | null): string {
  return (voiceOverride?.trim() || getSetting("ELEVENLABS_VOICE_ID") || getSetting("TTS_VOICE_ID") || "").trim();
}

/** Voices available to an ElevenLabs API key (the account that owns them). Best-effort:
 *  null when the account can't be listed — never blocks generation on its own. */
export async function listElevenLabsVoices(apiKey: string): Promise<{ id: string; name: string }[] | null> {
  try {
    const r = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", { headers: { "xi-api-key": apiKey } });
    if (!r.ok) return null;
    const j = (await r.json()) as { voices?: { voice_id: string; name: string }[] };
    return (j.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name }));
  } catch {
    return null;
  }
}

/** Whether a voice id belongs to the configured HeyGen account — used to explain a
 *  HeyGen id mistakenly handed to ElevenLabs. Best-effort. */
export async function heygenHasVoice(voiceId: string): Promise<boolean> {
  const key = getSetting("HEYGEN_API_KEY");
  if (!key) return false;
  try {
    const r = await fetch("https://api.heygen.com/v2/voices", { headers: { "X-Api-Key": key, Accept: "application/json" } });
    if (!r.ok) return false;
    const j = (await r.json()) as { data?: { voices?: { voice_id: string }[] } };
    return (j.data?.voices ?? []).some((v) => v.voice_id === voiceId);
  } catch {
    return false;
  }
}

/** True when an ElevenLabs error is a voice-id rejection (permanent, not transient). */
export function isVoiceRejection(msg: string): boolean {
  return /voice_not_found/i.test(msg) || (/\b(400|404)\b/.test(msg) && /voice/i.test(msg));
}

/**
 * Turn a bare ElevenLabs voice rejection into a clear, actionable message that says
 * WHY: the id is a HeyGen voice, or isn't in the active key's ElevenLabs account
 * (wrong/stale key), or is otherwise invalid. `accountVoices` is an already-fetched
 * account list (may be null); when null it is fetched here.
 */
export async function classifyVoiceError(
  rawMsg: string,
  voiceId: string,
  apiKey: string,
  accountVoices?: { id: string; name: string }[] | null
): Promise<string> {
  if (await heygenHasVoice(voiceId)) {
    return `Voice "${voiceId}" is a HeyGen voice id, not an ElevenLabs voice. Set an ElevenLabs voice in /settings (ELEVENLABS_VOICE_ID) or on the channel. (${rawMsg})`;
  }
  const voices = accountVoices === undefined ? await listElevenLabsVoices(apiKey) : accountVoices;
  if (voices && !voices.some((v) => v.id === voiceId)) {
    const sample = voices.slice(0, 5).map((v) => `${v.name} (${v.id})`).join(", ") || "none";
    return `Voice "${voiceId}" isn't in the ElevenLabs account for the active key (${keyFingerprint(apiKey)}) — it may belong to a different account or the key is stale (a saved DB value shadows .env; check GET /api/settings?reveal=1). Voices on this account: ${sample}. (${rawMsg})`;
  }
  return `ElevenLabs rejected voice "${voiceId}". ${rawMsg}`;
}

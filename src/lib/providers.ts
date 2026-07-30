/**
 * Provider metadata — single source of truth for the voice/AI provider selectors
 * and their dependent setting keys. Shared by the Settings page (dynamic key
 * display) and the Channels page (dynamic Voice-ID label). Pure data + helpers,
 * safe to import from client components (no DB/server imports).
 */

export type VoiceProviderId = "elevenlabs" | "genaipro" | "69labs" | "heygen" | "minimax" | "ai33pro";

export interface VoiceProviderMeta {
  id: VoiceProviderId;
  /** Short human name, e.g. "ElevenLabs" — used in labels like "{name} Voice ID". */
  label: string;
  /** Option text in the provider <select>. */
  selectLabel: string;
  /** Setting key holding this provider's API key. */
  apiKey: string;
  /** Setting key holding this provider's narration voice id. */
  voiceIdKey: string;
  /** Only "el"/"hg" have a /api/voices/* endpoint for the "Load voices" picker. */
  voicesEndpoint?: "el" | "hg";
  /** Extra required keys (e.g. MiniMax Group ID). */
  extraKeys?: { key: string; label: string }[];
}

export const VOICE_PROVIDERS: VoiceProviderMeta[] = [
  { id: "elevenlabs", label: "ElevenLabs", selectLabel: "ElevenLabs (direct)", apiKey: "ELEVENLABS_API_KEY", voiceIdKey: "ELEVENLABS_VOICE_ID", voicesEndpoint: "el" },
  { id: "genaipro", label: "GenAIPro", selectLabel: "GenAIPro", apiKey: "GENAIPRO_API_KEY", voiceIdKey: "GENAIPRO_VOICE_ID" },
  { id: "69labs", label: "69labs", selectLabel: "69labs (ElevenLabs / EdgeTTS / clone)", apiKey: "LABS69_API_KEY", voiceIdKey: "TTS_VOICE_ID" },
  { id: "heygen", label: "HeyGen", selectLabel: "HeyGen", apiKey: "HEYGEN_API_KEY", voiceIdKey: "HEYGEN_VOICE_ID", voicesEndpoint: "hg" },
  { id: "minimax", label: "MiniMax", selectLabel: "MiniMax", apiKey: "MINIMAX_API_KEY", voiceIdKey: "MINIMAX_VOICE_ID", extraKeys: [{ key: "MINIMAX_GROUP_ID", label: "MiniMax — Group ID" }] },
  { id: "ai33pro", label: "ai33pro", selectLabel: "ai33pro (ElevenLabs / Minimax / Clone / Edge / Kokoro / Vbee / FishAudio)", apiKey: "AI33PRO_API_KEY", voiceIdKey: "AI33PRO_VOICE_ID" },
];

const DEFAULT_VOICE_PROVIDER = VOICE_PROVIDERS[0]; // elevenlabs

/** Resolve provider metadata; unknown/empty → ElevenLabs (the app default). */
export function voiceProviderMeta(id: string | null | undefined): VoiceProviderMeta {
  return VOICE_PROVIDERS.find((p) => p.id === id) ?? DEFAULT_VOICE_PROVIDER;
}

/** Label for a channel/global Voice-ID field, e.g. "GenAIPro Voice ID". */
export function providerVoiceLabel(id: string | null | undefined): string {
  return `${voiceProviderMeta(id).label} Voice ID`;
}

export type AiProviderId = "kie" | "69labs" | "magnific";

export interface AiProviderMeta {
  id: AiProviderId;
  selectLabel: string;
  apiKey: string;
}

export const AI_PROVIDERS: AiProviderMeta[] = [
  { id: "kie", selectLabel: "kie.ai (nano-banana / Veo)", apiKey: "KIE_API_KEY" },
  { id: "69labs", selectLabel: "69labs (Grok)", apiKey: "LABS69_API_KEY" },
  { id: "magnific", selectLabel: "Magnific AI (Mystic / Hailuo)", apiKey: "MAGNIFIC_API_KEY" },
];

export function aiProviderMeta(id: string | null | undefined): AiProviderMeta {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];
}

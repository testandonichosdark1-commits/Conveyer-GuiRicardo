/**
 * Provider metadata — single source of truth for the voice/AI provider selectors
 * and their dependent setting keys. Shared by the Settings page (dynamic key
 * display) and the Channels page (dynamic Voice-ID label). Pure data + helpers,
 * safe to import from client components (no DB/server imports).
 *
 * NOTE the `SettingKey` import below is TYPE-ONLY (erased at compile time), so this
 * file stays client-safe — it never pulls settings.ts / better-sqlite3 into the
 * client bundle, and there is no runtime import cycle (settings.ts imports the
 * VALUES here; this file imports only the type back).
 */
import type { SettingKey } from "./settings";

export type VoiceProviderId =
  | "elevenlabs"
  | "genaipro"
  | "ai84"
  | "ai33"
  | "fishaudio"
  | "hume"
  | "69labs"
  | "heygen"
  | "minimax";

/**
 * Providers with a `/api/voices/*` route backing the "Load voices" picker. The value
 * IS the route segment, so adding a provider means adding a route with the same name —
 * no separate slug→URL mapping to keep in sync.
 */
export type VoicesEndpoint = "elevenlabs" | "heygen" | "fishaudio" | "hume" | "ai84" | "ai33";

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
  /** Set when the provider can list its voices — the value is the /api/voices/<x> route segment. */
  voicesEndpoint?: VoicesEndpoint;
  /** Extra required keys (e.g. MiniMax Group ID). */
  extraKeys?: { key: string; label: string }[];
}

export const VOICE_PROVIDERS: VoiceProviderMeta[] = [
  { id: "elevenlabs", label: "ElevenLabs", selectLabel: "ElevenLabs (direct)", apiKey: "ELEVENLABS_API_KEY", voiceIdKey: "ELEVENLABS_VOICE_ID", voicesEndpoint: "elevenlabs" },
  { id: "genaipro", label: "GenAIPro", selectLabel: "GenAIPro", apiKey: "GENAIPRO_API_KEY", voiceIdKey: "GENAIPRO_VOICE_ID" },
  // AI84 fronts TWO engines, and the chosen MODEL is what picks one (see AI84_MODELS
  // below). Each engine has its own voice listing, so /api/voices/ai84 takes a `backend`
  // query param. Cloned voices exist ONLY on the MiniMax side.
  { id: "ai84", label: "AI84", selectLabel: "AI84 (ElevenLabs / MiniMax reseller)", apiKey: "AI84_API_KEY", voiceIdKey: "AI84_VOICE_ID", voicesEndpoint: "ai84" },
  // ai33.pro (product name: OpenSpeaker) fronts SIX engines — clone / elevenlabs / minimax /
  // fishaudio / edge / vbee — and, unlike AI84, needs no engine setting at all: an ai33
  // voice id is "<engine>:<id>", so the engine travels inside the voice. There is
  // deliberately no AI33_MODEL or AI33_BACKEND. Adding one "for symmetry with AI84" would
  // recreate the exact defect AI84's comment above describes — a second source of truth for
  // one fact, whose disagreeing state is unrepresentable here and must stay that way.
  { id: "ai33", label: "ai33.pro", selectLabel: "ai33.pro / OpenSpeaker (6 engines)", apiKey: "AI33_API_KEY", voiceIdKey: "AI33_VOICE_ID", voicesEndpoint: "ai33" },
  // Fish Audio's voice id IS its model/reference id — the picker writes the `_id` of a
  // model from GET /model straight into FISHAUDIO_VOICE_ID, which is sent as `reference_id`.
  { id: "fishaudio", label: "Fish Audio", selectLabel: "Fish Audio", apiKey: "FISHAUDIO_API_KEY", voiceIdKey: "FISHAUDIO_VOICE_ID", voicesEndpoint: "fishaudio" },
  // Hume voices are addressed by a bare UUID that works for BOTH the shared Voice Library
  // (HUME_AI) and the account's own voices (CUSTOM_VOICE) — no provider field is stored,
  // because a voice referenced by `id` needs none (only the listing call does).
  { id: "hume", label: "Hume AI", selectLabel: "Hume AI (Octave)", apiKey: "HUME_API_KEY", voiceIdKey: "HUME_VOICE_ID", voicesEndpoint: "hume" },
  { id: "69labs", label: "69labs", selectLabel: "69labs (ElevenLabs / EdgeTTS / clone)", apiKey: "LABS69_API_KEY", voiceIdKey: "TTS_VOICE_ID" },
  { id: "heygen", label: "HeyGen", selectLabel: "HeyGen", apiKey: "HEYGEN_API_KEY", voiceIdKey: "HEYGEN_VOICE_ID", voicesEndpoint: "heygen" },
  { id: "minimax", label: "MiniMax", selectLabel: "MiniMax", apiKey: "MINIMAX_API_KEY", voiceIdKey: "MINIMAX_VOICE_ID", extraKeys: [{ key: "MINIMAX_GROUP_ID", label: "MiniMax — Group ID" }] },
];

/**
 * AI84's two engines, and the model catalog that selects between them.
 *
 * AI84 is a reseller fronting BOTH ElevenLabs and MiniMax. They are genuinely different
 * services behind one key: different create endpoints, different body shapes, different
 * voice libraries — and **cloned voices exist only on MiniMax** (`user_<n>_voice_<ts>`
 * ids). A cloned voice sent to the ElevenLabs engine comes back as
 * `internal.VOICE_NOT_FOUND_LOCAL`, which is the exact failure this catalog exists to
 * prevent.
 *
 * THE MODEL PICKS THE ENGINE — there is deliberately no `AI84_BACKEND` setting. A second
 * setting would be a second source of truth for one fact, and the state it makes
 * expressible ("engine = MiniMax, model = eleven_*") produces precisely the error above.
 * One setting cannot fall out of sync with itself.
 *
 * Ids verified live against /v1/models and /v1/minimax/models (2026-08-12).
 */
export type Ai84Backend = "elevenlabs" | "minimax";

export interface Ai84Model {
  id: string;
  label: string;
  backend: Ai84Backend;
}

export const AI84_MODELS: Ai84Model[] = [
  { id: "eleven_multilingual_v2", label: "Eleven Multilingual v2", backend: "elevenlabs" },
  { id: "eleven_v3", label: "Eleven v3 (alpha)", backend: "elevenlabs" },
  { id: "eleven_turbo_v2_5", label: "Eleven Turbo v2.5", backend: "elevenlabs" },
  { id: "eleven_flash_v2_5", label: "Eleven Flash v2.5", backend: "elevenlabs" },
  { id: "eleven_turbo_v2", label: "Eleven Turbo v2", backend: "elevenlabs" },
  { id: "eleven_flash_v2", label: "Eleven Flash v2", backend: "elevenlabs" },
  { id: "speech-2.8-hd", label: "Speech 2.8 HD", backend: "minimax" },
  { id: "speech-2.8-turbo", label: "Speech 2.8 Turbo", backend: "minimax" },
  { id: "speech-2.6-hd", label: "Speech 2.6 HD", backend: "minimax" },
  { id: "speech-2.6-turbo", label: "Speech 2.6 Turbo", backend: "minimax" },
  { id: "speech-2.5-hd-preview", label: "Speech 2.5 HD Preview", backend: "minimax" },
  { id: "speech-2.5-turbo-preview", label: "Speech 2.5 Turbo Preview", backend: "minimax" },
  { id: "speech-02-hd", label: "Speech 02 HD", backend: "minimax" },
  { id: "speech-02-turbo", label: "Speech 02 Turbo", backend: "minimax" },
  { id: "speech-01-hd", label: "Speech 01 HD", backend: "minimax" },
  { id: "speech-01-turbo", label: "Speech 01 Turbo", backend: "minimax" },
];

/**
 * Which engine a model id runs on. Matched on the `speech-` PREFIX rather than against
 * AI84_MODELS, so a model AI84 adds tomorrow routes correctly without a release here —
 * and, crucially, an empty or unrecognised value resolves to **elevenlabs**, which is
 * what every install created before this existed has stored. Their behaviour is
 * unchanged, byte for byte, and no migration is needed.
 */
export function ai84Backend(modelId: string | null | undefined): Ai84Backend {
  return (modelId ?? "").trim().startsWith("speech-") ? "minimax" : "elevenlabs";
}

/** The model to fall back to when a run needs an engine the global setting isn't on. */
export const AI84_DEFAULT_MODEL: Record<Ai84Backend, string> = {
  // Matches DEFAULTS.AI84_MODEL, so nothing about an untouched install shifts.
  elevenlabs: "eleven_multilingual_v2",
  minimax: "speech-2.8-hd",
};

/**
 * The model a run should use to reach `backend`.
 *
 * If the global AI84_MODEL is ALREADY on that engine, it is returned unchanged — the
 * operator may have deliberately picked a tier (`speech-2.6-turbo` over `speech-2.8-hd`,
 * `eleven_flash` over `eleven_multilingual`), and silently upgrading them to our default
 * would change both their audio and their bill. Only a genuine engine mismatch swaps it.
 */
export function ai84ModelForBackend(backend: Ai84Backend, currentModel: string | null | undefined): string {
  const current = (currentModel ?? "").trim();
  return current && ai84Backend(current) === backend ? current : AI84_DEFAULT_MODEL[backend];
}

/**
 * Is this one of an AI84 account's OWN cloned voices (`user_7744_voice_1786013694967`)?
 *
 * Cloned voices exist only on the MiniMax engine, so this is a LOCAL CERTAINTY: such an id
 * cannot possibly work on ElevenLabs, whatever else we've been told. The pattern is
 * anchored, so a merely clone-shaped name can't trigger a false accusation.
 */
export function isAi84ClonedVoiceId(voiceId: string | null | undefined): boolean {
  return /^user_\d+_voice_\d+$/.test((voiceId ?? "").trim());
}

const DEFAULT_VOICE_PROVIDER = VOICE_PROVIDERS[0]; // elevenlabs

/** Resolve provider metadata; unknown/empty → ElevenLabs (the app default). */
export function voiceProviderMeta(id: string | null | undefined): VoiceProviderMeta {
  return VOICE_PROVIDERS.find((p) => p.id === id) ?? DEFAULT_VOICE_PROVIDER;
}

/** Label for a channel/global Voice-ID field, e.g. "GenAIPro Voice ID". */
export function providerVoiceLabel(id: string | null | undefined): string {
  return `${voiceProviderMeta(id).label} Voice ID`;
}

export type AiProviderId = "kie" | "69labs" | "magnific" | "runware" | "higgsfield" | "flow_browser";
export type AiMedia = "image" | "video";

/** One selectable generation model. `id` is the exact provider string persisted to the setting. */
export interface AiModel {
  id: string;
  /** Friendly display name — the UI composes "(Recommended)" separately, so this stays clean/translatable. */
  label: string;
  /** The provider's recommended default for this media. Exactly one per model list. */
  recommended?: boolean;
}

/** A provider's model catalog for one media, + the setting key the chosen model persists to. */
export interface AiMediaCatalog {
  key: SettingKey;
  models: AiModel[];
}

export interface AiProviderMeta {
  id: AiProviderId;
  selectLabel: string;
  /** API credential setting. Browser-backed providers deliberately have none. */
  apiKey?: string;
  /**
   * Per-media model catalogs. A media block is PRESENT only if the provider can
   * generate that media — so the UI renders the Image select only when `image`
   * exists and the Video select only when `video` exists (capability-driven; no
   * dead fields). All three current providers do both.
   *
   * Only ids verified against each provider's API are listed; the UI's "Custom…"
   * escape covers anything not yet catalogued. Each `recommended` id MUST match the
   * corresponding `settings.ts` DEFAULT (settings.ts derives its default from here
   * via `defaultAiModel`, so they cannot drift).
   */
  image?: AiMediaCatalog;
  video?: AiMediaCatalog;
}

export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: "kie",
    selectLabel: "kie.ai (nano-banana / Veo)",
    apiKey: "KIE_API_KEY",
    image: { key: "KIE_IMAGE_MODEL", models: [{ id: "google/nano-banana", label: "Nano Banana", recommended: true }] },
    video: { key: "KIE_VIDEO_MODEL", models: [{ id: "veo3_fast", label: "Veo 3 Fast", recommended: true }] },
  },
  {
    id: "flow_browser",
    selectLabel: "Google Flow (browser — experimental)",
    image: {
      key: "FLOW_IMAGE_MODEL",
      models: [
        { id: "nano-banana-pro", label: "Nano Banana Pro", recommended: true },
        { id: "nano-banana-2", label: "Nano Banana 2" },
        { id: "nano-banana", label: "Nano Banana" },
      ],
    },
    // Ids are kebab-case; ensureVeoModel() normalizes both this and Flow's own visible
    // label text (lowercase, hyphens/underscores → spaces, collapsed whitespace) before
    // comparing, so "veo-3.1-fast" matches a UI that renders "Veo 3.1 Fast". The catalog
    // is a MENU of known labels, not an allowlist — "Custom…" (ProviderModelFields) lets
    // an operator type any label Flow shows that Google renames or adds later; whatever
    // is saved to FLOW_VIDEO_MODEL is matched literally against the UI, never silently
    // swapped for a different model when it can't be confirmed (see ensureVeoModel).
    video: {
      key: "FLOW_VIDEO_MODEL",
      models: [
        { id: "veo-3", label: "Veo 3" },
        { id: "veo-3-fast", label: "Veo 3 Fast" },
        { id: "veo-3.1", label: "Veo 3.1" },
        { id: "veo-3.1-fast", label: "Veo 3.1 Fast", recommended: true },
        { id: "veo-3.1-quality", label: "Veo 3.1 Quality" },
      ],
    },
  },
  {
    id: "69labs",
    selectLabel: "69labs (Grok)",
    apiKey: "LABS69_API_KEY",
    image: {
      key: "IMAGE_MODEL",
      models: [
        { id: "nano-banana-pro", label: "Nano Banana Pro", recommended: true },
        { id: "imagen-4", label: "Imagen 4" },
        { id: "seedream-4.5", label: "Seedream 4.5" },
      ],
    },
    video: { key: "ANIMATION_MODEL", models: [{ id: "grok-imagine-video", label: "Grok Imagine Video", recommended: true }] },
  },
  {
    id: "magnific",
    selectLabel: "Magnific AI (Mystic / Hailuo)",
    apiKey: "MAGNIFIC_API_KEY",
    image: {
      key: "MAGNIFIC_IMAGE_MODEL",
      models: [
        { id: "realism", label: "Realism", recommended: true },
        { id: "zen", label: "Zen" },
        { id: "flexible", label: "Flexible" },
        { id: "fluid", label: "Fluid" },
        { id: "super_real", label: "Super Real" },
        { id: "editorial_portraits", label: "Editorial Portraits" },
      ],
    },
    video: { key: "MAGNIFIC_VIDEO_MODEL", models: [{ id: "minimax-hailuo-02-1080p", label: "Hailuo 02 (1080p)", recommended: true }] },
  },
  {
    id: "runware",
    selectLabel: "Runware (Experimental)",
    apiKey: "RUNWARE_API_KEY",
    // Image only for now — Runware also generates video, but no video model is
    // wired yet, and the catalog is capability-driven: omitting `video` means the
    // UI renders no Video-model select rather than a dead field.
    //
    // Ids are Runware AIR identifiers (`creator:model@version`), each read off
    // that model's own official page. Exposing a RANGE is the point of this
    // provider: one API spanning a ~100x price spread, so the operator picks
    // their own cost/quality point. Adding a model is one line here — the
    // Settings select is generated from this list.
    image: {
      key: "RUNWARE_IMAGE_MODEL",
      models: [
        // ~$0.005/image — best quality-per-dollar of the open-weight tier.
        { id: "runware:101@1", label: "FLUX.1 [dev]", recommended: true },
        // ~$0.0013/image — the cheapest usable option.
        { id: "runware:100@1", label: "FLUX.1 [schnell]" },
        // Photorealism-tuned FLUX (no wax/plastic skin) — closest to our
        // "cinematic, photo realistic, documentary" default style.
        { id: "rundiffusion:130@100", label: "Juggernaut Pro FLUX" },
        // ~$0.03/image.
        { id: "bytedance:5@0", label: "Seedream 4.0" },
        // ~$0.039/image — the same Google model kie.ai serves, for a direct A/B.
        { id: "google:4@1", label: "Nano Banana" },
        // ~$0.138/image — highest quality, highest price.
        { id: "google:4@2", label: "Nano Banana Pro" },
      ],
    },
  },
  {
    id: "higgsfield",
    selectLabel: "Higgsfield (Soul / DoP)",
    apiKey: "HIGGSFIELD_API_KEY",
    // Higgsfield exposes ONE async API (platform.higgsfield.ai) that fronts both its
    // own models (Soul image, DoP cinematic video) and a roster of third-party engines
    // (Kling / Seedance / FLUX / Reve …), each addressed by a `{provider}/{model}` slug.
    // Every job is POST /{slug} → poll /requests/{id}/status. Ids below are the exact
    // slugs confirmed from the docs; the "Custom…" escape covers any not catalogued yet.
    image: {
      key: "HIGGSFIELD_IMAGE_MODEL",
      models: [
        { id: "higgsfield-ai/soul/standard", label: "Soul", recommended: true },
        { id: "bytedance/seedream/v4/text-to-image", label: "Seedream 4" },
        { id: "flux-pro/kontext/max/text-to-image", label: "FLUX Kontext Max" },
        { id: "reve/text-to-image", label: "Reve" },
      ],
    },
    video: {
      key: "HIGGSFIELD_VIDEO_MODEL",
      models: [
        { id: "higgsfield-ai/dop/standard", label: "DoP (cinematic)", recommended: true },
        { id: "higgsfield-ai/dop/preview", label: "DoP Preview" },
        { id: "kling-video/v2.1/pro/image-to-video", label: "Kling 2.1 Pro" },
        { id: "bytedance/seedance/v1/pro/image-to-video", label: "Seedance 1 Pro" },
      ],
    },
  },
];

export function aiProviderMeta(id: string | null | undefined): AiProviderMeta {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];
}

/** The provider's catalog for one media, or undefined if it can't generate that media. */
export function aiMediaCatalog(id: string | null | undefined, media: AiMedia): AiMediaCatalog | undefined {
  const meta = aiProviderMeta(id);
  return media === "image" ? meta.image : meta.video;
}

/** Supported models for a provider+media (empty if the provider lacks that media). */
export function aiModelsFor(id: string | null | undefined, media: AiMedia): AiModel[] {
  return aiMediaCatalog(id, media)?.models ?? [];
}

/**
 * The recommended default model id for a provider+media — the SINGLE SOURCE OF TRUTH
 * consumed by settings.ts DEFAULTS and the runtime `|| fallback`. Falls back to the
 * first listed model, then "" (media absent).
 */
export function defaultAiModel(id: string | null | undefined, media: AiMedia): string {
  const models = aiModelsFor(id, media);
  return (models.find((m) => m.recommended) ?? models[0])?.id ?? "";
}

/** True if `modelId` is a catalogued model for the provider+media (drives Custom… detection + save coercion). */
export function isSupportedAiModel(id: string | null | undefined, media: AiMedia, modelId: string): boolean {
  return aiModelsFor(id, media).some((m) => m.id === modelId);
}

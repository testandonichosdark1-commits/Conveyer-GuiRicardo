import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AI_PROVIDERS,
  VOICE_PROVIDERS,
  aiProviderMeta,
  aiModelsFor,
  defaultAiModel,
  isSupportedAiModel,
  voiceProviderMeta,
  providerVoiceLabel,
  AI84_MODELS,
  ai84Backend,
  AI84_DEFAULT_MODEL,
  ai84ModelForBackend,
  isAi84ClonedVoiceId,
  type AiMedia,
} from "./providers";
import { DEFAULTS } from "./settings";

/** Pure, dependency-free — the registry is plain data + helpers. */
describe("AI provider/model registry", () => {
  it("resolves known providers and falls back to the first (kie) for unknown/empty", () => {
    expect(aiProviderMeta("magnific").id).toBe("magnific");
    expect(aiProviderMeta("nope").id).toBe("kie");
    expect(aiProviderMeta(null).id).toBe("kie");
  });

  it("every media catalog marks exactly one recommended model, and defaultAiModel returns it", () => {
    for (const p of AI_PROVIDERS) {
      for (const media of ["image", "video"] as AiMedia[]) {
        const models = aiModelsFor(p.id, media);
        if (!models.length) continue; // provider doesn't do that media
        const recommended = models.filter((m) => m.recommended);
        expect(recommended, `${p.id}/${media} recommended count`).toHaveLength(1);
        expect(defaultAiModel(p.id, media)).toBe(recommended[0].id);
      }
    }
  });

  it("SINGLE SOURCE OF TRUTH: each provider's recommended id equals the settings.ts DEFAULT for its key", () => {
    // If these drift, a run would generate with a model the UI doesn't show as default.
    for (const p of AI_PROVIDERS) {
      if (p.image) expect(DEFAULTS[p.image.key], `${p.id} image default`).toBe(defaultAiModel(p.id, "image"));
      if (p.video) expect(DEFAULTS[p.video.key], `${p.id} video default`).toBe(defaultAiModel(p.id, "video"));
    }
  });

  it("isSupportedAiModel gates catalogued ids only (drives Custom… detection)", () => {
    expect(isSupportedAiModel("kie", "image", "google/nano-banana")).toBe(true);
    expect(isSupportedAiModel("kie", "video", "veo3_fast")).toBe(true);
    expect(isSupportedAiModel("kie", "image", "some-brand-new-model")).toBe(false);
    expect(isSupportedAiModel("magnific", "image", "realism")).toBe(true);
    expect(isSupportedAiModel("69labs", "image", "imagen-4")).toBe(true);
    expect(isSupportedAiModel("runware", "image", "runware:101@1")).toBe(true);
  });

  it("kie / 69labs / magnific support both image and video", () => {
    for (const id of ["kie", "69labs", "magnific"]) {
      expect(aiModelsFor(id, "image").length, `${id} image`).toBeGreaterThan(0);
      expect(aiModelsFor(id, "video").length, `${id} video`).toBeGreaterThan(0);
    }
  });

  it("runware is IMAGE-ONLY, so the UI renders no video select (capability-driven, not a dead field)", () => {
    expect(aiProviderMeta("runware").image).toBeTruthy();
    expect(aiProviderMeta("runware").video).toBeUndefined();
    expect(aiModelsFor("runware", "video")).toHaveLength(0);
  });

  it("every runware model id is an AIR identifier (creator:model@version)", () => {
    // A malformed id is a 400 from Runware at generation time, i.e. a lost beat —
    // cheaper to catch here than in a run.
    for (const m of aiModelsFor("runware", "image")) {
      expect(m.id, m.label).toMatch(/^[a-z0-9-]+:[a-z0-9.-]+@[a-z0-9.-]+$/i);
    }
  });

  it("runware is not the default provider — kie still is", () => {
    // Runware is experimental: it must be opt-in, never inherited by an existing install.
    expect(DEFAULTS.AI_PROVIDER).toBe("kie");
    expect(aiProviderMeta(null).id).toBe("kie");
  });
});

/**
 * Voice-provider registry. These are the checks that catch the class of bug where a
 * provider is half-wired — visible in the dropdown but with a key that never persists,
 * or a "Load voices" button pointing at a route that doesn't exist.
 */
describe("voice provider registry", () => {
  it("registers Fish Audio and Hume alongside the existing providers, without dropping any", () => {
    const ids = VOICE_PROVIDERS.map((p) => p.id);
    for (const existing of ["elevenlabs", "genaipro", "ai84", "69labs", "heygen", "minimax"]) {
      expect(ids, `${existing} must still be selectable`).toContain(existing);
    }
    expect(ids).toContain("fishaudio");
    expect(ids).toContain("hume");
  });

  it("ElevenLabs is STILL the default — a new provider must never inherit existing installs", () => {
    expect(DEFAULTS.VOICEOVER_PROVIDER).toBe("elevenlabs");
    expect(voiceProviderMeta(null).id).toBe("elevenlabs");
    expect(voiceProviderMeta("").id).toBe("elevenlabs");
    expect(voiceProviderMeta("fishaudio-typo").id).toBe("elevenlabs");
  });

  it("has no duplicate ids or option labels (a duplicated <option> is a broken dropdown)", () => {
    expect(new Set(VOICE_PROVIDERS.map((p) => p.id)).size).toBe(VOICE_PROVIDERS.length);
    expect(new Set(VOICE_PROVIDERS.map((p) => p.selectLabel)).size).toBe(VOICE_PROVIDERS.length);
  });

  it("every provider's key + voice-id settings really exist, so what the UI edits is what runtime reads", () => {
    for (const p of VOICE_PROVIDERS) {
      expect(DEFAULTS, `${p.id} apiKey ${p.apiKey}`).toHaveProperty(p.apiKey);
      expect(DEFAULTS, `${p.id} voiceIdKey ${p.voiceIdKey}`).toHaveProperty(p.voiceIdKey);
      for (const ek of p.extraKeys ?? []) expect(DEFAULTS, `${p.id} extra ${ek.key}`).toHaveProperty(ek.key);
    }
  });

  it("every API key setting defaults to empty — no key is ever hardcoded", () => {
    for (const p of VOICE_PROVIDERS) expect(DEFAULTS[p.apiKey as keyof typeof DEFAULTS], p.apiKey).toBe("");
  });

  it("every declared voicesEndpoint has a matching /api/voices/<x> route", () => {
    // The registry value IS the route segment; if they drift, "Load voices" 404s.
    const routes = readdirSync(join(__dirname, "../app/api/voices"));
    for (const p of VOICE_PROVIDERS) {
      if (!p.voicesEndpoint) continue;
      expect(routes, `${p.id} → /api/voices/${p.voicesEndpoint}`).toContain(p.voicesEndpoint);
    }
  });

  it("registers ai33.pro with a voice listing, since its ids are engine-prefixed and unguessable", () => {
    expect(voiceProviderMeta("ai33").id).toBe("ai33");
    expect(voiceProviderMeta("ai33").voicesEndpoint).toBe("ai33");
    expect(providerVoiceLabel("ai33")).toBe("ai33.pro Voice ID");
  });

  it("ai33 has NO engine/model setting, and adding one would recreate AI84's bug", () => {
    // An ai33 voice id is "<engine>:<id>", so the engine travels inside the voice. A
    // separate AI33_MODEL / AI33_BACKEND would be a second source of truth for one fact,
    // and its disagreeing state ("MiniMax engine, an ElevenLabs voice") is exactly what
    // cost a real client two failed AI84 runs. Here that state is unrepresentable — this
    // test is what keeps it that way against a future "for symmetry with AI84" edit.
    expect(DEFAULTS).not.toHaveProperty("AI33_MODEL");
    expect(DEFAULTS).not.toHaveProperty("AI33_BACKEND");
    expect(voiceProviderMeta("ai33").extraKeys).toBeUndefined();
  });

  it("does not invent an ai33 credit price — a made-up rate lies on the Costs page", () => {
    // ai33 sells credit packs but publishes no per-engine rate, and its six engines are not
    // priced alike. Blank means "nobody priced this", which /costs says out loud; a number
    // here would be a confident figure with nothing behind it.
    expect(DEFAULTS.COST_AI33_USD_PER_CREDIT).toBe("");
    // The host defaults to blank too, so the documented one is used and nothing is pinned.
    expect(DEFAULTS.AI33_BASE_URL).toBe("");
  });

  it("Fish Audio and Hume both offer voice listing, so no id has to be typed by hand", () => {
    expect(voiceProviderMeta("fishaudio").voicesEndpoint).toBe("fishaudio");
    expect(voiceProviderMeta("hume").voicesEndpoint).toBe("hume");
  });

  it("ships each new provider's published billing rate as its DEFAULT", () => {
    // pricing.ts prices a BLANK rate at 0, so the rate an install actually uses is the
    // one seeded here. If these are empty, Fish/Hume spend silently shows as €0.00.
    expect(DEFAULTS.COST_FISHAUDIO_USD_PER_1M_BYTES).toBe("15.00"); // $15 / 1M UTF-8 bytes
    expect(DEFAULTS.COST_HUME_USD_PER_1K_CHARS).toBe("0.15"); // $0.15 / 1k chars, entry tier
  });

  it("does not pin a Hume Octave version by default, so Octave-2 voices work out of the box", () => {
    expect(DEFAULTS.HUME_VERSION).toBe("");
    expect(DEFAULTS.FISHAUDIO_MODEL).toBe("s2.1-pro");
  });

  it("labels the channel Voice-ID field per provider", () => {
    expect(providerVoiceLabel("fishaudio")).toBe("Fish Audio Voice ID");
    expect(providerVoiceLabel("hume")).toBe("Hume AI Voice ID");
    expect(providerVoiceLabel("elevenlabs")).toBe("ElevenLabs Voice ID");
  });
});

/**
 * AI84 fronts two engines and the MODEL is what selects one. There is deliberately no
 * AI84_BACKEND setting — a second source of truth for one fact, whose out-of-sync state
 * ("MiniMax engine, eleven_* model") produces exactly the VOICE_NOT_FOUND_LOCAL this
 * mapping exists to prevent.
 */
describe("AI84 engine selection", () => {
  it("routes every catalogued model to its engine", () => {
    for (const m of AI84_MODELS) {
      expect(ai84Backend(m.id), m.id).toBe(m.backend);
    }
  });

  it("routes on the speech- prefix, so a model AI84 adds later still lands correctly", () => {
    expect(ai84Backend("speech-9.9-ultra")).toBe("minimax");
  });

  it("falls back to ElevenLabs for empty/unknown values — the pre-existing behaviour", () => {
    // Every install created before the MiniMax work has eleven_multilingual_v2 (or an
    // empty string) stored. Both MUST keep running on ElevenLabs, byte for byte, with no
    // migration; anything else silently moves paying users to a different engine.
    for (const v of ["", "   ", null, undefined, "garbage", "eleven_multilingual_v2"]) {
      expect(ai84Backend(v), String(v)).toBe("elevenlabs");
    }
    expect(DEFAULTS.AI84_MODEL).toBe("eleven_multilingual_v2");
  });

  it("keeps a model the operator already chose, when it is on the right engine", () => {
    // They may have deliberately picked a tier. Silently promoting speech-2.6-turbo to our
    // default speech-2.8-hd would change both the audio and the bill.
    expect(ai84ModelForBackend("minimax", "speech-2.6-turbo")).toBe("speech-2.6-turbo");
    expect(ai84ModelForBackend("elevenlabs", "eleven_flash_v2_5")).toBe("eleven_flash_v2_5");
  });

  it("swaps to the engine's default only on a genuine mismatch", () => {
    expect(ai84ModelForBackend("minimax", "eleven_multilingual_v2")).toBe("speech-2.8-hd");
    expect(ai84ModelForBackend("elevenlabs", "speech-2.8-hd")).toBe("eleven_multilingual_v2");
    for (const v of ["", "   ", null, undefined]) {
      expect(ai84ModelForBackend("minimax", v), String(v)).toBe("speech-2.8-hd");
    }
  });

  it("always returns a model that actually routes to the engine that was asked for", () => {
    const ids = [...AI84_MODELS.map((m) => m.id), "", "garbage"];
    for (const backend of ["minimax", "elevenlabs"] as const) {
      for (const current of ids) {
        expect(ai84Backend(ai84ModelForBackend(backend, current)), `${backend}/${current}`).toBe(backend);
      }
    }
  });

  it("has both engine defaults in the catalog", () => {
    for (const id of Object.values(AI84_DEFAULT_MODEL)) {
      expect(AI84_MODELS.some((m) => m.id === id), id).toBe(true);
    }
  });

  it("recognises an account's own cloned voice id, and nothing else", () => {
    expect(isAi84ClonedVoiceId("user_7744_voice_1786013694967")).toBe(true);
    expect(isAi84ClonedVoiceId("  user_7744_voice_1786013694967  ")).toBe(true);
    // Anchored: a merely clone-shaped name must not be accused.
    expect(isAi84ClonedVoiceId("user_abc_voice_xyz")).toBe(false);
    expect(isAi84ClonedVoiceId("my_user_7744_voice_1")).toBe(false);
    expect(isAi84ClonedVoiceId("yFgkuUnlOWx3k7ezUZQm")).toBe(false);
    expect(isAi84ClonedVoiceId("")).toBe(false);
    expect(isAi84ClonedVoiceId(null)).toBe(false);
  });

  it("catalogues both engines, with ids matching AI84's own model lists", () => {
    // Verified live 2026-08-12: GET /v1/models → 6 eleven_*, GET /v1/minimax/models → 10 speech-*.
    expect(AI84_MODELS.filter((m) => m.backend === "elevenlabs")).toHaveLength(6);
    expect(AI84_MODELS.filter((m) => m.backend === "minimax")).toHaveLength(10);
    expect(new Set(AI84_MODELS.map((m) => m.id)).size).toBe(AI84_MODELS.length);
  });
});

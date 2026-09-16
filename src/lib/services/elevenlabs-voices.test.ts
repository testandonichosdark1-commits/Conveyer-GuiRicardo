import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));

import { resolveElevenLabsVoiceId, isVoiceRejection, classifyVoiceError } from "./elevenlabs-voices";

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveElevenLabsVoiceId — leaf fallback precedence", () => {
  it("prefers an explicit run/channel override (trimmed)", () => {
    settings.ELEVENLABS_VOICE_ID = "global_el";
    expect(resolveElevenLabsVoiceId("  ov_1  ")).toBe("ov_1");
  });

  it("falls back to ELEVENLABS_VOICE_ID when the override is null (studio + HeyGen preset + no channel)", () => {
    settings.ELEVENLABS_VOICE_ID = "global_el";
    expect(resolveElevenLabsVoiceId(null)).toBe("global_el");
    expect(resolveElevenLabsVoiceId("")).toBe("global_el");
  });

  it("falls back to TTS_VOICE_ID last", () => {
    settings.TTS_VOICE_ID = "tts_v";
    expect(resolveElevenLabsVoiceId(null)).toBe("tts_v");
  });
});

describe("isVoiceRejection", () => {
  it("matches voice_not_found and 400/404 voice errors, not 5xx", () => {
    expect(isVoiceRejection('ElevenLabs 400: {"detail":{"status":"voice_not_found"}}')).toBe(true);
    expect(isVoiceRejection("ElevenLabs 404: a voice with voice_id ... was not found")).toBe(true);
    expect(isVoiceRejection("ElevenLabs 500: service_unavailable")).toBe(false);
  });

  it("matches AI84's VOICE_NOT_FOUND_LOCAL — the predicate is shared, not ElevenLabs-only", () => {
    // Verbatim from a real failed run. `/voice_not_found/i` finds the substring inside
    // VOICE_NOT_FOUND_LOCAL, which is what lets ai84Tts route this to an actionable
    // message. Tightening the regex (e.g. anchoring or adding \b) would silently unmatch
    // it and AI84 would go back to surfacing "please choose another one" with no context.
    expect(
      isVoiceRejection(
        "AI84 job 95bc3966 failed [internal.VOICE_NOT_FOUND_LOCAL]: This voice is not available, please choose another one."
      )
    ).toBe(true);
  });
});

describe("classifyVoiceError", () => {
  it("labels a HeyGen voice id handed to ElevenLabs", async () => {
    settings.HEYGEN_API_KEY = "hg_key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: { voices: [{ voice_id: "hg_voice" }] } }) })) as unknown as typeof fetch
    );
    const msg = await classifyVoiceError("ElevenLabs 400: voice_not_found", "hg_voice", "sk_abcd1234", null);
    expect(msg).toMatch(/HeyGen voice id/i);
  });

  it("labels a voice absent from the active key's account, with the key fingerprint", async () => {
    settings.HEYGEN_API_KEY = "hg_key";
    // HeyGen has no such voice → not a HeyGen id.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: { voices: [] } }) })) as unknown as typeof fetch
    );
    const account = [{ id: "el_a", name: "Alice" }];
    const msg = await classifyVoiceError("ElevenLabs 400: voice_not_found", "el_missing", "sk_abcd1234", account);
    expect(msg).toMatch(/isn't in the ElevenLabs account/i);
    expect(msg).toMatch(/sk_a…1234/);
  });
});

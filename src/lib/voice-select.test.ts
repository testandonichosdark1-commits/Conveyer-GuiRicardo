import { describe, it, expect } from "vitest";
import { studioRunVoiceId, studioRunSpeed, legacyRunVoiceId, studioRunAi84Model } from "./voice-select";

/**
 * Regression guard for the two-pipeline voice choice. `runs.preset_voice_id` is
 * overloaded, so these lock in that:
 *   - the ElevenLabs studio pipeline never stores a preset's HeyGen voice, and
 *   - the legacy HeyGen-TTS pipeline keeps the preset's HeyGen voice unchanged.
 * If a future refactor re-crosses the wires, this fails loudly.
 */

describe("studioRunVoiceId — studio pipeline", () => {
  it("is PROVIDER-BLIND: it passes the channel's id through untouched, whatever it looks like", () => {
    // Documenting the trap rather than pretending it doesn't exist. This one column is
    // handed to whichever VOICEOVER_PROVIDER is configured, and it WINS over that
    // provider's own global voice setting — so an id entered while another provider was
    // selected is silently sent to the next one. That is how an AI84 run received
    // `user_7744_voice_…` and died mid-run on a voice rejection.
    // The guards live elsewhere (the /channels warning, the runtime rejection message);
    // this function must NOT start filtering by shape, or it would drop valid ids for
    // providers whose id format we cannot enumerate.
    expect(studioRunVoiceId({ voice_id: "user_7744_voice_1786013694967" })).toBe("user_7744_voice_1786013694967");
    expect(studioRunVoiceId({ voice_id: "en-US-GuyNeural" })).toBe("en-US-GuyNeural");
  });

  it("uses a channel ElevenLabs voice when present", () => {
    expect(studioRunVoiceId({ voice_id: "el_channel" })).toBe("el_channel");
    expect(studioRunVoiceId({ voice_id: "  el_trim  " })).toBe("el_trim");
  });

  it("is null with no channel voice → pipeline falls back to global ELEVENLABS_VOICE_ID", () => {
    expect(studioRunVoiceId(null)).toBeNull();
    expect(studioRunVoiceId(undefined)).toBeNull();
    expect(studioRunVoiceId({ voice_id: null })).toBeNull();
    expect(studioRunVoiceId({ voice_id: "" })).toBeNull();
    expect(studioRunVoiceId({ voice_id: "   " })).toBeNull();
  });
});

describe("studioRunSpeed — per-channel voiceover-speed override", () => {
  it("uses a finite channel speed when present (wins over global TTS_SPEED)", () => {
    expect(studioRunSpeed({ voice_speed: 1.1 })).toBe(1.1);
    expect(studioRunSpeed({ voice_speed: 0.85 })).toBe(0.85);
  });

  it("is null with no channel speed → pipeline falls back to the global TTS_SPEED", () => {
    expect(studioRunSpeed(null)).toBeNull();
    expect(studioRunSpeed(undefined)).toBeNull();
    expect(studioRunSpeed({ voice_speed: null })).toBeNull();
    expect(studioRunSpeed({ voice_speed: NaN })).toBeNull();
  });
});

describe("studioRunVoiceId — the per-video voice", () => {
  it("lets a voice chosen for THIS video beat the channel's", () => {
    expect(studioRunVoiceId({ voice_id: "channel_voice" }, "page_voice")).toBe("page_voice");
    expect(studioRunVoiceId({ voice_id: "channel_voice" }, "  padded  ")).toBe("padded");
  });

  it("falls back to the channel, then to null, when nothing was chosen", () => {
    expect(studioRunVoiceId({ voice_id: "channel_voice" }, null)).toBe("channel_voice");
    expect(studioRunVoiceId({ voice_id: "channel_voice" }, "   ")).toBe("channel_voice");
    expect(studioRunVoiceId(null, null)).toBeNull();
  });

  it("behaves identically to before when called with one argument", () => {
    // Every existing call site passes only the channel; none of them may shift.
    expect(studioRunVoiceId({ voice_id: "channel_voice" })).toBe("channel_voice");
    expect(studioRunVoiceId(null)).toBeNull();
  });
});

describe("studioRunAi84Model — which engine THIS video runs on", () => {
  const base = { provider: "ai84", backendHint: null, globalModel: "eleven_multilingual_v2" } as const;

  it("pins the engine for a voice that came from the CHANNEL, not just the create page", () => {
    // The regression this replaces: the model used to be pinned ONLY for a voice picked on
    // the create page, so a channel voice ran on whatever the global AI84_MODEL said. A
    // client running some channels on ElevenLabs and some on MiniMax could therefore use
    // only one of them at a time — whichever they set, every channel on the other engine
    // failed. A voice is no less chosen for being chosen on the channel.
    expect(
      studioRunAi84Model({ ...base, voiceId: "user_7744_voice_1786013694967", backendHint: null })
    ).toBe("speech-2.8-hd");
    expect(
      studioRunAi84Model({ ...base, voiceId: "Chinese_wenrounvxing", backendHint: "minimax" })
    ).toBe("speech-2.8-hd");
  });

  it("stays out of the way when there is no voice at all", () => {
    expect(studioRunAi84Model({ ...base, voiceId: null })).toBeNull();
    expect(studioRunAi84Model({ ...base, voiceId: "   " })).toBeNull();
  });

  it("does nothing for other providers", () => {
    expect(studioRunAi84Model({ ...base, provider: "elevenlabs", voiceId: "abc" })).toBeNull();
    expect(studioRunAi84Model({ ...base, provider: "", voiceId: "abc" })).toBeNull();
  });

  it("forces MiniMax for a cloned voice, even against a contrary hint", () => {
    // Not a preference — `user_<n>_voice_<ts>` does not exist on ElevenLabs at all, so
    // honouring the hint could only produce VOICE_NOT_FOUND_LOCAL.
    const got = studioRunAi84Model({
      ...base,
      voiceId: "user_7744_voice_1786013694967",
      backendHint: "elevenlabs",
    });
    expect(got).toBe("speech-2.8-hd");
  });

  it("follows the hint for a library voice", () => {
    expect(studioRunAi84Model({ ...base, voiceId: "Chinese_wenrounvxing", backendHint: "minimax" }))
      .toBe("speech-2.8-hd");
    expect(studioRunAi84Model({ ...base, voiceId: "yFgkuUnlOWx3k7ezUZQm", backendHint: "elevenlabs" }))
      .toBe("eleven_multilingual_v2");
  });

  it("keeps the operator's own model when it already matches the engine", () => {
    expect(
      studioRunAi84Model({
        provider: "ai84",
        voiceId: "user_7744_voice_1786013694967",
        backendHint: null,
        globalModel: "speech-2.6-turbo",
      })
    ).toBe("speech-2.6-turbo");
  });

  it("changes NOTHING when the voice and the global model already agree", () => {
    // The guard for every install that is working today: an unresolvable voice, or one on
    // the engine the global model is already on, must synthesize with that exact model.
    for (const globalModel of ["eleven_multilingual_v2", "eleven_flash_v2_5", "speech-2.6-turbo"]) {
      expect(studioRunAi84Model({ provider: "ai84", voiceId: "some_library_voice", backendHint: null, globalModel }))
        .toBe(globalModel);
    }
  });
});

describe("legacyRunVoiceId — legacy HeyGen-TTS pipeline", () => {
  it("keeps the preset's HeyGen voice unchanged", () => {
    expect(legacyRunVoiceId({ heygen_voice_id: "hg_voice" })).toBe("hg_voice");
  });

  it("is null when the preset has no voice", () => {
    expect(legacyRunVoiceId(null)).toBeNull();
    expect(legacyRunVoiceId(undefined)).toBeNull();
    expect(legacyRunVoiceId({ heygen_voice_id: null })).toBeNull();
    expect(legacyRunVoiceId({ heygen_voice_id: "" })).toBeNull();
  });
});

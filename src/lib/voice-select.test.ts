import { describe, it, expect } from "vitest";
import { studioRunVoiceId, legacyRunVoiceId } from "./voice-select";

/**
 * Regression guard for the two-pipeline voice choice. `runs.preset_voice_id` is
 * overloaded, so these lock in that:
 *   - the ElevenLabs studio pipeline never stores a preset's HeyGen voice, and
 *   - the legacy HeyGen-TTS pipeline keeps the preset's HeyGen voice unchanged.
 * If a future refactor re-crosses the wires, this fails loudly.
 */

describe("studioRunVoiceId — ElevenLabs studio pipeline", () => {
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

import { describe, it, expect } from "vitest";
import { missingVoiceRefusal } from "./voice-preflight";
import type { SettingKey } from "./settings";

/**
 * The "does this run have a voice at all?" refusal that /api/studio makes BEFORE the run
 * row exists. Pure — no DB, no network, no mocks needed.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

const from = (o: Record<string, string> = {}) => (k: SettingKey) => o[k] ?? "";

describe("missingVoiceRefusal", () => {
  it("refuses when neither the channel nor the global setting has a voice", () => {
    const msg = missingVoiceRefusal("ai84", null, from());
    expect(msg).toBeTruthy();
    expect(msg).toContain("AI84_VOICE_ID");
    // It must say the run cost nothing — that is the whole point of refusing here.
    expect(msg).toMatch(/nothing was charged/i);
  });

  it("allows a run whose voice comes from the global setting", () => {
    expect(missingVoiceRefusal("ai84", null, from({ AI84_VOICE_ID: "yFgkuUnlOWx3k7ezUZQm" }))).toBeNull();
  });

  it("allows a run whose voice comes only from the channel override", () => {
    expect(missingVoiceRefusal("ai84", "yFgkuUnlOWx3k7ezUZQm", from())).toBeNull();
  });

  it("treats a whitespace-only channel value as absent, like the pipeline does", () => {
    expect(missingVoiceRefusal("ai84", "   ", from())).toBeTruthy();
    expect(missingVoiceRefusal("ai84", "   ", from({ AI84_VOICE_ID: "v" }))).toBeNull();
  });

  it("refuses for every provider whose TTS throws on a blank voice", () => {
    for (const p of ["elevenlabs", "heygen", "minimax", "genaipro", "ai84", "fishaudio", "hume"]) {
      expect(missingVoiceRefusal(p, null, from()), p).toBeTruthy();
    }
  });

  it("never refuses for providers that have a real built-in default voice", () => {
    // 69labs falls back to en-US-GuyNeural and openai to alloy: a blank voice is a
    // WORKING configuration there, so refusing it would break them.
    expect(missingVoiceRefusal("69labs", null, from())).toBeNull();
    expect(missingVoiceRefusal("openai", null, from())).toBeNull();
  });

  it("defaults an empty provider to ElevenLabs, matching the app default", () => {
    expect(missingVoiceRefusal("", null, from())).toContain("ELEVENLABS_VOICE_ID");
    expect(missingVoiceRefusal("", null, from({ ELEVENLABS_VOICE_ID: "v" }))).toBeNull();
  });

  it("is case-insensitive about the provider id", () => {
    expect(missingVoiceRefusal("AI84", null, from())).toBeTruthy();
  });

  it("does not refuse an unknown provider it knows nothing about", () => {
    expect(missingVoiceRefusal("some-new-provider", null, from())).toBeNull();
  });
});

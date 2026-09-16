import { describe, it, expect } from "vitest";
import {
  voiceSourceLabel,
  looksLikeElevenLabsVoiceId,
  describeProviderVoiceRejection,
  ai84VoiceModelMismatch,
  ai33VoiceIdUnqualified,
  ai33LooksLikeVoiceRejection,
} from "./voice-errors";

/**
 * The provider-agnostic voice-rejection message. Pure — no DB, no network.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

describe("looksLikeElevenLabsVoiceId", () => {
  it("accepts a 20-character alphanumeric id", () => {
    expect(looksLikeElevenLabsVoiceId("yFgkuUnlOWx3k7ezUZQm")).toBe(true);
    expect(looksLikeElevenLabsVoiceId("  yFgkuUnlOWx3k7ezUZQm  ")).toBe(true);
  });

  it("rejects an AI84 cloned-voice id and other shapes", () => {
    expect(looksLikeElevenLabsVoiceId("user_7744_voice_1786013694967")).toBe(false);
    expect(looksLikeElevenLabsVoiceId("en-US-GuyNeural")).toBe(false);
    expect(looksLikeElevenLabsVoiceId("")).toBe(false);
  });
});

describe("ai84VoiceModelMismatch", () => {
  it("fires on the client's exact case: a cloned voice against an ElevenLabs model", () => {
    const msg = ai84VoiceModelMismatch("user_7744_voice_1786013694967", "eleven_multilingual_v2");
    expect(msg).toMatch(/cloned voices only exist on AI84's MiniMax engine/);
    expect(msg).toMatch(/speech-/);
  });

  it("stays silent when the model already matches the voice", () => {
    expect(ai84VoiceModelMismatch("user_7744_voice_1786013694967", "speech-2.8-hd")).toBeNull();
  });

  it("stays silent for a voice that isn't a clone", () => {
    expect(ai84VoiceModelMismatch("yFgkuUnlOWx3k7ezUZQm", "eleven_multilingual_v2")).toBeNull();
    // Shaped like a clone but not one — the pattern is anchored, so no false accusation.
    expect(ai84VoiceModelMismatch("user_abc_voice_xyz", "eleven_multilingual_v2")).toBeNull();
  });
});

describe("voiceSourceLabel", () => {
  it("names the channel field or the provider's own setting key", () => {
    expect(voiceSourceLabel(true, "AI84_VOICE_ID")).toMatch(/channel/i);
    expect(voiceSourceLabel(false, "AI84_VOICE_ID")).toContain("AI84_VOICE_ID");
  });
});

describe("describeProviderVoiceRejection", () => {
  const base = {
    providerLabel: "AI84",
    voiceIdKey: "AI84_VOICE_ID",
    rawMsg: "This voice is not available, please choose another one.",
    expectsElevenLabsShape: true,
  };

  it("names the full id, the field to change, and keeps the provider's own words", () => {
    const msg = describeProviderVoiceRejection({
      ...base,
      voiceId: "user_7744_voice_1786013694967",
      fromOverride: false,
    });
    expect(msg).toContain("user_7744_voice_1786013694967");
    expect(msg).toContain("AI84_VOICE_ID");
    expect(msg).toContain("This voice is not available");
  });

  it("adds the shape hint only when the id isn't shaped like what the provider takes", () => {
    const odd = describeProviderVoiceRejection({ ...base, voiceId: "user_7744_voice_1", fromOverride: false });
    const wellShaped = describeProviderVoiceRejection({ ...base, voiceId: "yFgkuUnlOWx3k7ezUZQm", fromOverride: false });
    expect(odd).toMatch(/20 letters\/digits/);
    // A well-shaped id the provider still rejected: the form is not the problem, and
    // saying so would misdirect. The check is advisory, never a verdict.
    expect(wellShaped).not.toMatch(/20 letters\/digits/);
  });

  it("says nothing about charges unless we actually know", () => {
    const unknown = describeProviderVoiceRejection({ ...base, voiceId: "abc", fromOverride: false });
    expect(unknown).not.toMatch(/charged/i);
    const free = describeProviderVoiceRejection({
      ...base,
      voiceId: "abc",
      fromOverride: false,
      chargedForThisAttempt: false,
    });
    expect(free).toMatch(/Nothing was charged for this attempt/);
  });

  it("lets the precise cause replace the vague shape hint, not stack on it", () => {
    const msg = describeProviderVoiceRejection({
      ...base,
      voiceId: "user_7744_voice_1786013694967",
      fromOverride: false,
      suggestion: "Switch the model.",
    });
    expect(msg).toContain("Switch the model.");
    expect(msg).not.toMatch(/20 letters\/digits/);
  });

  it("omits the shape hint entirely for providers that don't take ElevenLabs-shaped ids", () => {
    const msg = describeProviderVoiceRejection({
      providerLabel: "Fish Audio",
      voiceIdKey: "FISHAUDIO_VOICE_ID",
      voiceId: "not-a-fish-id",
      fromOverride: false,
      rawMsg: "nope",
    });
    expect(msg).not.toMatch(/ElevenLabs/);
  });
});

/**
 * ai33.pro. Its whole simplification over AI84 is that the engine lives INSIDE the voice
 * id ("<engine>:<id>"), so there is no engine setting to disagree with the voice. The cost
 * of that is a new way to get it wrong — a bare id names no engine at all, and ai33 has
 * six. That is invisible in the raw rejection, which only says the voice is unavailable.
 */
describe("ai33 voice advisories — actionable, and never confidently wrong", () => {
  it("names the engine-prefix rule for a bare id", () => {
    const msg = ai33VoiceIdUnqualified("en-US-GuyNeural");
    expect(msg).toContain("en-US-GuyNeural");
    expect(msg).toContain("edge");
    expect(msg).toContain("<engine>:<id>");
  });

  it("stays silent for an id that already names a known engine", () => {
    for (const id of ["edge:en-US-GuyNeural", "clone:mine", "MINIMAX:abc"]) {
      expect(ai33VoiceIdUnqualified(id), id).toBeNull();
    }
  });

  it("stays silent for an empty id, which has its own dedicated refusal", () => {
    expect(ai33VoiceIdUnqualified("")).toBeNull();
    expect(ai33VoiceIdUnqualified("   ")).toBeNull();
  });

  it("recognises a voice rejection the shared predicate cannot see", () => {
    // isVoiceRejection needs a 400/404 or the literal `voice_not_found`; a FAILED TASK
    // body carries neither, so without this a bad voice id — the likeliest failure here —
    // would arrive with no hint of which field to change.
    for (const m of [
      "ai33 task t-1 failed: This voice is not available, please choose another one",
      "voice not found",
      "Invalid voice id",
      "The requested voice doesn't exist",
      "unsupported voice",
    ]) {
      expect(ai33LooksLikeVoiceRejection(m), m).toBe(true);
    }
  });

  it("does NOT fire on failures that have nothing to do with the voice", () => {
    // This predicate gates a message that says "change your voice id". Firing it on an
    // unrelated failure would send an operator to change a voice that works — the exact
    // class of confidently-wrong message this module exists to prevent.
    for (const m of [
      "ai33 task t-1 failed: insufficient credits",
      "ai33 task t-1 failed: internal server error",
      "ai33 task t-1 exceeded 600s polling",
      "rate limited, please retry",
      "text is too long",
    ]) {
      expect(ai33LooksLikeVoiceRejection(m), m).toBe(false);
    }
  });
});

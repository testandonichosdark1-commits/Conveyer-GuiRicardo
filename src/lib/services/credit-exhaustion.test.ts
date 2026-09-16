import { describe, it, expect, beforeEach, vi } from "vitest";
import { isCancelled, clearCancelled } from "../cancellation";

const logged: { runId: string; level: string; message: string; stage?: string }[] = [];
vi.mock("../logger", () => ({
  log: (runId: string, level: string, message: string, opts?: { stage?: string }) => {
    logged.push({ runId, level, message, stage: opts?.stage });
  },
}));

const {
  looksLikeCreditExhaustion,
  noteCreditExhausted,
  creditExhaustionHit,
  __resetCreditExhaustionNotice,
} = await import("./credit-exhaustion");

beforeEach(() => {
  logged.length = 0;
  __resetCreditExhaustionNotice();
  clearCancelled("run-a");
  clearCancelled("run-b");
});

describe("looksLikeCreditExhaustion", () => {
  it("recognises kie.ai's real 402 wording, verbatim from a live run", () => {
    expect(
      looksLikeCreditExhaustion(
        "kie.ai /api/v1/jobs/createTask code 402: Credits insufficient : Your current bal"
      )
    ).toBe(true);
  });

  it("recognises the generic phrasings other providers are likely to use", () => {
    for (const msg of [
      "HTTP 402 Payment Required",
      "Insufficient balance for this account",
      "Your account has run out of credits",
      "insufficient funds to complete this request",
      "credits exhausted for this API key",
      "Please add credit to your account",
      "top-up your balance to continue",
    ]) {
      expect(looksLikeCreditExhaustion(msg), msg).toBe(true);
    }
  });

  it("ignores an unrelated failure", () => {
    for (const msg of [
      "voice_not_found: no such voice",
      "Gemini 503: The model is overloaded",
      "fetch failed",
      "422 validation error: missing field",
    ]) {
      expect(looksLikeCreditExhaustion(msg), msg).toBe(false);
    }
  });
});

describe("noteCreditExhausted", () => {
  it("pauses the run the same way a user-initiated Stop does, on the first hit", () => {
    expect(isCancelled("run-a")).toBe(false);
    noteCreditExhausted("run-a", "kie.ai", "kie.ai code 402: Credits insufficient", "visual");
    expect(isCancelled("run-a")).toBe(true);
  });

  it("logs exactly once naming the provider, however many beats hit it", () => {
    for (let i = 0; i < 50; i++) {
      noteCreditExhausted("run-a", "kie.ai", "kie.ai code 402: Credits insufficient", "visual");
    }
    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe("error");
    expect(logged[0].message).toContain("KIE.AI OUT OF CREDIT");
  });

  it("still pauses even though the phrasing describes a DIFFERENT provider than the first one seen", () => {
    // The whole point: whichever provider goes dry first, not just the one this test wrote.
    noteCreditExhausted("run-a", "ai33", "ai33 create 402: insufficient credits", "tts");
    expect(creditExhaustionHit("run-a")).toBe("ai33");
    // A second, different provider failing the same way must not log again or overwrite it.
    noteCreditExhausted("run-a", "heygen", "HeyGen 402: insufficient balance", "avatar_video");
    expect(logged).toHaveLength(1);
    expect(creditExhaustionHit("run-a")).toBe("ai33");
  });

  it("does not pause for a failure that isn't credit exhaustion", () => {
    noteCreditExhausted("run-a", "kie.ai", "kie.ai code 422: bad prompt", "visual");
    expect(isCancelled("run-a")).toBe(false);
    expect(logged).toHaveLength(0);
  });

  it("never touches a different run", () => {
    noteCreditExhausted("run-a", "kie.ai", "kie.ai code 402: Credits insufficient", "visual");
    expect(isCancelled("run-b")).toBe(false);
    expect(creditExhaustionHit("run-b")).toBeNull();
  });
});

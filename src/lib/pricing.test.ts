import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Key-free unit tests for the pure pricing helpers. We mock ./settings so the
 * rates come from a controlled in-memory store — no DB, no API keys, deterministic.
 */
const store = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("./settings", () => ({ getSetting: (k: string) => store.values[k] ?? "" }));

import { priceElevenlabs, priceGeminiTokens, priceKieImage, priceKieVeo, priceHeygen, priceLabs69Video, priceGroqTranscription, priceRunwareImage, priceFishAudio, priceHume } from "./pricing";

/** FX defaults to 1 so EUR == USD and the arithmetic is easy to assert. */
function setRates(r: Record<string, string>) {
  store.values = { COST_USD_TO_EUR: "1", ...r };
}

beforeEach(() => setRates({}));

describe("usdToEur", () => {
  it("applies the configurable FX rate", () => {
    setRates({ COST_USD_TO_EUR: "0.5", COST_ELEVENLABS_TIER: "Custom", COST_ELEVENLABS_USD_PER_1K_CHARS: "1.00" });
    expect(priceElevenlabs(1000).amountEur).toBeCloseTo(0.5, 6); // $1.00 × 0.5
  });
});

describe("priceFishAudio", () => {
  it("bills per MILLION UTF-8 BYTES at the list rate", () => {
    setRates({ COST_FISHAUDIO_USD_PER_1M_BYTES: "15.00" });
    expect(priceFishAudio(1_000_000).amountEur).toBeCloseTo(15, 6);
    expect(priceFishAudio(100_000).amountEur).toBeCloseTo(1.5, 6);
  });

  it("labels the unit as bytes, so the Costs page can't be read as characters", () => {
    setRates({ COST_FISHAUDIO_USD_PER_1M_BYTES: "15.00" });
    const p = priceFishAudio(2400);
    expect(p.unitLabel).toBe("utf8-bytes");
    expect(p.units).toBe(2400);
  });

  it("supports the free tier and never goes negative", () => {
    setRates({ COST_FISHAUDIO_USD_PER_1M_BYTES: "0" });
    expect(priceFishAudio(5_000_000).amountEur).toBe(0);
    setRates({ COST_FISHAUDIO_USD_PER_1M_BYTES: "15.00" });
    expect(priceFishAudio(-100).amountEur).toBe(0);
  });

  it("a blank rate prices at 0 while still recording the byte count", () => {
    // Same convention as every other rate here (Number("") === 0, so `num`'s fallback
    // only catches non-numeric values). The $15 list price ships via DEFAULTS, asserted
    // in providers/settings — so a real install is never silently priced at zero.
    setRates({});
    const p = priceFishAudio(1_000_000);
    expect(p.amountEur).toBe(0);
    expect(p.units).toBe(1_000_000);
  });
});

describe("priceHume", () => {
  it("bills per 1000 characters at the configured tier rate", () => {
    setRates({ COST_HUME_USD_PER_1K_CHARS: "0.15" });
    expect(priceHume(1000).amountEur).toBeCloseTo(0.15, 6);
    setRates({ COST_HUME_USD_PER_1K_CHARS: "0.05" }); // Business tier
    expect(priceHume(1000).amountEur).toBeCloseTo(0.05, 6);
  });

  it("records chars as the unit, and prices at 0 on a blank rate", () => {
    setRates({});
    expect(priceHume(2000).amountEur).toBe(0);
    expect(priceHume(2000).unitLabel).toBe("chars");
    expect(priceHume(2000).units).toBe(2000);
  });
});

describe("priceElevenlabs", () => {
  it("bills per 1000 chars at the manual rate", () => {
    setRates({ COST_ELEVENLABS_TIER: "Custom", COST_ELEVENLABS_USD_PER_1K_CHARS: "0.22" });
    expect(priceElevenlabs(1000).amountEur).toBeCloseTo(0.22, 6);
    expect(priceElevenlabs(500).amountEur).toBeCloseTo(0.11, 6);
    expect(priceElevenlabs(0).amountEur).toBe(0);
  });
  it("uses the Creator tier table when a tier is picked", () => {
    setRates({ COST_ELEVENLABS_TIER: "Creator", ELEVENLABS_MODEL: "eleven_multilingual_v2" });
    expect(priceElevenlabs(1000).amountEur).toBeCloseTo(0.22, 6);
  });
  it("halves the tier rate for flash/turbo models (0.5 credit/char)", () => {
    setRates({ COST_ELEVENLABS_TIER: "Creator", ELEVENLABS_MODEL: "eleven_flash_v2_5" });
    expect(priceElevenlabs(1000).amountEur).toBeCloseTo(0.11, 6);
  });
});

describe("priceGeminiTokens", () => {
  it("prices input + output per 1M tokens", () => {
    setRates({ COST_GEMINI_IN_USD_PER_1M: "0.30", COST_GEMINI_OUT_USD_PER_1M: "2.50" });
    expect(priceGeminiTokens(1_000_000, 1_000_000).amountEur).toBeCloseTo(2.8, 6);
    expect(priceGeminiTokens(500_000, 0).amountEur).toBeCloseTo(0.15, 6);
    expect(priceGeminiTokens(0, 0).amountEur).toBe(0);
  });
});

describe("priceKieImage / priceKieVeo", () => {
  it("prices images per unit and Veo per second", () => {
    setRates({ COST_KIE_IMAGE_USD: "0.02", COST_KIE_VEO_USD_PER_SEC: "0.40" });
    expect(priceKieImage(5).amountEur).toBeCloseTo(0.1, 6);
    expect(priceKieVeo(3).amountEur).toBeCloseTo(1.2, 6);
  });
});

describe("priceHeygen", () => {
  it("bills per minute from the manual rate", () => {
    setRates({ COST_HEYGEN_USD_PER_MIN: "1.90" });
    expect(priceHeygen(60).amountEur).toBeCloseTo(1.9, 6);
    expect(priceHeygen(30).amountEur).toBeCloseTo(0.95, 6);
  });
  it("falls back to 3.00/min (Avatar IV default) when the configured rate is non-numeric", () => {
    setRates({ COST_HEYGEN_USD_PER_MIN: "oops" });
    expect(priceHeygen(60).amountEur).toBeCloseTo(3.0, 6);
  });
  it("bills the Unlimited engine at its own (cheaper) rate", () => {
    setRates({ COST_HEYGEN_USD_PER_MIN: "3.00", COST_HEYGEN_UNLIMITED_USD_PER_MIN: "1.00" });
    expect(priceHeygen(60, true).amountEur).toBeCloseTo(3.0, 6); // AvatarIV
    expect(priceHeygen(60, false).amountEur).toBeCloseTo(1.0, 6); // Unlimited
    expect(priceHeygen(60).amountEur).toBeCloseTo(3.0, 6); // defaults to Avatar IV
  });
  it("falls back to 1.00/min for Unlimited when the configured rate is non-numeric", () => {
    setRates({ COST_HEYGEN_UNLIMITED_USD_PER_MIN: "oops" });
    expect(priceHeygen(60, false).amountEur).toBeCloseTo(1.0, 6);
  });
  // HeyGen's API is pay-as-you-go: no subscription tier ever applies. The old
  // Free/Creator/Team table modelled its WEB plans and used to override the engine rate.
  it("has no subscription-tier override — the engine rate always wins", () => {
    setRates({ COST_HEYGEN_USD_PER_MIN: "3.00", COST_HEYGEN_UNLIMITED_USD_PER_MIN: "1.00" });
    expect(priceHeygen(60, true).amountEur).toBeCloseTo(3.0, 6);
    expect(priceHeygen(60, false).amountEur).toBeCloseTo(1.0, 6);
  });
});

describe("priceLabs69Video", () => {
  it("records €0 by default (no rate) but honors a configured rate", () => {
    setRates({});
    expect(priceLabs69Video(3).amountEur).toBe(0);
    setRates({ COST_LABS69_USD_PER_VIDEO: "0.50" });
    expect(priceLabs69Video(3).amountEur).toBeCloseTo(1.5, 6);
  });
});

describe("priceRunwareImage", () => {
  it("records the REAL reported cost and marks the row NOT estimated", () => {
    // The whole point of Runware in the ledger: this is money, not a model.
    setRates({ COST_USD_TO_EUR: "0.92" });
    const p = priceRunwareImage(1, 0.0051);
    expect(p.amountEur).toBeCloseTo(0.0051 * 0.92, 9);
    expect(p.estimated).toBe(false);
    expect(p.units).toBe(1);
    expect(p.unitLabel).toBe("images");
  });

  it("takes the reported cost VERBATIM — it is the task's cost, not a per-unit rate", () => {
    setRates({ COST_USD_TO_EUR: "1", COST_RUNWARE_IMAGE_USD: "99" });
    expect(priceRunwareImage(1, 0.02).amountEur).toBeCloseTo(0.02, 9);
  });

  it("falls back to the configurable rate — and to €0 — when nothing was reported", () => {
    // No fabrication: an unreported cost records the unit at €0.00, like Magnific/69labs.
    setRates({ COST_USD_TO_EUR: "1" });
    const none = priceRunwareImage(1, null);
    expect(none.amountEur).toBe(0);
    expect(none.estimated).toBe(true);

    setRates({ COST_USD_TO_EUR: "1", COST_RUNWARE_IMAGE_USD: "0.005" });
    const rated = priceRunwareImage(2, null);
    expect(rated.amountEur).toBeCloseTo(0.01, 9);
    expect(rated.estimated).toBe(true); // a configured RATE is still an estimate
  });

  it("treats undefined like null, and rejects a nonsense reported value", () => {
    setRates({ COST_USD_TO_EUR: "1", COST_RUNWARE_IMAGE_USD: "0.005" });
    expect(priceRunwareImage(1, undefined).estimated).toBe(true);
    expect(priceRunwareImage(1, NaN).estimated).toBe(true);
    expect(priceRunwareImage(1, -1).estimated).toBe(true); // never credit money back
  });

  it("honors a real reported cost of exactly 0 (a free/promotional generation)", () => {
    setRates({ COST_USD_TO_EUR: "1", COST_RUNWARE_IMAGE_USD: "0.005" });
    const p = priceRunwareImage(1, 0);
    expect(p.amountEur).toBe(0);
    expect(p.estimated).toBe(false); // 0 was REPORTED, so it is real — not the fallback rate
  });
});

describe("priceGroqTranscription", () => {
  it("bills per hour of AUDIO, not per call", () => {
    setRates({ COST_GROQ_USD_PER_AUDIO_HOUR: "0.111" });
    expect(priceGroqTranscription(3600).amountEur).toBeCloseTo(0.111, 6); // exactly one hour
    expect(priceGroqTranscription(1800).amountEur).toBeCloseTo(0.0555, 6); // half an hour
  });

  it("meters the clip duration in seconds", () => {
    setRates({ COST_GROQ_USD_PER_AUDIO_HOUR: "0.111" });
    const p = priceGroqTranscription(125);
    expect(p.units).toBe(125);
    expect(p.unitLabel).toBe("audio-sec");
    expect(p.estimated).toBe(true);
  });

  it("a typical 2-minute voiceover costs a fraction of a cent", () => {
    // The real-world sanity check: this must never look like a meaningful line item.
    setRates({ COST_GROQ_USD_PER_AUDIO_HOUR: "0.111" });
    expect(priceGroqTranscription(120).amountEur).toBeLessThan(0.005);
  });

  it("falls back to the published rate only on a NON-NUMERIC value, per num() semantics", () => {
    // num() treats an EMPTY setting as 0 (Number("") === 0, which is finite and >= 0), so an
    // unset rate meters €0 — the same convention priceLabs69Video is asserted on above. In a
    // real install the key is never empty: DEFAULTS seeds "0.111" on first boot, and
    // seedDefaults backfills it into existing DBs because it only inserts MISSING keys.
    setRates({});
    expect(priceGroqTranscription(3600).amountEur).toBe(0);
    // Garbage IS caught by the fallback (Number("x") is NaN → not finite).
    setRates({ COST_GROQ_USD_PER_AUDIO_HOUR: "not-a-number" });
    expect(priceGroqTranscription(3600).amountEur).toBeCloseTo(0.111, 6);
    // A negative rate can never credit money back.
    setRates({ COST_GROQ_USD_PER_AUDIO_HOUR: "-5" });
    expect(priceGroqTranscription(3600).amountEur).toBeCloseTo(0.111, 6);
  });

  it("clamps negative durations to zero rather than crediting money back", () => {
    setRates({ COST_GROQ_USD_PER_AUDIO_HOUR: "0.111" });
    expect(priceGroqTranscription(-500).amountEur).toBe(0);
    expect(priceGroqTranscription(-500).units).toBe(0);
  });

  it("honors a zero rate (operator on a free tier)", () => {
    setRates({ COST_GROQ_USD_PER_AUDIO_HOUR: "0" });
    expect(priceGroqTranscription(3600).amountEur).toBe(0);
  });
});

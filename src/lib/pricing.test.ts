import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Key-free unit tests for the pure pricing helpers. We mock ./settings so the
 * rates come from a controlled in-memory store — no DB, no API keys, deterministic.
 */
const store = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("./settings", () => ({ getSetting: (k: string) => store.values[k] ?? "" }));

import { priceElevenlabs, priceGeminiTokens, priceKieImage, priceKieVeo, priceHeygen, priceLabs69Video } from "./pricing";

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
    setRates({ COST_HEYGEN_TIER: "Custom", COST_HEYGEN_USD_PER_MIN: "1.90" });
    expect(priceHeygen(60).amountEur).toBeCloseTo(1.9, 6);
    expect(priceHeygen(30).amountEur).toBeCloseTo(0.95, 6);
  });
  it("falls back to 1.90/min when the configured rate is non-numeric (the corrected default)", () => {
    setRates({ COST_HEYGEN_TIER: "Custom", COST_HEYGEN_USD_PER_MIN: "oops" });
    expect(priceHeygen(60).amountEur).toBeCloseTo(1.9, 6);
  });
  it("uses the Creator tier table (1.90/min)", () => {
    setRates({ COST_HEYGEN_TIER: "Creator" });
    expect(priceHeygen(60).amountEur).toBeCloseTo(1.9, 6);
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

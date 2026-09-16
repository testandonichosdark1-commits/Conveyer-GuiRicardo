import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Read-time pricing — the mechanism that lets a corrected rate reach HISTORY.
 *
 * The defect these tests exist for: `amount_eur` used to be computed once, at write
 * time, and frozen. An operator who filled in the 69labs rate still saw €0.00 against
 * 382 already-recorded videos, because nothing ever revisited those rows. Now the
 * ledger stores the priceable facts and `priceRow` values them against current
 * settings on every read.
 */
const store = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("./settings", () => ({ getSetting: (k: string) => store.values[k] ?? "" }));

import { priceRow, rateFor, geminiRateKind, RATE_KINDS, isRateKind } from "./pricing";

/** FX defaults to 1 so EUR == USD and the arithmetic is easy to assert. */
function setRates(r: Record<string, string>) {
  store.values = { COST_USD_TO_EUR: "1", ...r };
}
beforeEach(() => setRates({}));

describe("priceRow — repricing history", () => {
  it("values a row at the CURRENT rate, not the one it was written at", () => {
    // As recorded when COST_LABS69_USD_PER_VIDEO was still 0.
    const asWritten = { rateKind: "69labs:video", units: 382, amountEur: 0 };

    expect(priceRow(asWritten).eur).toBe(0);

    setRates({ COST_LABS69_USD_PER_VIDEO: "0.15" });
    const after = priceRow(asWritten);
    expect(after.eur).toBeCloseTo(57.3, 6); // 382 × $0.15
    expect(after.repriced).toBe(true);
  });

  it("applies the per-unit divisor (per-1k, per-1M, per-minute)", () => {
    setRates({
      COST_HUME_USD_PER_1K_CHARS: "0.15",
      COST_FISHAUDIO_USD_PER_1M_BYTES: "15.00",
      COST_HEYGEN_AVATAR_V_USD_PER_MIN: "4.00",
      COST_GROQ_USD_PER_AUDIO_HOUR: "0.111",
    });
    expect(priceRow({ rateKind: "hume", units: 2000, amountEur: 0 }).eur).toBeCloseTo(0.3, 6);
    expect(priceRow({ rateKind: "fishaudio", units: 500_000, amountEur: 0 }).eur).toBeCloseTo(7.5, 6);
    expect(priceRow({ rateKind: "heygen:avatar_v", units: 30, amountEur: 0 }).eur).toBeCloseTo(2, 6);
    expect(priceRow({ rateKind: "groq", units: 1800, amountEur: 0 }).eur).toBeCloseTo(0.0555, 6);
  });

  it("carries the current FX rate, so correcting it restates everything", () => {
    setRates({ COST_USD_TO_EUR: "0.5", COST_KIE_VEO_USD_PER_SEC: "0.40" });
    expect(priceRow({ rateKind: "kie:veo", units: 10, amountEur: 99 }).eur).toBeCloseTo(2, 6);
  });
});

describe("priceRow — real money is never overwritten by a guess", () => {
  it("prefers a provider-reported USD amount over any configured rate", () => {
    setRates({ COST_RUNWARE_IMAGE_USD: "999" });
    const p = priceRow({ rateKind: "runware:image", units: 1, amountUsd: 0.13, amountEur: 0.12 });
    expect(p.eur).toBeCloseTo(0.13, 6);
    expect(p.real).toBe(true);
  });

  it("keeps the AS-RECORDED euro for real spend whose USD predates the column", () => {
    // The regression this guards: 64 Runware rows hold €7.00 of genuinely billed
    // spend but no `amount_usd`, and their fallback rate is 0. Repricing them by
    // units would silently erase real money to €0.00. `estimated: false` says
    // "this euro came from the provider" — keep it.
    setRates({ COST_RUNWARE_IMAGE_USD: "0" });
    const p = priceRow({ rateKind: "runware:image", units: 55, amountEur: 7.001, estimated: false });
    expect(p.eur).toBeCloseTo(7.001, 6);
    expect(p.real).toBe(true);
    expect(p.repriced).toBe(false);
  });
});

describe("priceRow — falls back rather than fabricating", () => {
  it("uses the as-recorded euro when the row has no rate_kind", () => {
    const p = priceRow({ rateKind: null, units: 5, amountEur: 1.23 });
    expect(p.eur).toBeCloseTo(1.23, 6);
    expect(p.repriced).toBe(false);
  });

  it("will not reprice a Gemini row whose in/out token split was never stored", () => {
    // Rows written before `units_out` existed only have the TOTAL. Splitting it by
    // guesswork would invent history, and the two rates differ ~6x.
    setRates({ COST_GEMINI_IN_USD_PER_1M: "1.50", COST_GEMINI_OUT_USD_PER_1M: "9.00" });
    const p = priceRow({ rateKind: "gemini:std", units: 1_000_000, unitsOut: null, amountEur: 0.42 });
    expect(p.eur).toBeCloseTo(0.42, 6);
    expect(p.repriced).toBe(false);
  });

  it("prices a Gemini row with the split at both rates", () => {
    setRates({ COST_GEMINI_IN_USD_PER_1M: "1.50", COST_GEMINI_OUT_USD_PER_1M: "9.00" });
    const p = priceRow({ rateKind: "gemini:std", units: 1_000_000, unitsOut: 200_000, amountEur: 0 });
    // 800k in × $1.50/M + 200k out × $9.00/M
    expect(p.eur).toBeCloseTo(0.8 * 1.5 + 0.2 * 9.0, 6);
    expect(p.repriced).toBe(true);
  });
});

describe("rateFor — an unset rate is 'unpriced', not 'free'", () => {
  it("reports rateKnown=false when nothing is configured", () => {
    setRates({});
    expect(rateFor("69labs:video")?.known).toBe(false);
    expect(priceRow({ rateKind: "69labs:video", units: 382, amountEur: 0 }).rateKnown).toBe(false);
  });

  it("reports rateKnown=true once the operator sets one", () => {
    setRates({ COST_LABS69_USD_PER_VIDEO: "0.15" });
    expect(rateFor("69labs:video")?.known).toBe(true);
  });

  it("resolves every declared rate kind, and nothing else", () => {
    // Pins the closed set: a recorder cannot emit a kind the read side can't price.
    for (const k of RATE_KINDS) expect(rateFor(k), k).not.toBeNull();
    expect(rateFor("nope:nope")).toBeNull();
    expect(isRateKind("heygen:avatar_v")).toBe(true);
    expect(isRateKind(null)).toBe(false);
  });
});

describe("geminiRateKind — the MODEL picks the rate, not the call site", () => {
  it("routes the lite family to the lite rates", () => {
    expect(geminiRateKind("gemini-3.1-flash-lite")).toBe("gemini:lite");
    expect(geminiRateKind("gemini-2.5-flash-lite")).toBe("gemini:lite");
  });

  it("routes everything else to the standard rates", () => {
    expect(geminiRateKind("gemini-3.5-flash")).toBe("gemini:std");
    expect(geminiRateKind("gemini-2.5-flash")).toBe("gemini:std");
    expect(geminiRateKind("gemini-3.6-flash")).toBe("gemini:std");
  });

  it("does not depend on the caller's role", () => {
    // The old rule billed the planner ("geminiText") at the standard rate and the
    // scorer ("geminiVision") at the lite rate. An install running a lite model as
    // SCENE_SPLIT_MODEL therefore paid ~6x on paper for every planner call.
    setRates({
      COST_GEMINI_IN_USD_PER_1M: "1.50",
      COST_GEMINI_OUT_USD_PER_1M: "9.00",
      COST_GEMINI_LITE_IN_USD_PER_1M: "0.25",
      COST_GEMINI_LITE_OUT_USD_PER_1M: "1.50",
    });
    const planner = priceRow({
      rateKind: geminiRateKind("gemini-3.1-flash-lite"), // what the planner actually runs
      units: 1_000_000,
      unitsOut: 0,
      amountEur: 0,
    });
    expect(planner.eur).toBeCloseTo(0.25, 6); // lite, not 1.50
  });
});

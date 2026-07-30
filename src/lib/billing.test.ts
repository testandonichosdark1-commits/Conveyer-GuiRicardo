import { describe, it, expect, vi } from "vitest";

/**
 * Key-free unit tests for the billing math. We mock ./settings so importing
 * billing.ts (which imports getSetting/setSetting) never touches the DB. The pure
 * functions under test don't read settings — they take everything as arguments.
 */
const store = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("./settings", () => ({
  getSetting: (k: string) => store.values[k] ?? "",
  setSetting: (k: string, v: string) => {
    store.values[k] = v;
  },
}));

import {
  elevenlabsCharsToCredits,
  heygenSecondsToCredits,
  effectiveAllocationEur,
  subscriptionView,
  providerBillingMode,
  billingPeriod,
  SUB_META,
  getBillingProfiles,
  isSubProvider,
} from "./billing";

describe("unit → credits conversion", () => {
  it("ElevenLabs chars → credits (1/char, Flash 0.5/char)", () => {
    expect(elevenlabsCharsToCredits(1000, false)).toBe(1000);
    expect(elevenlabsCharsToCredits(1000, true)).toBe(500);
    expect(elevenlabsCharsToCredits(-5, false)).toBe(0);
  });
  it("HeyGen clip-seconds → credits via credits/minute", () => {
    // 20 credits/min → 60s = 20 credits, 30s = 10 credits
    expect(heygenSecondsToCredits(60, 20)).toBeCloseTo(20, 6);
    expect(heygenSecondsToCredits(30, 20)).toBeCloseTo(10, 6);
    expect(heygenSecondsToCredits(0, 20)).toBe(0);
  });
});

describe("effectiveAllocationEur — pro-rata subscription share (2nd reporting layer)", () => {
  it("worked example: Creator $22 / 100k, 4,500 credits → $0.99 (fee passed in plan currency)", () => {
    // Pure math is currency-agnostic; the API passes monthlyEur (USD×fx). Here we pass 22 to
    // reproduce the user's exact example: 22 × 4500/100000 = 0.99.
    expect(effectiveAllocationEur(4_500, 22, 100_000)).toBeCloseTo(0.99, 6);
  });
  it("scales linearly with usage", () => {
    expect(effectiveAllocationEur(9_000, 22, 100_000)).toBeCloseTo(1.98, 6);
    expect(effectiveAllocationEur(0, 22, 100_000)).toBe(0);
  });
  it("free plan (fee 0) with known quota → 0, not null", () => {
    expect(effectiveAllocationEur(5_000, 0, 10_000)).toBe(0);
  });
  it("unknown / unlimited / zero quota → null (not allocatable, so caller shows —)", () => {
    expect(effectiveAllocationEur(5_000, 29, 0)).toBeNull();
    expect(effectiveAllocationEur(5_000, 29, -1)).toBeNull();
    expect(effectiveAllocationEur(5_000, 29, Number.NaN)).toBeNull();
  });
  it("overage (used > quota) keeps the STABLE plan rate — allocation exceeds the fee, by design", () => {
    // 150k on a 100k/$22 plan → 150000 × (22/100000) = 33. Average costing at the list rate;
    // real overage is carried separately in the Variable bucket, not here.
    expect(effectiveAllocationEur(150_000, 22, 100_000)).toBeCloseTo(33, 6);
  });
  it("clamps negative usage/fee to 0", () => {
    expect(effectiveAllocationEur(-5_000, 22, 100_000)).toBe(0);
    expect(effectiveAllocationEur(5_000, -22, 100_000)).toBe(0);
  });
  it("both providers: caller sums the two shares (HeyGen Creator $29 / 200, 40 credits = $5.80)", () => {
    const heygen = effectiveAllocationEur(40, 29, 200); // 40 × 29/200 = 5.8
    const eleven = effectiveAllocationEur(4_500, 22, 100_000); // 0.99
    expect(heygen).toBeCloseTo(5.8, 6);
    expect((heygen ?? 0) + (eleven ?? 0)).toBeCloseTo(6.79, 6);
  });
});

describe("subscriptionView — known plan", () => {
  it("within quota: fee shown, 0 overage, correct %", () => {
    const v = subscriptionView("elevenlabs", { mode: "subscription", plan: "Creator" }, 34_000);
    expect(v.monthlyUsd).toBe(22);
    expect(v.quotaCredits).toBe(100_000);
    expect(v.usedCredits).toBe(34_000);
    expect(v.pct).toBeCloseTo(34, 6);
    expect(v.overageCredits).toBe(0);
    expect(v.overageUsd).toBe(0);
  });
  it("over quota: overage billed at the provider rate", () => {
    // Creator quota 100k; use 150k → 50k overage × 0.00022 = $11
    const v = subscriptionView("elevenlabs", { mode: "subscription", plan: "Creator" }, 150_000);
    expect(v.pct).toBeCloseTo(150, 6);
    expect(v.overageCredits).toBe(50_000);
    expect(v.overageUsd).toBeCloseTo(11, 6);
  });
  it("HeyGen Creator: overage at $0.05/credit", () => {
    // Creator quota 200 credits; use 260 → 60 overage × 0.05 = $3
    const v = subscriptionView("heygen", { mode: "subscription", plan: "Creator" }, 260);
    expect(v.monthlyUsd).toBe(29);
    expect(v.quotaCredits).toBe(200);
    expect(v.overageCredits).toBe(60);
    expect(v.overageUsd).toBeCloseTo(3, 6);
  });
});

describe("subscriptionView — Custom plan", () => {
  it("uses the user-entered fee + quota", () => {
    const v = subscriptionView("elevenlabs", { mode: "subscription", plan: "Custom", monthlyUsd: 30, quotaCredits: 120_000 }, 60_000);
    expect(v.plan).toBe("Custom");
    expect(v.monthlyUsd).toBe(30);
    expect(v.quotaCredits).toBe(120_000);
    expect(v.pct).toBeCloseTo(50, 6);
    expect(v.overageCredits).toBe(0);
  });
  it("no/zero quota NEVER invents overage or a full bar (bugfix)", () => {
    // Custom plan, quota field left blank → quota unknown.
    const empty = subscriptionView("elevenlabs", { mode: "subscription", plan: "Custom", monthlyUsd: 30 }, 0);
    expect(empty.quotaKnown).toBe(false);
    expect(empty.pct).toBe(0);
    expect(empty.overageCredits).toBe(0);
    // Even WITH usage, unknown quota → pct 0, overage 0 (no phantom charge).
    const used = subscriptionView("elevenlabs", { mode: "subscription", plan: "Custom", monthlyUsd: 30 }, 5000);
    expect(used.quotaKnown).toBe(false);
    expect(used.pct).toBe(0);
    expect(used.overageCredits).toBe(0);
    expect(used.overageUsd).toBe(0);
    // A real quota still reports quotaKnown=true.
    const withQuota = subscriptionView("elevenlabs", { mode: "subscription", plan: "Creator" }, 5000);
    expect(withQuota.quotaKnown).toBe(true);
  });
});

describe("billingPeriod — one configurable clock", () => {
  const MID_JUL = Date.UTC(2026, 6, 6); // 2026-07-06
  it("day 1 → plain calendar month", () => {
    const p = billingPeriod(MID_JUL, 1);
    expect(p.startIso).toBe("2026-07-01T00:00:00.000Z");
    expect(p.label).toBe("Jul 1 – Jul 31, 2026 (UTC)");
    expect(p.startDay).toBe(1);
  });
  it("anchor after today's day → window started last month", () => {
    const p = billingPeriod(MID_JUL, 14); // today is the 6th, before 14th
    expect(p.startIso).toBe("2026-06-14T00:00:00.000Z");
    expect(p.label).toBe("Jun 14 – Jul 13, 2026 (UTC)");
  });
  it("anchor on/before today's day → window is the current one", () => {
    const p = billingPeriod(Date.UTC(2026, 6, 20), 14); // today is the 20th
    expect(p.startIso).toBe("2026-07-14T00:00:00.000Z");
    expect(p.label).toBe("Jul 14 – Aug 13, 2026 (UTC)");
  });
  it("clamps startDay to 1–28", () => {
    expect(billingPeriod(MID_JUL, 0).startDay).toBe(1);
    expect(billingPeriod(MID_JUL, 31).startDay).toBe(28);
    expect(billingPeriod(MID_JUL, 99).startDay).toBe(28);
  });
});

describe("providerBillingMode — the single read-side classifier", () => {
  it("ElevenLabs / HeyGen are ALWAYS subscription (no payg toggle)", () => {
    expect(providerBillingMode("elevenlabs")).toBe("subscription");
    expect(providerBillingMode("heygen")).toBe("subscription");
    expect(providerBillingMode("HeyGen")).toBe("subscription"); // case-insensitive
  });
  it("metered providers → payg (raw strings may carry a ':model' suffix)", () => {
    expect(providerBillingMode("gemini:gemini-2.5-flash")).toBe("payg");
    expect(providerBillingMode("kie:veo")).toBe("payg");
    expect(providerBillingMode("kie:nano-banana")).toBe("payg");
    expect(providerBillingMode("69labs")).toBe("payg");
    expect(providerBillingMode("minimax")).toBe("payg");
    expect(providerBillingMode("")).toBe("payg"); // unknown → payg (never hides a real cost)
  });
  it("free stock providers → free", () => {
    expect(providerBillingMode("pexels")).toBe("free");
    expect(providerBillingMode("pixabay")).toBe("free");
  });
});

describe("monthly reconciliation — Total = Fixed + Variable, subs excluded from Variable", () => {
  it("classifier splits a ledger so no subscription euro leaks into Variable", () => {
    // A month of raw ledger rows (as run_costs stores them).
    const monthRows = [
      { provider: "gemini:gemini-2.5-flash", amountEur: 0.71 },
      { provider: "kie:nano-banana", amountEur: 0.5 },
      { provider: "elevenlabs", amountEur: 1.23 }, // subscription — must NOT count
      { provider: "heygen", amountEur: 0.61 }, // subscription — must NOT count
    ];
    const variablePayg = monthRows
      .filter((r) => providerBillingMode(r.provider) === "payg")
      .reduce((s, r) => s + r.amountEur, 0);
    expect(variablePayg).toBeCloseTo(1.21, 6); // only gemini + kie

    const fixedMonthly = 20.24; // e.g. ElevenLabs Creator €/mo
    const overage = 0; // within quota
    const variable = variablePayg + overage;
    const total = fixedMonthly + variable;
    expect(total).toBeCloseTo(fixedMonthly + variablePayg, 6); // identity holds
    // Subscriptions' metered euros (1.23 + 0.61) appear nowhere in the total.
    expect(total).toBeCloseTo(21.45, 6);
  });
});

describe("metadata + profiles", () => {
  it("SUB_META has the expected providers and Creator tiers", () => {
    expect(SUB_META.elevenlabs.plans.find((p) => p.id === "Creator")?.monthlyUsd).toBe(22);
    expect(SUB_META.heygen.plans.find((p) => p.id === "Creator")?.monthlyUsd).toBe(29);
    expect(isSubProvider("elevenlabs")).toBe(true);
    expect(isSubProvider("kie")).toBe(false);
  });
  it("getBillingProfiles parses JSON and fails open to {}", () => {
    store.values.BILLING_PROFILES = JSON.stringify({ elevenlabs: { mode: "subscription", plan: "Creator" } });
    expect(getBillingProfiles().elevenlabs.plan).toBe("Creator");
    store.values.BILLING_PROFILES = "not json";
    expect(getBillingProfiles()).toEqual({});
    store.values.BILLING_PROFILES = "";
    expect(getBillingProfiles()).toEqual({});
  });
});

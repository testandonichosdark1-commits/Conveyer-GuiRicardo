/**
 * Cost billing model — interprets metered usage through each provider's REAL
 * billing model so the /costs page stops showing a misleading amortized per-unit
 * number for subscription providers (ElevenLabs, HeyGen).
 *
 * pricing.ts still meters pay-as-you-go providers per unit (that estimate is
 * honest). This layer adds: (1) auto-detect which providers a user has (from
 * configured API keys), (2) the user's chosen plan per subscription provider
 * (stored in the BILLING_PROFILES setting), and (3) the pure math that turns
 * recorded usage into a fee + quota-usage + overage view.
 *
 * The pure functions at the bottom read NO settings/DB so they are unit-testable;
 * currency here is USD (provider plans are priced in USD) — the API layer converts
 * to EUR with the existing COST_USD_TO_EUR rate to keep the page single-currency.
 */
import { getSetting, setSetting } from "./settings";

export type BillingType = "subscription" | "payg" | "free";

export interface CostProviderMeta {
  id: string;
  label: string;
  apiKeySetting: string;
  billingType: BillingType;
}

/**
 * Cost-relevant providers + the setting holding their API key (drives auto-detect).
 * apiKeySetting values mirror providers.ts / settings.ts. Providers we don't meter
 * a cost for yet (minimax/groq/genaipro) are still listed so the UI can show them.
 */
export const COST_PROVIDERS: CostProviderMeta[] = [
  { id: "elevenlabs", label: "ElevenLabs", apiKeySetting: "ELEVENLABS_API_KEY", billingType: "subscription" },
  { id: "heygen", label: "HeyGen", apiKeySetting: "HEYGEN_API_KEY", billingType: "subscription" },
  { id: "gemini", label: "Google Gemini", apiKeySetting: "GOOGLE_API_KEY", billingType: "payg" },
  { id: "kie", label: "kie.ai", apiKeySetting: "KIE_API_KEY", billingType: "payg" },
  { id: "69labs", label: "69labs", apiKeySetting: "LABS69_API_KEY", billingType: "payg" },
  { id: "magnific", label: "Magnific AI", apiKeySetting: "MAGNIFIC_API_KEY", billingType: "payg" },
  { id: "minimax", label: "MiniMax", apiKeySetting: "MINIMAX_API_KEY", billingType: "payg" },
  { id: "groq", label: "Groq", apiKeySetting: "GROQ_API_KEY", billingType: "payg" },
  { id: "genaipro", label: "GenAIPro", apiKeySetting: "GENAIPRO_API_KEY", billingType: "payg" },
  { id: "pexels", label: "Pexels", apiKeySetting: "PEXELS_API_KEY", billingType: "free" },
  { id: "pixabay", label: "Pixabay", apiKeySetting: "PIXABAY_API_KEY", billingType: "free" },
];

export type SubProviderId = "elevenlabs" | "heygen";

export interface SubPlan {
  id: string;
  monthlyUsd: number;
  quotaCredits: number;
}
export interface SubMeta {
  /** UI label of the quota unit, e.g. "credits". */
  quotaLabel: string;
  plans: SubPlan[];
  /** USD per quota-credit past the included quota (overage / buy-more-credits). */
  overageUsdPerCredit: number;
  /** HeyGen only — credits consumed per minute of avatar video (approx). */
  creditsPerMinute?: number;
}

/**
 * Public subscription tiers (2026 list prices — approximations for estimation).
 * ElevenLabs credits ≈ characters (Flash/Turbo = 0.5 credit/char). HeyGen quota is
 * credits, consumed per minute of avatar video. The user can pick "Custom" to enter
 * their own monthly fee + quota. Rollover (ElevenLabs 2-month) is not modelled —
 * quota resets each calendar month.
 */
export const SUB_META: Record<SubProviderId, SubMeta> = {
  elevenlabs: {
    quotaLabel: "credits",
    plans: [
      { id: "Free", monthlyUsd: 0, quotaCredits: 10_000 },
      { id: "Starter", monthlyUsd: 5, quotaCredits: 30_000 },
      { id: "Creator", monthlyUsd: 22, quotaCredits: 100_000 },
      { id: "Pro", monthlyUsd: 99, quotaCredits: 500_000 },
      { id: "Scale", monthlyUsd: 330, quotaCredits: 2_000_000 },
      { id: "Business", monthlyUsd: 1_320, quotaCredits: 11_000_000 },
    ],
    overageUsdPerCredit: 0.00022, // ≈ Creator effective ($22 / 100k)
  },
  heygen: {
    quotaLabel: "credits",
    plans: [
      { id: "Free", monthlyUsd: 0, quotaCredits: 0 },
      { id: "Creator", monthlyUsd: 29, quotaCredits: 200 },
      { id: "Pro", monthlyUsd: 49, quotaCredits: 1_000 },
      { id: "Business", monthlyUsd: 149, quotaCredits: 5_000 },
    ],
    overageUsdPerCredit: 0.05, // buy-more-credits rate
    creditsPerMinute: 20, // Avatar IV approx
  },
};

export function isSubProvider(id: string): id is SubProviderId {
  return id === "elevenlabs" || id === "heygen";
}

// ── Billing period (one shared clock for the whole Cost page) ──

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface BillingPeriodView {
  /** Inclusive window start (ISO, UTC midnight). */
  startIso: string;
  /** Exclusive window end (ISO, UTC midnight — start of the next period). */
  endIso: string;
  /** Human label, e.g. "Jul 14 – Aug 13, 2026 (UTC)". */
  label: string;
  /** The clamped day-of-month the cycle is anchored on (1–28). */
  startDay: number;
}

/**
 * The current billing window, anchored on a configurable day-of-month. Pure (takes
 * `nowMs`, no clock/DB) so it's unit-testable. Applied uniformly to Fixed + Variable +
 * quota + overage so the page keeps ONE clock and `Fixed + Variable = Total` holds.
 *
 * `startDay` is clamped to 1–28 (so the anchor exists in every month — no short-month
 * rollover surprises). If today's day-of-month is before the anchor, the window began
 * last month. Default day 1 reproduces the plain UTC calendar month.
 */
export function billingPeriod(nowMs: number, startDay: number): BillingPeriodView {
  const day = Math.min(28, Math.max(1, Math.floor(startDay) || 1));
  const now = new Date(nowMs);
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  if (now.getUTCDate() < day) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  const start = new Date(Date.UTC(y, m, day));
  const end = new Date(Date.UTC(y, m + 1, day)); // exclusive: next anchor
  const endIncl = new Date(end.getTime() - 86_400_000); // last day shown in the label
  const label =
    `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()} – ` +
    `${MONTHS[endIncl.getUTCMonth()]} ${endIncl.getUTCDate()}, ${endIncl.getUTCFullYear()} (UTC)`;
  return { startIso: start.toISOString(), endIso: end.toISOString(), label, startDay: day };
}

/**
 * The base identity of a raw ledger provider string — the part before any ":model"
 * suffix, lowercased (e.g. "gemini:gemini-2.5-flash" → "gemini", "kie:veo" → "kie").
 * Single place that knows how run_costs.provider is spelled.
 */
export function providerBase(rawProvider: string): string {
  return (rawProvider || "").split(":")[0].trim().toLowerCase();
}

/**
 * Classify a RAW ledger provider string (as stored in run_costs.provider — e.g.
 * "elevenlabs", "heygen", "gemini:gemini-2.5-flash", "kie:veo", "kie:nano-banana",
 * "69labs") into its billing mode, by identity:
 *   - elevenlabs / heygen        → "subscription" ALWAYS (neither sells a real pay-as-you-go
 *                                   API; a plan — Free included — is the only way to bill).
 *   - pexels / pixabay           → "free"
 *   - everything else (gemini/kie/69labs/minimax/groq/genaipro) → "payg"
 *
 * This is the SINGLE read-side rule that keeps the Cost page consistent: subscription
 * providers' `amount_eur` is never summed as money (only their usage feeds the quota view),
 * while payg providers' `amount_eur` is the honest metered spend. There is deliberately no
 * per-user override — subscription providers can't be toggled to payg.
 */
export function providerBillingMode(rawProvider: string): BillingType {
  const base = providerBase(rawProvider);
  if (base === "elevenlabs" || base === "heygen") return "subscription";
  if (base === "pexels" || base === "pixabay") return "free";
  return "payg";
}

// ── Billing profiles (the user's chosen plan per provider) ──

export interface BillingProfile {
  mode: "payg" | "subscription";
  /** a SUB_META plan id, or "Custom". */
  plan?: string;
  /** Custom monthly fee (USD) when plan === "Custom". */
  monthlyUsd?: number;
  /** Custom included quota (credits) when plan === "Custom". */
  quotaCredits?: number;
}

/** Read the user's billing profiles (JSON setting). Never throws. */
export function getBillingProfiles(): Record<string, BillingProfile> {
  try {
    const raw = getSetting("BILLING_PROFILES");
    if (!raw || !raw.trim()) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, BillingProfile>) : {};
  } catch {
    return {};
  }
}

export function setBillingProfiles(p: Record<string, BillingProfile>): void {
  setSetting("BILLING_PROFILES", JSON.stringify(p ?? {}));
}

/** Providers with `active = true` when their API key is configured (auto-detect). */
export function costProviders(): (CostProviderMeta & { active: boolean })[] {
  return COST_PROVIDERS.map((m) => ({
    ...m,
    active: (getSetting(m.apiKeySetting as Parameters<typeof getSetting>[0]) || "").trim() !== "",
  }));
}

/** True when the configured ElevenLabs model bills 0.5 credit/char (Flash/Turbo). */
export function elevenlabsIsFlash(): boolean {
  const model = (getSetting("ELEVENLABS_MODEL") || "").toLowerCase();
  return model.includes("flash") || model.includes("turbo");
}

// ── Pure math (no settings/DB — unit-tested) ──

/** ElevenLabs: recorded chars → credits. Flash/Turbo bill 0.5 credit/char. */
export function elevenlabsCharsToCredits(chars: number, flash: boolean): number {
  return Math.max(0, chars) * (flash ? 0.5 : 1);
}

/** HeyGen: recorded clip-seconds → credits via credits/minute. */
export function heygenSecondsToCredits(seconds: number, creditsPerMinute: number): number {
  return (Math.max(0, seconds) / 60) * Math.max(0, creditsPerMinute);
}

/**
 * Effective SUBSCRIPTION ALLOCATION for one run (management/accounting metric — NOT an invoice).
 * The share of a subscription's flat monthly fee attributable to this run's usage, by pro-rata:
 *
 *     allocation = runCredits × (monthlyFee / quotaCredits)     [= runCredits × effective €/credit]
 *
 * This is an AVERAGE cost (fee spread over the plan's included quota), deliberately distinct from
 * the run's MARGINAL cost (real added spend, often €0 under an already-paid quota). Summed over a
 * month it equals `fee × utilization` — i.e. the full fee only at 100% quota use — so it must never
 * replace the flat fee in the Fixed+Variable=Total reconciliation.
 *
 * Returns `null` (NOT 0) when the allocation is undefined — unknown/unlimited/zero quota — so the
 * caller can render "—" and fall back to marginal instead of inventing a €0 that reads as "free".
 * A free plan (monthlyEur = 0) with a known positive quota correctly returns 0.
 */
export function effectiveAllocationEur(runCredits: number, monthlyEur: number, quotaCredits: number): number | null {
  if (!(quotaCredits > 0)) return null; // unknown/unlimited/zero quota → not allocatable
  return Math.max(0, runCredits) * (Math.max(0, monthlyEur) / quotaCredits);
}

export interface SubView {
  plan: string;
  monthlyUsd: number;
  quotaCredits: number;
  usedCredits: number;
  quotaLabel: string;
  /** True when a positive quota is known — otherwise pct/overage are not meaningful. */
  quotaKnown: boolean;
  /** 0..100+ (exceeds 100 when over quota; 0 when quota unknown). */
  pct: number;
  overageCredits: number;
  overageUsd: number;
}

/**
 * Resolve a provider's plan (known tier or Custom overrides) and compute the
 * fee + quota-usage + overage view from this period's used credits. Pure USD.
 *
 * When the quota is unknown (Custom plan with the quota field left blank, or a
 * catalog plan whose included quota is 0), we DO NOT invent an overage or a full
 * bar: `quotaKnown=false`, `pct=0`, `overage=0`. Overage is only ever charged
 * against a positive, known quota.
 */
export function subscriptionView(providerId: SubProviderId, profile: BillingProfile, usedCredits: number): SubView {
  const meta = SUB_META[providerId];
  let monthlyUsd = 0;
  let quotaCredits = 0;
  if (profile.plan && profile.plan !== "Custom") {
    const plan = meta.plans.find((p) => p.id === profile.plan);
    monthlyUsd = plan?.monthlyUsd ?? 0;
    quotaCredits = plan?.quotaCredits ?? 0;
  } else {
    monthlyUsd = Math.max(0, Number(profile.monthlyUsd) || 0);
    quotaCredits = Math.max(0, Number(profile.quotaCredits) || 0);
  }
  const used = Math.max(0, usedCredits);
  const hasQuota = quotaCredits > 0;
  const overageCredits = hasQuota ? Math.max(0, used - quotaCredits) : 0;
  const overageUsd = overageCredits * meta.overageUsdPerCredit;
  const pct = hasQuota ? (used / quotaCredits) * 100 : 0;
  return { plan: profile.plan || "Custom", monthlyUsd, quotaCredits, usedCredits: used, quotaLabel: meta.quotaLabel, quotaKnown: hasQuota, pct, overageCredits, overageUsd };
}

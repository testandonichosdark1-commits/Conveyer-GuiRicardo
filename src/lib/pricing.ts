/**
 * Cost Monitoring — pricing model.
 *
 * Turns metered usage (characters, tokens, images, video-seconds, clips) into a
 * EUR amount. Every rate is read LIVE from Settings (see SETTING_KEYS /
 * DEFAULTS) so the operator can override any default with their actual plan
 * rate — nothing here is a hardcoded magic number in business logic.
 *
 * Defaults are documented public list prices in USD, converted to EUR via the
 * configurable COST_USD_TO_EUR FX rate. Where a provider's pricing is genuinely
 * unknown (no public per-unit rate, or a credit model we can't map), the helper
 * returns 0 and is marked with a TODO + `estimated` — we show €0.00 rather than
 * fabricate a number.
 */
import { getSetting } from "./settings";

/** Read a numeric setting, falling back to `fallback` on empty/NaN. */
function num(key: Parameters<typeof getSetting>[0], fallback: number): number {
  const v = Number(getSetting(key));
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** USD→EUR. Configurable; default ~0.92. */
function usdToEur(usd: number): number {
  return usd * num("COST_USD_TO_EUR", 0.92);
}

export type CostCategory = "elevenlabs" | "geminiText" | "geminiVision" | "aiProviders";

export interface PricedUsage {
  amountEur: number;
  units: number;
  unitLabel: string;
  /** false only once we wire a provider's real billing endpoint. */
  estimated: boolean;
}

/**
 * Subscription-tier → rate tables (Variant B). Picking a plan derives the
 * per-unit rate so the operator doesn't compute it by hand; "Custom" (or unset)
 * falls back to the manual $ field.
 *
 * ElevenLabs: rate = plan_price / included_credits × 1000 (multilingual_v2 =
 * 1 credit/char). These are documented list prices; verify against your plan.
 */
const ELEVENLABS_TIER_USD_PER_1K: Record<string, number> = {
  Free: 0,
  Starter: 0.167, // $5 / 30k credits
  Creator: 0.22, // $22 / 100k
  Pro: 0.198, // $99 / 500k
  Scale: 0.165, // $330 / 2M
  Business: 0.12, // $1320 / 11M
};

function elevenlabsRatePer1k(): number {
  const tier = getSetting("COST_ELEVENLABS_TIER").trim();
  if (tier && tier !== "Custom" && tier in ELEVENLABS_TIER_USD_PER_1K) {
    let rate = ELEVENLABS_TIER_USD_PER_1K[tier];
    // Flash/Turbo v2.5 bill 0.5 credit/char; the table assumes multilingual_v2.
    const model = getSetting("ELEVENLABS_MODEL").toLowerCase();
    if (model.includes("flash") || model.includes("turbo")) rate *= 0.5;
    return rate;
  }
  return num("COST_ELEVENLABS_USD_PER_1K_CHARS", 0.22);
}

// HeyGen: ~1 credit = 1 minute, but credits-per-minute and price vary by plan and
// avatar engine. Approximate list-price figures. Default tier is "Custom", whose
// manual rate defaults to $1.50/min — a typical Creator-tier estimate (only used
// on avatar beats); the operator confirms/overrides in their dashboard.
const HEYGEN_TIER_USD_PER_MIN: Record<string, number> = {
  Free: 0,
  Creator: 1.9,
  Team: 3.0,
};

function heygenRatePerMin(): number {
  const tier = getSetting("COST_HEYGEN_TIER").trim();
  if (tier && tier !== "Custom" && tier in HEYGEN_TIER_USD_PER_MIN) return HEYGEN_TIER_USD_PER_MIN[tier];
  return num("COST_HEYGEN_USD_PER_MIN", 1.9);
}

/** ElevenLabs TTS — billed per character of synthesized text. */
export function priceElevenlabs(chars: number): PricedUsage {
  const usd = (Math.max(0, chars) / 1000) * elevenlabsRatePer1k();
  return { amountEur: usdToEur(usd), units: chars, unitLabel: "chars", estimated: true };
}

/**
 * Gemini text/vision — billed per token. We read the REAL token counts from the
 * response's `usageMetadata`, so the only assumption is the per-token rate.
 * Vision image tokens are already included in promptTokenCount by the API, so
 * the same formula prices both text and vision calls correctly.
 *
 * Rates default to Gemini 2.5 Flash (the configured planner/rerank/vision
 * model). The fail-over ladder (2.5-flash-lite) is cheaper, so pricing a rare
 * fallback call at the 2.5-flash rate is a small, conservative over-count.
 */
export function priceGeminiTokens(promptTokens: number, outputTokens: number): { amountEur: number; estimated: boolean } {
  const inUsd = (Math.max(0, promptTokens) / 1_000_000) * num("COST_GEMINI_IN_USD_PER_1M", 0.3);
  const outUsd = (Math.max(0, outputTokens) / 1_000_000) * num("COST_GEMINI_OUT_USD_PER_1M", 2.5);
  return { amountEur: usdToEur(inUsd + outUsd), estimated: true };
}

/** kie.ai nano-banana — per generated image. */
export function priceKieImage(images: number): PricedUsage {
  const usd = Math.max(0, images) * num("COST_KIE_IMAGE_USD", 0.02);
  return { amountEur: usdToEur(usd), units: images, unitLabel: "images", estimated: true };
}

/** kie.ai Veo — per second of generated video. */
export function priceKieVeo(seconds: number): PricedUsage {
  const usd = Math.max(0, seconds) * num("COST_KIE_VEO_USD_PER_SEC", 0.4);
  return { amountEur: usdToEur(usd), units: seconds, unitLabel: "video-sec", estimated: true };
}

/** HeyGen avatar render — per minute of generated clip. */
export function priceHeygen(seconds: number): PricedUsage {
  const usd = (Math.max(0, seconds) / 60) * heygenRatePerMin();
  return { amountEur: usdToEur(usd), units: seconds, unitLabel: "clip-sec", estimated: true };
}

/**
 * 69labs / Grok b-roll — no public per-unit list price (billing is account-based),
 * so the rate is operator-configurable via COST_LABS69_USD_PER_VIDEO. Default 0
 * keeps the old behavior (unit count auditable, €0 amount) until a rate is set —
 * but now an operator on 69labs can record real cost instead of a forced €0.
 */
export function priceLabs69Video(videos: number): PricedUsage {
  const usd = Math.max(0, videos) * num("COST_LABS69_USD_PER_VIDEO", 0);
  return { amountEur: usdToEur(usd), units: videos, unitLabel: "videos", estimated: true };
}

/**
 * Magnific AI (Mystic image / Hailuo video) — billing is credit-based with no
 * public per-image or per-second USD list price we can map reliably, so the rate
 * is operator-configurable and defaults to 0 (usage is still recorded and
 * auditable; the euro stays €0 / estimated until the operator sets their rate).
 * We do NOT invent a price.
 */
export function priceMagnificImage(images: number): PricedUsage {
  const usd = Math.max(0, images) * num("COST_MAGNIFIC_IMAGE_USD", 0);
  return { amountEur: usdToEur(usd), units: images, unitLabel: "images", estimated: true };
}

/** Magnific AI video (Hailuo) — per second of generated video; rate configurable, default 0. */
export function priceMagnificVideo(seconds: number): PricedUsage {
  const usd = Math.max(0, seconds) * num("COST_MAGNIFIC_VIDEO_USD_PER_SEC", 0);
  return { amountEur: usdToEur(usd), units: seconds, unitLabel: "video-sec", estimated: true };
}

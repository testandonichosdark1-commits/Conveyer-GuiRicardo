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

/**
 * Read a numeric setting.
 *
 * `fallback` applies ONLY to a non-numeric or negative value. A BLANK setting is
 * `Number("") === 0`, which is finite and >= 0, so it resolves to **0** — the
 * documented behaviour (see CLAUDE.md), and the reason a cleared rate field prices
 * a provider at €0.00 rather than reverting to its published default. `rateKnown`
 * below is what stops that €0.00 from reading as "free".
 */
function num(key: Parameters<typeof getSetting>[0], fallback: number): number {
  const v = Number(getSetting(key));
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** The live USD→EUR rate. The ONE place this key is interpreted — see `usdToEur`. */
export function fxUsdToEur(): number {
  return num("COST_USD_TO_EUR", 0.92);
}

/** USD→EUR. Configurable; default ~0.92. */
function usdToEur(usd: number): number {
  return usd * fxUsdToEur();
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

/**
 * The ElevenLabs plan the operator is actually on — read from `BILLING_PROFILES`,
 * which is the plan they pick on the Costs page.
 *
 * There used to be TWO sources of truth for one fact. `BILLING_PROFILES.elevenlabs`
 * drove the quota bar and the per-run "Subscription share", while the separate
 * `COST_ELEVENLABS_TIER` setting drove the ledger's euro — and they disagreed in the
 * field (profile "Starter", tier "Creator"), so the same page reported one plan's fee
 * against another plan's rate. The profile wins; `COST_ELEVENLABS_TIER` survives only
 * as a fallback for installs that never opened the Costs page.
 */
function elevenlabsPlanId(): string {
  try {
    const raw = getSetting("BILLING_PROFILES");
    if (raw && raw.trim()) {
      const obj = JSON.parse(raw) as Record<string, { plan?: string } | undefined>;
      const plan = obj?.elevenlabs?.plan;
      if (plan && typeof plan === "string") return plan.trim();
    }
  } catch {
    // Malformed JSON → fall through to the legacy tier key.
  }
  return getSetting("COST_ELEVENLABS_TIER").trim();
}

function elevenlabsRatePer1k(): number {
  const tier = elevenlabsPlanId();
  if (tier && tier !== "Custom" && tier in ELEVENLABS_TIER_USD_PER_1K) {
    let rate = ELEVENLABS_TIER_USD_PER_1K[tier];
    // Flash/Turbo v2.5 bill 0.5 credit/char; the table assumes multilingual_v2.
    // This is NOT a double-discount with `elevenlabsCharsToCredits`: that one
    // converts chars→credits for the quota bar, while this rate is $/1k CHARS. The
    // two are parallel views of the same plan, never composed.
    const model = getSetting("ELEVENLABS_MODEL").toLowerCase();
    if (model.includes("flash") || model.includes("turbo")) rate *= 0.5;
    return rate;
  }
  return num("COST_ELEVENLABS_USD_PER_1K_CHARS", 0.22);
}

/**
 * Per-minute rate for an avatar beat.
 *
 * HeyGen's API is pay-as-you-go — a prepaid USD wallet billed per second, with no
 * subscription tier involved ("no plan, no subscription needed"). So the rate depends
 * ONLY on which motion engine /v2/video/generate rendered with:
 *   • AvatarIV  (use_avatar_iv_model: true) → $3.00/min  (Photo Avatar, 720p/1080p)
 *   • Unlimited (flag omitted)              → $1.00/min  (estimate; see settings.ts)
 * The old Free/Creator/Team tier table modelled HeyGen's WEB plans, which never applied
 * to API usage — it is gone, along with COST_HEYGEN_TIER.
 */
/**
 * The engines we bill for. Not an avatar type — the same avatar renders on any of
 * these; only the rate differs.
 *   • avatar_iv / unlimited → v2 (`/v2/video/generate`)
 *   • avatar_v              → v3 (`/v3/videos`)
 */
export type HeygenEngine = "avatar_iv" | "unlimited" | "avatar_v";

function heygenRatePerMin(engine: HeygenEngine): number {
  // Fallbacks only apply when the rate setting is missing/blank/non-numeric; a
  // configured value always wins (custom override).
  switch (engine) {
    case "avatar_v":
      return num("COST_HEYGEN_AVATAR_V_USD_PER_MIN", 4.0);
    case "unlimited":
      return num("COST_HEYGEN_UNLIMITED_USD_PER_MIN", 1.0);
    default:
      return num("COST_HEYGEN_USD_PER_MIN", 3.0);
  }
}

/** ElevenLabs TTS — billed per character of synthesized text. */
export function priceElevenlabs(chars: number): PricedUsage {
  const usd = (Math.max(0, chars) / 1000) * elevenlabsRatePer1k();
  return { amountEur: usdToEur(usd), units: chars, unitLabel: "chars", estimated: true };
}

/**
 * AI84 TTS — billed in AI84 CREDITS (an ElevenLabs/MiniMax reseller). The USD
 * value of one credit is not public, so COST_AI84_USD_PER_CREDIT is operator-set
 * (default 0 → €0.00 shown until you fill it). The credit COUNT is always
 * recorded, so spend volume is visible even before the rate is known.
 */
export function priceAi84(credits: number): PricedUsage {
  const usd = Math.max(0, credits) * num("COST_AI84_USD_PER_CREDIT", 0);
  return { amountEur: usdToEur(usd), units: credits, unitLabel: "credits", estimated: true };
}

/**
 * ai33.pro (OpenSpeaker) TTS — billed from ONE credit balance shared by all six engines.
 * They publish a pack price ($5 per 1,000,000 premium credits) but not a per-engine rate,
 * and the engines are not priced alike, so COST_AI33_USD_PER_CREDIT is operator-set and
 * defaults to blank rather than to a number we would be inventing. The credit COUNT is
 * always recorded, so spend volume stays visible before the rate is known.
 */
export function priceAi33(credits: number): PricedUsage {
  const usd = Math.max(0, credits) * num("COST_AI33_USD_PER_CREDIT", 0);
  return { amountEur: usdToEur(usd), units: credits, unitLabel: "credits", estimated: true };
}

/**
 * Fish Audio TTS — billed per MILLION UTF-8 BYTES ($15.00 list for s1 / s2-pro / s2.1-pro;
 * the s2.1-pro-free tier is $0, so an operator on it sets the rate to 0).
 *
 * The unit is BYTES, not characters, and that distinction is the whole point of this
 * function: Fish's own docs price "1M UTF-8 bytes ≈ 180,000 English words", but a Cyrillic
 * or CJK script spends 2–3 bytes per character. Metering characters would under-report a
 * Russian voiceover by roughly half. The call site passes Buffer.byteLength(text, "utf8").
 */
export function priceFishAudio(bytes: number): PricedUsage {
  const usd = (Math.max(0, bytes) / 1_000_000) * num("COST_FISHAUDIO_USD_PER_1M_BYTES", 15);
  return { amountEur: usdToEur(usd), units: bytes, unitLabel: "utf8-bytes", estimated: true };
}

/**
 * Hume Octave TTS — billed per 1,000 CHARACTERS of input text. The published rate is
 * tier-dependent ($0.15/1k on Free–Creator, $0.12 Pro, $0.10 Scale, $0.05 Business), so
 * COST_HUME_USD_PER_1K_CHARS defaults to the entry-tier $0.15 and the operator lowers it
 * to match their plan.
 */
export function priceHume(chars: number): PricedUsage {
  const usd = (Math.max(0, chars) / 1000) * num("COST_HUME_USD_PER_1K_CHARS", 0.15);
  return { amountEur: usdToEur(usd), units: chars, unitLabel: "chars", estimated: true };
}

/**
 * Groq Whisper transcription — billed per HOUR OF AUDIO (not wall-clock time), so the
 * meter is the clip's duration. Charged whenever we recover word timings from audio we
 * have no alignment for: every non-ElevenLabs voiceover provider goes through it.
 *
 * `estimated: true` matches every other recorder here — the rate is a published list
 * price, but we compute the amount rather than read it back from Groq's billing API.
 */
export function priceGroqTranscription(audioSec: number): PricedUsage {
  const sec = Math.max(0, audioSec);
  const usd = (sec / 3600) * num("COST_GROQ_USD_PER_AUDIO_HOUR", 0.111);
  return { amountEur: usdToEur(usd), units: sec, unitLabel: "audio-sec", estimated: true };
}

/**
 * Gemini — billed per token. We read the REAL token counts from the response's
 * `usageMetadata`, so the only assumption is the per-token rate. Vision image tokens
 * are already included in promptTokenCount by the API, so one formula prices both.
 *
 * `category` selects the RATE, i.e. it names the MODEL the call runs on — NOT the
 * payload's modality. Pick it from the model the call actually sends:
 *   - geminiText   → SCENE_SPLIT_MODEL  (gemini-3.5-flash,      $1.50 in / $9.00 out per 1M)
 *   - geminiVision → VISION_MATCH_MODEL (gemini-3.1-flash-lite, $0.25 in / $1.50 out per 1M)
 * A text-payload call that runs on VISION_MATCH_MODEL (e.g. the YouTube title-rerank)
 * therefore belongs to "geminiVision" — billing it as text overcharges it 6×.
 */
export function priceGeminiTokens(
  promptTokens: number,
  outputTokens: number,
  categoryOrKind: "geminiText" | "geminiVision" | "gemini:std" | "gemini:lite" = "geminiText"
): { amountEur: number; estimated: boolean } {
  // Accepts the legacy category (kept so existing callers/tests are unchanged) or, on
  // the current path, an explicit model-derived rate kind from `geminiRateKind()`.
  const lite = categoryOrKind === "gemini:lite" || categoryOrKind === "geminiVision";
  const inRate = lite ? num("COST_GEMINI_LITE_IN_USD_PER_1M", 0.25) : num("COST_GEMINI_IN_USD_PER_1M", 1.5);
  const outRate = lite ? num("COST_GEMINI_LITE_OUT_USD_PER_1M", 1.5) : num("COST_GEMINI_OUT_USD_PER_1M", 9.0);
  const inUsd = (Math.max(0, promptTokens) / 1_000_000) * inRate;
  const outUsd = (Math.max(0, outputTokens) / 1_000_000) * outRate;
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

/**
 * HeyGen avatar render — per minute of generated clip, at the rate of the engine it
 * rendered with. Same formula for all three; only the rate key differs.
 */
export function priceHeygenEngine(seconds: number, engine: HeygenEngine): PricedUsage {
  const usd = (Math.max(0, seconds) / 60) * heygenRatePerMin(engine);
  return { amountEur: usdToEur(usd), units: seconds, unitLabel: "clip-sec", estimated: true };
}

/**
 * The v2 (boolean) view of the same thing, kept EXACTLY as it was — an adapter over
 * priceHeygenEngine, not a second pricing model. Avatar V is a third engine, which a
 * boolean cannot express; rather than widen this signature (and every existing caller
 * and test with it), v3 calls priceHeygenEngine directly. `useAvatarIv` still defaults
 * to true so existing callers keep the Avatar IV rate they already priced at.
 */
export function priceHeygen(seconds: number, useAvatarIv = true): PricedUsage {
  return priceHeygenEngine(seconds, useAvatarIv ? "avatar_iv" : "unlimited");
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
 * 69labs still image — its own rate and its own unit. Previously priced with
 * `priceLabs69Video` and labelled "videos", which billed an image at the video rate.
 */
export function priceLabs69Image(images: number): PricedUsage {
  const usd = Math.max(0, images) * num("COST_LABS69_IMAGE_USD", 0);
  return { amountEur: usdToEur(usd), units: images, unitLabel: "images", estimated: true };
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

/**
 * Higgsfield image — credit-based billing with no public per-image USD list price we can
 * map reliably, so the rate is operator-configurable and defaults to 0 (usage is still
 * recorded and auditable; the euro stays €0 / estimated until the operator sets their
 * rate). We do NOT invent a price.
 */
export function priceHiggsfieldImage(images: number): PricedUsage {
  const usd = Math.max(0, images) * num("COST_HIGGSFIELD_IMAGE_USD", 0);
  return { amountEur: usdToEur(usd), units: images, unitLabel: "images", estimated: true };
}

/** Higgsfield video — per second of generated video; rate configurable, default 0. */
export function priceHiggsfieldVideo(seconds: number): PricedUsage {
  const usd = Math.max(0, seconds) * num("COST_HIGGSFIELD_VIDEO_USD_PER_SEC", 0);
  return { amountEur: usdToEur(usd), units: seconds, unitLabel: "video-sec", estimated: true };
}

/**
 * Runware image — THE ONE PROVIDER HERE THAT REPORTS WHAT IT ACTUALLY BILLED.
 *
 * Every other helper in this file multiplies a configured rate by a unit count and
 * is therefore `estimated: true` — a modelled guess, honest but not money. Runware's
 * `includeCost: true` returns the real USD charged for the task, so when we have that
 * number the ledger row is the actual amount and `estimated` is FALSE. This is what
 * `PricedUsage.estimated`'s "false only once we wire a provider's real billing
 * endpoint" was written for.
 *
 * `reportedUsd` is the cost of the WHOLE task (one image per call here), so it is
 * recorded verbatim — never multiplied by `images`.
 *
 * When Runware reports nothing (null), we fall back to the operator-configurable
 * rate, which defaults to 0: usage stays auditable and the euro stays €0.00 rather
 * than fabricated, exactly like Magnific and 69labs. We do NOT invent a price.
 */
export function priceRunwareImage(images: number, reportedUsd?: number | null): PricedUsage {
  const n = Math.max(0, images);
  const real = typeof reportedUsd === "number" && Number.isFinite(reportedUsd) && reportedUsd >= 0;
  const usd = real ? (reportedUsd as number) : n * num("COST_RUNWARE_IMAGE_USD", 0);
  return { amountEur: usdToEur(usd), units: n, unitLabel: "images", estimated: !real };
}

// ─────────────────────────────────────────────────────────────────────────────
// READ-TIME PRICING
//
// Everything above prices at WRITE time and freezes the result into
// `run_costs.amount_eur`. That is why an operator who fills in the 69labs rate
// today still sees €0.00 against 382 already-recorded videos: the rows were
// priced when the rate was 0 and nothing ever revisits them.
//
// Below is the read side. A ledger row stores the priceable FACTS (`rate_kind`,
// `units`, `units_out`, and `amount_usd` when a provider reported real money);
// `priceRow` turns them into a euro using the rates in force RIGHT NOW. Correct a
// rate and every historical row restates on the next page load.
//
// The write-time helpers stay: `amount_eur` is still written as provenance ("what
// we thought it cost when it happened"), and it is the fallback for rows the
// backfill could not classify.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A rate's identity. `provider` alone is NOT enough to price a row:
 *   • HeyGen's engine is a 3–4x spread and lives in no ledger column.
 *   • A 69labs image and a 69labs video are both provider "69labs".
 *   • Gemini's model — not the call site's role — decides its rate.
 * So the recorder names the rate explicitly, and this is the closed set it may use.
 */
export const RATE_KINDS = [
  "elevenlabs",
  "ai84",
  "ai33",
  "fishaudio",
  "hume",
  "groq",
  "gemini:std",
  "gemini:lite",
  "kie:image",
  "kie:veo",
  "heygen:avatar_iv",
  "heygen:unlimited",
  "heygen:avatar_v",
  "69labs:video",
  "69labs:image",
  "magnific:image",
  "magnific:video",
  "higgsfield:image",
  "higgsfield:video",
  "runware:image",
  // Voiceover providers that used to record nothing at all.
  "heygen:tts",
  "69labs:tts",
  "openai:tts",
  "minimax:tts",
  "genaipro:tts",
  // Real-footage / search spend that was invisible on the Costs page.
  "storyblocks:download",
  "googlecse:query",
] as const;
export type RateKind = (typeof RATE_KINDS)[number];

export function isRateKind(v: string | null | undefined): v is RateKind {
  return !!v && (RATE_KINDS as readonly string[]).includes(v);
}

/**
 * Which Gemini rate a call runs at — decided by the MODEL, never by the call site's
 * role.
 *
 * This was the single biggest mispricing on /costs. The old rule read the `category`
 * ("geminiText" → standard rate, "geminiVision" → lite rate) on the assumption that
 * SCENE_SPLIT_MODEL is always a standard model and VISION_MATCH_MODEL always a lite
 * one. Neither holds: an install running SCENE_SPLIT_MODEL=gemini-3.1-flash-lite has
 * every planner call billed at the standard rate (~6x over), while 1,428 recorded
 * gemini-2.5-flash vision calls were billed at the lite rate (under). The model id is
 * already stored on every row — use it.
 *
 * `-lite` is Google's own suffix for the cheap tier, so matching on it tracks the
 * family rather than pinning a list of ids that goes stale at each model release.
 */
export function geminiRateKind(model: string): Extract<RateKind, "gemini:std" | "gemini:lite"> {
  return (model || "").toLowerCase().includes("lite") ? "gemini:lite" : "gemini:std";
}

export interface RateSpec {
  /** The unit_label this rate is denominated against (audit + UI). */
  unit: string;
  /** How many units one rate step covers: 1 | 1_000 | 1_000_000 | 60 | 3_600. */
  per: number;
  /** USD per `per` units, read LIVE from settings. */
  rate: () => number;
  /** Second rate, for the only two-rate model we have (Gemini in/out). */
  rateOut?: () => number;
  /** The settings key an operator would edit — powers "rate not configured → set it here". */
  settingKey: string | null;
  /** Human label for that warning. */
  label: string;
}

/**
 * The rate table. Every entry reads its rate through `num()` on each call, so
 * nothing here caches — that is what makes repricing instant.
 */
const RATE_SPECS: Record<RateKind, RateSpec> = {
  elevenlabs: {
    unit: "chars",
    per: 1000,
    rate: () => elevenlabsRatePer1k(),
    settingKey: "COST_ELEVENLABS_USD_PER_1K_CHARS",
    label: "ElevenLabs",
  },
  ai84: {
    unit: "credits",
    per: 1,
    rate: () => num("COST_AI84_USD_PER_CREDIT", 0),
    settingKey: "COST_AI84_USD_PER_CREDIT",
    label: "AI84",
  },
  ai33: {
    unit: "credits",
    per: 1,
    rate: () => num("COST_AI33_USD_PER_CREDIT", 0),
    settingKey: "COST_AI33_USD_PER_CREDIT",
    label: "ai33.pro",
  },
  fishaudio: {
    unit: "utf8-bytes",
    per: 1_000_000,
    rate: () => num("COST_FISHAUDIO_USD_PER_1M_BYTES", 15),
    settingKey: "COST_FISHAUDIO_USD_PER_1M_BYTES",
    label: "Fish Audio",
  },
  hume: {
    unit: "chars",
    per: 1000,
    rate: () => num("COST_HUME_USD_PER_1K_CHARS", 0.15),
    settingKey: "COST_HUME_USD_PER_1K_CHARS",
    label: "Hume AI",
  },
  groq: {
    unit: "audio-sec",
    per: 3600,
    rate: () => num("COST_GROQ_USD_PER_AUDIO_HOUR", 0.111),
    settingKey: "COST_GROQ_USD_PER_AUDIO_HOUR",
    label: "Groq Whisper",
  },
  "gemini:std": {
    unit: "tokens",
    per: 1_000_000,
    rate: () => num("COST_GEMINI_IN_USD_PER_1M", 1.5),
    rateOut: () => num("COST_GEMINI_OUT_USD_PER_1M", 9.0),
    settingKey: "COST_GEMINI_IN_USD_PER_1M",
    label: "Gemini (standard)",
  },
  "gemini:lite": {
    unit: "tokens",
    per: 1_000_000,
    rate: () => num("COST_GEMINI_LITE_IN_USD_PER_1M", 0.25),
    rateOut: () => num("COST_GEMINI_LITE_OUT_USD_PER_1M", 1.5),
    settingKey: "COST_GEMINI_LITE_IN_USD_PER_1M",
    label: "Gemini (lite)",
  },
  "kie:image": {
    unit: "images",
    per: 1,
    rate: () => num("COST_KIE_IMAGE_USD", 0.02),
    settingKey: "COST_KIE_IMAGE_USD",
    label: "kie.ai image",
  },
  "kie:veo": {
    unit: "video-sec",
    per: 1,
    rate: () => num("COST_KIE_VEO_USD_PER_SEC", 0.4),
    settingKey: "COST_KIE_VEO_USD_PER_SEC",
    label: "kie.ai Veo",
  },
  "heygen:avatar_iv": {
    unit: "clip-sec",
    per: 60,
    rate: () => num("COST_HEYGEN_USD_PER_MIN", 3.0),
    settingKey: "COST_HEYGEN_USD_PER_MIN",
    label: "HeyGen Avatar IV",
  },
  "heygen:unlimited": {
    unit: "clip-sec",
    per: 60,
    rate: () => num("COST_HEYGEN_UNLIMITED_USD_PER_MIN", 1.0),
    settingKey: "COST_HEYGEN_UNLIMITED_USD_PER_MIN",
    label: "HeyGen Legacy",
  },
  "heygen:avatar_v": {
    unit: "clip-sec",
    per: 60,
    rate: () => num("COST_HEYGEN_AVATAR_V_USD_PER_MIN", 4.0),
    settingKey: "COST_HEYGEN_AVATAR_V_USD_PER_MIN",
    label: "HeyGen Avatar V",
  },
  "69labs:video": {
    unit: "videos",
    per: 1,
    rate: () => num("COST_LABS69_USD_PER_VIDEO", 0),
    settingKey: "COST_LABS69_USD_PER_VIDEO",
    label: "69labs video",
  },
  "69labs:image": {
    unit: "images",
    per: 1,
    rate: () => num("COST_LABS69_IMAGE_USD", 0),
    settingKey: "COST_LABS69_IMAGE_USD",
    label: "69labs image",
  },
  "magnific:image": {
    unit: "images",
    per: 1,
    rate: () => num("COST_MAGNIFIC_IMAGE_USD", 0),
    settingKey: "COST_MAGNIFIC_IMAGE_USD",
    label: "Magnific image",
  },
  "magnific:video": {
    unit: "video-sec",
    per: 1,
    rate: () => num("COST_MAGNIFIC_VIDEO_USD_PER_SEC", 0),
    settingKey: "COST_MAGNIFIC_VIDEO_USD_PER_SEC",
    label: "Magnific video",
  },
  "higgsfield:image": {
    unit: "images",
    per: 1,
    rate: () => num("COST_HIGGSFIELD_IMAGE_USD", 0),
    settingKey: "COST_HIGGSFIELD_IMAGE_USD",
    label: "Higgsfield image",
  },
  "higgsfield:video": {
    unit: "video-sec",
    per: 1,
    rate: () => num("COST_HIGGSFIELD_VIDEO_USD_PER_SEC", 0),
    settingKey: "COST_HIGGSFIELD_VIDEO_USD_PER_SEC",
    label: "Higgsfield video",
  },
  "runware:image": {
    unit: "images",
    per: 1,
    rate: () => num("COST_RUNWARE_IMAGE_USD", 0),
    settingKey: "COST_RUNWARE_IMAGE_USD",
    label: "Runware image",
  },
  "heygen:tts": {
    unit: "chars",
    per: 1000,
    rate: () => num("COST_HEYGEN_TTS_USD_PER_1K_CHARS", 0),
    settingKey: "COST_HEYGEN_TTS_USD_PER_1K_CHARS",
    label: "HeyGen TTS",
  },
  "69labs:tts": {
    unit: "chars",
    per: 1000,
    rate: () => num("COST_LABS69_TTS_USD_PER_1K_CHARS", 0),
    settingKey: "COST_LABS69_TTS_USD_PER_1K_CHARS",
    label: "69labs TTS",
  },
  "openai:tts": {
    unit: "chars",
    per: 1000,
    rate: () => num("COST_OPENAI_TTS_USD_PER_1K_CHARS", 0),
    settingKey: "COST_OPENAI_TTS_USD_PER_1K_CHARS",
    label: "OpenAI TTS",
  },
  "minimax:tts": {
    unit: "chars",
    per: 1000,
    rate: () => num("COST_MINIMAX_TTS_USD_PER_1K_CHARS", 0),
    settingKey: "COST_MINIMAX_TTS_USD_PER_1K_CHARS",
    label: "MiniMax TTS",
  },
  "genaipro:tts": {
    unit: "chars",
    per: 1000,
    rate: () => num("COST_GENAIPRO_TTS_USD_PER_1K_CHARS", 0),
    settingKey: "COST_GENAIPRO_TTS_USD_PER_1K_CHARS",
    label: "GenAIPro TTS",
  },
  "storyblocks:download": {
    unit: "downloads",
    per: 1,
    rate: () => num("COST_STORYBLOCKS_USD_PER_DOWNLOAD", 0),
    settingKey: "COST_STORYBLOCKS_USD_PER_DOWNLOAD",
    label: "Storyblocks download",
  },
  "googlecse:query": {
    unit: "queries",
    per: 1,
    rate: () => num("COST_GOOGLE_CSE_USD_PER_QUERY", 0),
    settingKey: "COST_GOOGLE_CSE_USD_PER_QUERY",
    label: "Google Custom Search",
  },
};

/** The live rate for one kind, plus whether it is actually configured. */
export function rateFor(rateKind: string): (RateSpec & { usd: number; usdOut: number | null; known: boolean }) | null {
  if (!isRateKind(rateKind)) return null;
  const spec = RATE_SPECS[rateKind];
  const usd = spec.rate();
  const usdOut = spec.rateOut ? spec.rateOut() : null;
  // "Known" means an operator has actually priced this provider. A 0 here is not
  // "free" — it is "nobody told us", and the page must say so rather than render
  // a confident €0.00 over 382 generated videos.
  const known = usd > 0 || (usdOut != null && usdOut > 0);
  return { ...spec, usd, usdOut, known };
}

/** The priceable facts of one ledger row, as stored. */
export interface LedgerFacts {
  rateKind: string | null;
  /** Total billable quantity. For Gemini this is prompt + output tokens. */
  units: number;
  /** Gemini output tokens (prompt = units - unitsOut). NULL for every other kind. */
  unitsOut?: number | null;
  /** Real billed USD reported by the provider. NULL = we only hold an estimate. */
  amountUsd?: number | null;
  /** The euro AS RECORDED — the fallback when a row cannot be repriced. */
  amountEur: number;
  /**
   * The ledger's `estimated` flag: false = this euro came from a provider-reported
   * amount, not from multiplying our own rate.
   *
   * Load-bearing for rows written BEFORE `amount_usd` existed. Runware reports what
   * it really billed, and 64 such rows hold €7.00 of real spend — but their rate
   * fallback is 0, so repricing them by units would silently erase that to €0.00.
   * `estimated: false` with no `amountUsd` therefore means "keep the recorded amount":
   * we would rather show real money at a stale FX than a confident zero.
   */
  estimated?: boolean;
}

export interface PricedRow {
  eur: number;
  /** Provider-billed truth, not a model of it (only Runware reports this today). */
  real: boolean;
  /** True when `eur` was computed from CURRENT settings; false = as-recorded fallback. */
  repriced: boolean;
  /** False when this row's rate is unset — its €0.00 means "unpriced", not "free". */
  rateKnown: boolean;
  /** Which rate applied, for the "configure it here" hint. */
  rateKind: string | null;
}

/**
 * Price one ledger row against today's settings.
 *
 * Order matters:
 *   1. A REAL reported amount wins outright — it is money, not a model. Still
 *      multiplied by the current FX, so correcting COST_USD_TO_EUR restates it.
 *   2. Otherwise recompute units × rate. This is the path that lets a rate fix
 *      reach history.
 *   3. A row we cannot classify (no rate_kind, or a Gemini row from before the
 *      token split was stored) falls back to its as-recorded euro, flagged
 *      `repriced: false`. Showing the old number is honest; inventing a new one
 *      from a token total we cannot split is not.
 */
export function priceRow(f: LedgerFacts): PricedRow {
  const fx = fxUsdToEur();
  const asRecorded = Number(f.amountEur) || 0;

  if (typeof f.amountUsd === "number" && Number.isFinite(f.amountUsd) && f.amountUsd >= 0) {
    return { eur: f.amountUsd * fx, real: true, repriced: true, rateKnown: true, rateKind: f.rateKind };
  }

  // Real money whose USD was never captured (pre-`amount_usd` Runware rows). Repricing
  // it by units would replace a provider-billed amount with our own 0-rate guess.
  if (f.estimated === false) {
    return { eur: asRecorded, real: true, repriced: false, rateKnown: true, rateKind: f.rateKind };
  }

  const spec = f.rateKind ? rateFor(f.rateKind) : null;
  if (!spec) {
    return { eur: asRecorded, real: false, repriced: false, rateKnown: asRecorded > 0, rateKind: f.rateKind };
  }

  const units = Math.max(0, Number(f.units) || 0);

  // Two-rate model (Gemini): needs the in/out split. Rows written before
  // `units_out` existed cannot be repriced — fall back rather than guess a split.
  if (spec.usdOut != null) {
    const out = f.unitsOut;
    if (typeof out !== "number" || !Number.isFinite(out)) {
      return { eur: asRecorded, real: false, repriced: false, rateKnown: spec.known, rateKind: f.rateKind };
    }
    const outTokens = Math.min(units, Math.max(0, out));
    const inTokens = units - outTokens;
    const usd = (inTokens / spec.per) * spec.usd + (outTokens / spec.per) * spec.usdOut;
    return { eur: usd * fx, real: false, repriced: true, rateKnown: spec.known, rateKind: f.rateKind };
  }

  const usd = (units / spec.per) * spec.usd;
  return { eur: usd * fx, real: false, repriced: true, rateKnown: spec.known, rateKind: f.rateKind };
}

/**
 * Per-character TTS providers that had NO cost recorder at all — HeyGen, 69labs,
 * OpenAI, MiniMax and GenAIPro. Only 3 of the 9 branches in `dispatchTts` were
 * metered, so a run narrated by any of these reported no voiceover spend whatsoever,
 * which is the single largest per-run cost on most videos.
 *
 * One helper rather than five near-identical ones: they share a unit (characters of
 * synthesized text) and a shape, and only the rate key differs.
 */
export function priceTtsChars(chars: number, rateKind: RateKind): PricedUsage {
  const spec = rateFor(rateKind);
  const usd = (Math.max(0, chars) / (spec?.per ?? 1000)) * (spec?.usd ?? 0);
  return { amountEur: usdToEur(usd), units: chars, unitLabel: "chars", estimated: true };
}

/**
 * Storyblocks — billed on the RESOLVE step, not the search. `resolveStoryblocksFile`
 * is what consumes a download from the plan; the search endpoint is free.
 */
export function priceStoryblocksDownload(downloads: number): PricedUsage {
  const usd = Math.max(0, downloads) * num("COST_STORYBLOCKS_USD_PER_DOWNLOAD", 0);
  return { amountEur: usdToEur(usd), units: downloads, unitLabel: "downloads", estimated: true };
}

/**
 * Google Custom Search — free for the first 100 queries/day, billed above that. We
 * cannot see the daily counter from here, so every query is recorded and the rate is
 * the operator's blended one (0 = "I stay inside the free tier").
 */
export function priceGoogleCseQuery(queries: number): PricedUsage {
  const usd = Math.max(0, queries) * num("COST_GOOGLE_CSE_USD_PER_QUERY", 0);
  return { amountEur: usdToEur(usd), units: queries, unitLabel: "queries", estimated: true };
}

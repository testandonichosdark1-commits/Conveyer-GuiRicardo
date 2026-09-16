/**
 * Cost Monitoring — per-run cost ledger.
 *
 * Append-only writes (one row per metered API event) + read aggregation for the
 * Costs page. Every recorder is FAIL-OPEN: cost tracking must never throw into
 * the pipeline, so a bad insert is swallowed (a missed cost row is acceptable; a
 * broken render is not).
 *
 * Call sites pass raw usage (chars / tokens / images / seconds); pricing.ts
 * turns it into EUR. The split into the 4 UI buckets is the `category`.
 */
import db from "../db";
import {
  type CostCategory,
  priceElevenlabs,
  priceAi84,
  priceAi33,
  priceFishAudio,
  priceHume,
  priceGroqTranscription,
  priceGeminiTokens,
  geminiRateKind,
  priceKieImage,
  priceKieVeo,
  priceHeygen,
  priceHeygenEngine,
  priceLabs69Video,
  priceLabs69Image,
  priceMagnificImage,
  priceMagnificVideo,
  priceHiggsfieldImage,
  priceHiggsfieldVideo,
  priceRunwareImage,
  priceRow,
  priceTtsChars,
  priceStoryblocksDownload,
  priceGoogleCseQuery,
  type HeygenEngine,
  type RateKind,
} from "../pricing";

const insertCost = db.prepare(
  `INSERT INTO run_costs (run_id, provider, category, units, unit_label, amount_eur, estimated,
                          rate_kind, amount_usd, units_out)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

interface CostEvent {
  provider: string;
  category: CostCategory;
  units: number;
  unitLabel: string;
  amountEur: number;
  estimated: boolean;
  /**
   * Which rate prices this row (see RATE_KINDS in pricing.ts). REQUIRED on every new
   * row: it is what lets /costs reprice history when a rate is corrected, and it
   * carries the facts `provider` cannot (HeyGen's engine, 69labs image-vs-video).
   */
  rateKind: RateKind;
  /** Real billed USD, when the provider reported one. Omit for an estimate. */
  amountUsd?: number | null;
  /** Second quantity for two-rate models (Gemini output tokens). */
  unitsOut?: number | null;
}

/** Low-level append. Never throws. */
function record(runId: string, e: CostEvent): void {
  try {
    if (!runId) return;
    insertCost.run(
      runId,
      e.provider,
      e.category,
      e.units,
      e.unitLabel,
      e.amountEur,
      e.estimated ? 1 : 0,
      e.rateKind,
      typeof e.amountUsd === "number" && Number.isFinite(e.amountUsd) ? e.amountUsd : null,
      typeof e.unitsOut === "number" && Number.isFinite(e.unitsOut) ? e.unitsOut : null
    );
  } catch {
    // fail-open: a lost cost row must not affect the run
  }
}

// ── Typed recorders (one call per metered event at each provider call site) ──

export function recordElevenlabs(runId: string, chars: number): void {
  const p = priceElevenlabs(chars);
  record(runId, { provider: "elevenlabs", category: "elevenlabs", rateKind: "elevenlabs", ...p });
}

/**
 * AI84 voiceover — billed in AI84 CREDITS (not characters). Buckets into the
 * pay-as-you-go `aiProviders` category. EUR is only populated once
 * COST_AI84_USD_PER_CREDIT is set; until then the credit count is still recorded.
 */
export function recordAi84(runId: string, credits: number): void {
  const p = priceAi84(credits);
  record(runId, { provider: "ai84", category: "aiProviders", rateKind: "ai84", ...p });
}

/**
 * ai33.pro voiceover — billed in ai33 CREDITS from one balance shared by its six engines.
 * Same shape as AI84: pay-as-you-go, so it buckets into `aiProviders`, and EUR only
 * populates once COST_AI33_USD_PER_CREDIT is set.
 */
export function recordAi33(runId: string, credits: number): void {
  const p = priceAi33(credits);
  record(runId, { provider: "ai33", category: "aiProviders", rateKind: "ai33", ...p });
}

/**
 * Fish Audio voiceover — metered in UTF-8 BYTES of synthesized text (Fish's billing unit),
 * so the call site passes Buffer.byteLength(text, "utf8"), never text.length.
 * Pay-as-you-go, so it buckets into `aiProviders` like every other non-subscription vendor.
 */
export function recordFishAudio(runId: string, bytes: number): void {
  const p = priceFishAudio(bytes);
  record(runId, { provider: "fishaudio", category: "aiProviders", rateKind: "fishaudio", ...p });
}

/** Hume Octave voiceover — metered in characters of synthesized text (Hume's billing unit). */
export function recordHume(runId: string, chars: number): void {
  const p = priceHume(chars);
  record(runId, { provider: "hume", category: "aiProviders", rateKind: "hume", ...p });
}

/**
 * Groq Whisper word-timing transcription, metered by the transcribed clip's DURATION.
 *
 * Bucketed under "aiProviders" rather than "elevenlabs": it is a separate pay-as-you-go
 * vendor, and folding it into the ElevenLabs bucket would hide it — that bucket is treated
 * read-side as amortized subscription usage, not real spend. `billing.ts` already declares
 * groq as payg, so this euro flows into marginal/Variable cost with no read-side change.
 */
export function recordGroqTranscription(runId: string, audioSec: number): void {
  const p = priceGroqTranscription(audioSec);
  record(runId, { provider: "groq", category: "aiProviders", rateKind: "groq", ...p });
}

/**
 * Gemini text or vision.
 *
 * `category` picks the UI BUCKET only ("geminiText" for planner/rerank,
 * "geminiVision" for frame/crop scoring). It no longer picks the RATE — that comes
 * from `model` via `geminiRateKind()`, because the call site's role and the model it
 * runs on are independent (see the note on `geminiRateKind`).
 *
 * Token counts come straight from the response's usageMetadata. The prompt/output
 * split is stored (`units` = total, `units_out` = output) so the row can be repriced
 * later; collapsing them into one number is what made older rows unrepriceable.
 */
export function recordGemini(
  runId: string,
  category: "geminiText" | "geminiVision",
  promptTokens: number,
  outputTokens: number,
  model: string
): void {
  const rateKind = geminiRateKind(model);
  const { amountEur, estimated } = priceGeminiTokens(promptTokens, outputTokens, rateKind);
  const out = Math.max(0, outputTokens);
  record(runId, {
    provider: `gemini:${model}`,
    category,
    units: Math.max(0, promptTokens) + out,
    unitsOut: out,
    unitLabel: "tokens",
    amountEur,
    estimated,
    rateKind,
  });
}

export function recordKieImage(runId: string, images = 1): void {
  const p = priceKieImage(images);
  record(runId, { provider: "kie:nano-banana", category: "aiProviders", rateKind: "kie:image", ...p });
}

export function recordKieVeo(runId: string, seconds: number): void {
  const p = priceKieVeo(seconds);
  record(runId, { provider: "kie:veo", category: "aiProviders", rateKind: "kie:veo", ...p });
}

/** Bill an avatar beat at the rate of the engine that actually rendered it. */
export function recordHeygenEngine(runId: string, seconds: number, engine: HeygenEngine): void {
  const p = priceHeygenEngine(seconds, engine);
  record(runId, { provider: "heygen", category: "aiProviders", rateKind: `heygen:${engine}`, ...p });
}

/** Unchanged boolean view for the v2 engines — an adapter, not a second model. */
export function recordHeygen(runId: string, seconds: number, useAvatarIv = true): void {
  recordHeygenEngine(runId, seconds, useAvatarIv ? "avatar_iv" : "unlimited");
}

export function recordLabs69(runId: string, videos = 1): void {
  const p = priceLabs69Video(videos);
  record(runId, { provider: "69labs", category: "aiProviders", rateKind: "69labs:video", ...p });
}

/**
 * 69labs STILL image — a different product at a different price from its video.
 *
 * Both used to go through `recordLabs69`, so every generated still was priced with
 * the per-VIDEO rate and written to the ledger with unit_label "videos". The unit
 * count was therefore right and the rate was wrong, and no operator could tell the
 * two apart on /costs.
 */
export function recordLabs69Image(runId: string, images = 1): void {
  const p = priceLabs69Image(images);
  record(runId, { provider: "69labs:image", category: "aiProviders", rateKind: "69labs:image", ...p });
}

export function recordMagnificImage(runId: string, images = 1): void {
  const p = priceMagnificImage(images);
  record(runId, { provider: "magnific:mystic", category: "aiProviders", rateKind: "magnific:image", ...p });
}

export function recordMagnificVideo(runId: string, seconds: number): void {
  const p = priceMagnificVideo(seconds);
  record(runId, { provider: "magnific:video", category: "aiProviders", rateKind: "magnific:video", ...p });
}

/** Higgsfield image (Soul / third-party) — pay-as-you-go, bucketed under aiProviders. */
export function recordHiggsfieldImage(runId: string, images = 1): void {
  const p = priceHiggsfieldImage(images);
  record(runId, { provider: "higgsfield:soul", category: "aiProviders", rateKind: "higgsfield:image", ...p });
}

/** Higgsfield video (DoP / Kling / Seedance) — billed per generated video-second. */
export function recordHiggsfieldVideo(runId: string, seconds: number): void {
  const p = priceHiggsfieldVideo(seconds);
  record(runId, { provider: "higgsfield:dop", category: "aiProviders", rateKind: "higgsfield:video", ...p });
}

/**
 * Runware image — the only recorder that can write a REAL billed amount.
 *
 * `reportedUsd` is what Runware's `includeCost` returned for this generation; pass
 * null when it returned nothing (the configurable fallback rate applies, default 0 —
 * we never fabricate a number). `priceRunwareImage` sets `estimated` accordingly, so
 * a row's honesty is decided in one place.
 *
 * The provider string carries the AIR model id so /costs can attribute spend PER
 * MODEL — the comparison an operator evaluating Runware actually needs, given the
 * catalog spans a ~100x price range. Same `provider:model` shape as `gemini:<model>`,
 * and `providerBase()` still resolves it to "runware" for the billing-mode rule.
 */
export function recordRunwareImage(runId: string, reportedUsd: number | null, model: string): void {
  const p = priceRunwareImage(1, reportedUsd);
  // Store the reported USD itself, not just the euro it converted to. That number is
  // MONEY, and keeping it in the currency Runware billed in means a corrected FX rate
  // restates it too — flattening it to EUR at write time threw that away.
  record(runId, {
    provider: `runware:${model}`,
    category: "aiProviders",
    rateKind: "runware:image",
    amountUsd: reportedUsd,
    ...p,
  });
}

// ── Read aggregation (for /api/costs) ──

export interface RunCostBreakdown {
  elevenlabs: number;
  geminiText: number;
  geminiVision: number;
  aiProviders: number;
  total: number;
}

const aggregateStmt = db.prepare(
  `SELECT run_id, category, SUM(amount_eur) AS amount
   FROM run_costs GROUP BY run_id, category`
);

const monthlyUnitsStmt = db.prepare(
  `SELECT provider, unit_label, SUM(units) AS units
   FROM run_costs WHERE ts >= ? AND ts < ? GROUP BY provider, unit_label`
);

/**
 * Recorded usage (raw units, e.g. chars / clip-sec) per provider in the half-open billing
 * window [sinceIso, untilIso) (ISO timestamps comparable to run_costs.ts). Feeds the
 * subscription quota view on the Cost page — e.g. ElevenLabs chars this period, HeyGen
 * clip-seconds this period. The explicit end bound makes the period a closed-open interval
 * rather than relying on "no future rows".
 */
export function monthlyUnitsByProvider(sinceIso: string, untilIso: string): { provider: string; unitLabel: string; units: number }[] {
  const rows = monthlyUnitsStmt.all(sinceIso, untilIso) as { provider: string; unit_label: string | null; units: number }[];
  return rows.map((r) => ({ provider: String(r.provider), unitLabel: String(r.unit_label ?? ""), units: Number(r.units) || 0 }));
}

/**
 * Voiceover providers that previously recorded NOTHING.
 *
 * `dispatchTts` has nine branches and only three (AI84, Fish Audio, Hume) were
 * metered. A run narrated by HeyGen — the DEFAULT `TTS_PROVIDER` — or by 69labs,
 * OpenAI, MiniMax or GenAIPro therefore reported zero voiceover spend, while the
 * narration is typically the largest single cost in the video.
 *
 * All five bill per character of synthesized text, so they share one recorder; the
 * `rateKind` is what separates them for pricing and for the per-provider breakdown.
 */
export type TtsRateKind = Extract<RateKind, "heygen:tts" | "69labs:tts" | "openai:tts" | "minimax:tts" | "genaipro:tts">;

export function recordTtsChars(runId: string, chars: number, rateKind: TtsRateKind): void {
  const p = priceTtsChars(chars, rateKind);
  record(runId, { provider: rateKind, category: "aiProviders", rateKind, ...p });
}

/**
 * Storyblocks — the BILLED step is resolving a clip's file, not searching for it.
 * Was unmetered and, worse, absent from the Costs page's provider table entirely, so
 * it was invisible in every dimension: no euro, no usage, no provider chip.
 */
export function recordStoryblocksDownload(runId: string, downloads = 1): void {
  const p = priceStoryblocksDownload(downloads);
  record(runId, { provider: "storyblocks", category: "aiProviders", rateKind: "storyblocks:download", ...p });
}

/**
 * Google Custom Search — free for the first 100 queries/day, billed above that.
 * Recorded so the query VOLUME is visible even when the rate is 0 (i.e. the operator
 * believes they stay inside the free tier); that count is what tells them otherwise.
 */
export function recordGoogleCseQuery(runId: string, queries = 1): void {
  const p = priceGoogleCseQuery(queries);
  record(runId, { provider: "googlecse", category: "aiProviders", rateKind: "googlecse:query", ...p });
}

/**
 * ── Read-time pricing ────────────────────────────────────────────────────────
 *
 * The aggregates below no longer `SUM(amount_eur)`. They sum the priceable FACTS
 * and hand them to `priceRow()`, so the euro on /costs is computed from the rates
 * in force right now. That is what makes a rate correction reach history: filling
 * in COST_LABS69_USD_PER_VIDEO reprices all 382 already-recorded videos on the
 * next page load, instead of leaving them frozen at the €0.00 they were written at.
 *
 * Summing-then-pricing is exact because every rate is LINEAR in units. The one
 * requirement is that a group be homogeneous in how it prices, so every GROUP BY
 * below includes `rate_kind` and the two "can this be repriced at all" flags:
 *
 *   amount_usd IS NULL  — a real provider-billed amount vs a modelled estimate
 *   units_out IS NULL   — a two-rate (Gemini) row whose in/out split was never
 *                         stored, and so cannot be repriced
 *
 * Mixing those inside one group would silently price part of it wrong.
 */
interface FactRow {
  provider: string;
  rate_kind: string | null;
  units: number;
  units_out: number | null;
  amount_usd: number | null;
  amount_eur: number;
  estimated: number;
}

/** One aggregated bucket, already priced against current settings. */
export interface PricedSpend {
  provider: string;
  rateKind: string | null;
  amountEur: number;
  units: number;
  /** Provider-billed truth rather than a model of it. */
  real: boolean;
  /** False = we showed the as-recorded euro because this bucket can't be repriced. */
  repriced: boolean;
  /** False = no rate is configured; a €0.00 here means "unpriced", not "free". */
  rateKnown: boolean;
}

function priceFacts<E extends object, R extends FactRow>(rows: R[], extra: (r: R) => E): (PricedSpend & E)[];
function priceFacts<R extends FactRow>(rows: R[]): PricedSpend[];
function priceFacts<R extends FactRow>(rows: R[], extra: (r: R) => object = () => ({})): PricedSpend[] {
  return rows.map((r) => {
    const p = priceRow({
      rateKind: r.rate_kind,
      units: Number(r.units) || 0,
      unitsOut: r.units_out == null ? null : Number(r.units_out),
      amountUsd: r.amount_usd == null ? null : Number(r.amount_usd),
      amountEur: Number(r.amount_eur) || 0,
      estimated: r.estimated !== 0,
    });
    return {
      provider: String(r.provider),
      rateKind: r.rate_kind,
      amountEur: p.eur,
      units: Number(r.units) || 0,
      real: p.real,
      repriced: p.repriced,
      rateKnown: p.rateKnown,
      ...extra(r),
    };
  });
}

const FACT_COLS = `provider, rate_kind, estimated,
   SUM(units) AS units,
   CASE WHEN COUNT(units_out) = 0 THEN NULL ELSE SUM(units_out) END AS units_out,
   CASE WHEN COUNT(amount_usd) = 0 THEN NULL ELSE SUM(amount_usd) END AS amount_usd,
   SUM(amount_eur) AS amount_eur`;
const FACT_GROUP = `provider, rate_kind, estimated, (units_out IS NULL), (amount_usd IS NULL)`;

const spendByProviderStmt = db.prepare(
  `SELECT ${FACT_COLS} FROM run_costs GROUP BY ${FACT_GROUP}`
);

/**
 * All-time spend per raw provider string (e.g. "elevenlabs", "gemini:…", "kie:veo",
 * "heygen", "69labs"), priced against CURRENT rates. Lets the Cost API compute the
 * pay-as-you-go ("variable") total while EXCLUDING providers on a subscription —
 * which the 4 fixed buckets can't do (heygen is lumped into aiProviders).
 *
 * A provider can appear more than once (one row per rate_kind / repriceability
 * group); callers already accumulate rather than assume uniqueness.
 */
export function spendByProvider(): PricedSpend[] {
  return priceFacts(spendByProviderStmt.all() as FactRow[]);
}

const monthlySpendByProviderStmt = db.prepare(
  `SELECT ${FACT_COLS} FROM run_costs WHERE ts >= ? AND ts < ? GROUP BY ${FACT_GROUP}`
);

/**
 * Same as `spendByProvider()` but bounded to the half-open billing window
 * [sinceIso, untilIso), so "Variable spend (this period)" shares one clock with the
 * fixed subscription fees + quota view. The explicit end bound makes the period a
 * closed-open interval (no reliance on "no future rows").
 */
export function monthlySpendByProvider(sinceIso: string, untilIso: string): PricedSpend[] {
  return priceFacts(monthlySpendByProviderStmt.all(sinceIso, untilIso) as FactRow[]);
}

const spendByRunProviderStmt = db.prepare(
  `SELECT run_id, unit_label, ${FACT_COLS}
   FROM run_costs GROUP BY run_id, unit_label, ${FACT_GROUP}`
);

/**
 * Per-run, per-provider spend + raw units, priced at read time. Gives the Cost API
 * the granularity to compute each run's MARGINAL (added) cost = Σ € over payg
 * providers only, and to show subscription providers' USAGE (credits) instead of an
 * amortized euro. The coarse `aggregateCostsByRun()` can't do this because
 * "aiProviders" lumps voice/transcription vendors in with the b-roll ones.
 */
export function spendByRunProvider(): (PricedSpend & { runId: string; unitLabel: string })[] {
  const rows = spendByRunProviderStmt.all() as (FactRow & { run_id: string; unit_label: string | null })[];
  return priceFacts(rows, (r) => ({
    runId: String(r.run_id),
    unitLabel: String(r.unit_label ?? ""),
  }));
}

/** run_id → per-bucket EUR totals. Runs with no metered events are absent. */
export function aggregateCostsByRun(): Map<string, RunCostBreakdown> {
  const out = new Map<string, RunCostBreakdown>();
  const rows = aggregateStmt.all() as { run_id: string; category: string; amount: number }[];
  for (const r of rows) {
    let b = out.get(r.run_id);
    if (!b) {
      b = { elevenlabs: 0, geminiText: 0, geminiVision: 0, aiProviders: 0, total: 0 };
      out.set(r.run_id, b);
    }
    const amount = Number(r.amount) || 0;
    if (r.category === "elevenlabs") b.elevenlabs += amount;
    else if (r.category === "geminiText") b.geminiText += amount;
    else if (r.category === "geminiVision") b.geminiVision += amount;
    else if (r.category === "aiProviders") b.aiProviders += amount;
    b.total += amount;
  }
  return out;
}

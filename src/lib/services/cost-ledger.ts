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
  priceGeminiTokens,
  priceKieImage,
  priceKieVeo,
  priceHeygen,
  priceLabs69Video,
  priceMagnificImage,
  priceMagnificVideo,
} from "../pricing";

const insertCost = db.prepare(
  `INSERT INTO run_costs (run_id, provider, category, units, unit_label, amount_eur, estimated)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

interface CostEvent {
  provider: string;
  category: CostCategory;
  units: number;
  unitLabel: string;
  amountEur: number;
  estimated: boolean;
}

/** Low-level append. Never throws. */
function record(runId: string, e: CostEvent): void {
  try {
    if (!runId) return;
    insertCost.run(runId, e.provider, e.category, e.units, e.unitLabel, e.amountEur, e.estimated ? 1 : 0);
  } catch {
    // fail-open: a lost cost row must not affect the run
  }
}

// ── Typed recorders (one call per metered event at each provider call site) ──

export function recordElevenlabs(runId: string, chars: number): void {
  const p = priceElevenlabs(chars);
  record(runId, { provider: "elevenlabs", category: "elevenlabs", ...p });
}

/**
 * Gemini text or vision. `category` picks the bucket ("geminiText" for
 * planner/rerank, "geminiVision" for frame/crop scoring). Token counts come
 * straight from the response's usageMetadata. `model` is recorded as the
 * provider for audit.
 */
export function recordGemini(
  runId: string,
  category: "geminiText" | "geminiVision",
  promptTokens: number,
  outputTokens: number,
  model: string
): void {
  const { amountEur, estimated } = priceGeminiTokens(promptTokens, outputTokens);
  record(runId, {
    provider: `gemini:${model}`,
    category,
    units: Math.max(0, promptTokens) + Math.max(0, outputTokens),
    unitLabel: "tokens",
    amountEur,
    estimated,
  });
}

export function recordKieImage(runId: string, images = 1): void {
  const p = priceKieImage(images);
  record(runId, { provider: "kie:nano-banana", category: "aiProviders", ...p });
}

export function recordKieVeo(runId: string, seconds: number): void {
  const p = priceKieVeo(seconds);
  record(runId, { provider: "kie:veo", category: "aiProviders", ...p });
}

export function recordHeygen(runId: string, seconds: number): void {
  const p = priceHeygen(seconds);
  record(runId, { provider: "heygen", category: "aiProviders", ...p });
}

export function recordLabs69(runId: string, videos = 1): void {
  const p = priceLabs69Video(videos);
  record(runId, { provider: "69labs", category: "aiProviders", ...p });
}

export function recordMagnificImage(runId: string, images = 1): void {
  const p = priceMagnificImage(images);
  record(runId, { provider: "magnific:mystic", category: "aiProviders", ...p });
}

export function recordMagnificVideo(runId: string, seconds: number): void {
  const p = priceMagnificVideo(seconds);
  record(runId, { provider: "magnific:video", category: "aiProviders", ...p });
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

const spendByProviderStmt = db.prepare(
  `SELECT provider, SUM(amount_eur) AS amount FROM run_costs GROUP BY provider`
);

/**
 * All-time metered EUR per raw provider string (e.g. "elevenlabs", "gemini:...",
 * "kie:veo", "heygen", "69labs"). Lets the Cost API compute the pay-as-you-go
 * ("variable") total while EXCLUDING providers the user has on a subscription —
 * which the 4 fixed buckets can't do (heygen is lumped into aiProviders).
 */
export function spendByProvider(): { provider: string; amountEur: number }[] {
  return (spendByProviderStmt.all() as { provider: string; amount: number }[]).map((r) => ({
    provider: String(r.provider),
    amountEur: Number(r.amount) || 0,
  }));
}

const monthlySpendByProviderStmt = db.prepare(
  `SELECT provider, SUM(amount_eur) AS amount FROM run_costs WHERE ts >= ? AND ts < ? GROUP BY provider`
);

/**
 * Metered EUR per raw provider in the half-open billing window [sinceIso, untilIso). Same
 * shape as `spendByProvider()` but bounded to the period, so the Cost page's "Variable spend
 * (this period)" shares one clock with the fixed subscription fees + quota view. The explicit
 * end bound makes the period a closed-open interval (no reliance on "no future rows").
 */
export function monthlySpendByProvider(sinceIso: string, untilIso: string): { provider: string; amountEur: number }[] {
  return (monthlySpendByProviderStmt.all(sinceIso, untilIso) as { provider: string; amount: number }[]).map((r) => ({
    provider: String(r.provider),
    amountEur: Number(r.amount) || 0,
  }));
}

const spendByRunProviderStmt = db.prepare(
  `SELECT run_id, provider, SUM(amount_eur) AS amount, SUM(units) AS units, unit_label
   FROM run_costs GROUP BY run_id, provider, unit_label`
);

/**
 * Per-run, per-provider metered EUR + raw units. Gives the Cost API the granularity to
 * compute each run's MARGINAL (added) cost = Σ amount_eur over payg providers only, and to
 * show subscription providers' usage (credits) instead of an amortized euro. The coarse
 * `aggregateCostsByRun()` (4 category buckets) can't do this because "aiProviders" lumps a
 * subscription provider (heygen) with payg ones (kie, 69labs).
 */
export function spendByRunProvider(): { runId: string; provider: string; amountEur: number; units: number; unitLabel: string }[] {
  const rows = spendByRunProviderStmt.all() as { run_id: string; provider: string; amount: number; units: number; unit_label: string | null }[];
  return rows.map((r) => ({
    runId: String(r.run_id),
    provider: String(r.provider),
    amountEur: Number(r.amount) || 0,
    units: Number(r.units) || 0,
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

/**
 * pool-metrics — off-line, deterministic measurement of the CANDIDATE SELECTION path.
 *
 * Answers the question the bake-off deliberately stops short of: given the same provider
 * results, does a change to slot allocation / the prefilter / the surrender gates deliver
 * a better pool to the scorer, and at what Gemini cost.
 *
 * ── What this measures, and what it does NOT ────────────────────────────────────────────
 *
 * It runs the REAL internals — mergePools, shouldBypassGemini, prefilterCandidates,
 * fallbackSemanticScore, rankKey, poolIsWeak, hasLikelyEntity — over CAPTURED provider
 * lists. Nothing is re-derived here, so nothing can drift as those are tuned.
 *
 * Two honest limits, both of which make it valid for A/B and invalid as a forecast:
 *
 *  1. The verdict per candidate comes from `fallbackSemanticScore` on the lexical bars
 *     (video >= 65, image >= 80) — the scorer the pipeline itself falls back to when Gemini
 *     is unavailable. It is free and deterministic, which is the whole point: it measures
 *     the SHAPE of selection, not Gemini's judgement. A stage that looks good here still
 *     needs the one paid `--score gemini` confirmation pass before/after the series.
 *  2. It models ATTEMPT 0 only. Production follows with a broaden ladder (up to 3 attempts),
 *     so `noPass` over-counts AI routing in absolute terms. It is still the right comparison
 *     surface, because attempt 0 is where allocation and the cut do their work — and the
 *     over-count is identical on both sides of an A/B.
 *
 * So: read the DELTAS, never the absolute levels.
 *
 * ── Metrics ────────────────────────────────────────────────────────────────────────────
 *   noPass       — queries where no candidate cleared the bars (the AI-routing proxy)
 *   routedWeak   — subset of those decided by the poolIsWeak gate before any scoring
 *   providerMix  — which provider supplied the winning candidate
 *   videoShare   — reported at TWO points: the set shown to Gemini, and the final pick.
 *                  Both matter. Improving "candidates that survived the cut" by handing the
 *                  slots to stills would flatter the headline number and make the video worse
 *                  — the trap CLAUDE.md already documents for wigolo.
 *   geminiImages — inline images actually sent (candidates with a usable thumbUrl), plus the
 *                  vision-call count and the bypass count. This one is EXACT, not a proxy,
 *                  whatever scorer stands in — it is the client's money.
 *
 * Used as a library by scripts/wigolo-bakeoff.ts (--pools / --baseline). Pure: no network,
 * no run, no writes. Note prefilterCandidates logs when it trims, so point
 * FACELESS_STUDIO_DATA_DIR at a scratch dir to keep those rows out of the real DB.
 */
import { __testing, type ProviderHit } from "../src/lib/services/visual-source";

/** One query's captured provider results — the input to a simulation. */
export interface CapturedQuery {
  query: string;
  /** Planner fields, when the fixture carries them (JSONL). Unused until Stage 6. */
  text?: string;
  queryType?: string;
  footageKind?: string;
  /** provider name → its hit list, already per-provider capped exactly as gatherCandidates caps it. */
  lists: Record<string, ProviderHit[]>;
}

export interface QueryOutcome {
  query: string;
  poolSize: number;
  /** Candidates that survived the 14 → 10 cut and would be scored. */
  scoredSize: number;
  scoredVideos: number;
  /** Inline images actually sent to Gemini for this query. */
  geminiImages: number;
  visionCalls: number;
  bypassed: boolean;
  /** null when nothing cleared the bars. */
  pickProvider: string | null;
  pickKind: "video" | "image" | null;
  /** True when the poolIsWeak gate ended it before any scoring. */
  routedWeak: boolean;
}

export interface Metrics {
  queries: number;
  noPass: number;
  routedWeak: number;
  bypassed: number;
  visionCalls: number;
  geminiImages: number;
  poolTotal: number;
  /** Video share of the set shown to Gemini, 0..1. */
  scoredVideoShare: number;
  /** Video share of the final picks, 0..1. */
  pickVideoShare: number;
  /**
   * Absolute pick counts behind pickVideoShare. Reported because the SHARE alone is
   * unreadable when the denominator moves: rescuing a beat from AI with a still lowers the
   * share while costing no video at all, which reads exactly like the video-traded-for-stills
   * regression this metric exists to catch. Only the counts separate the two.
   */
  pickVideos: number;
  pickTotal: number;
  providerMix: Record<string, number>;
}

/** Lexical-fallback acceptance bars — the same pair acquireReal applies on that path. */
const LEX_VIDEO_BAR = 65;
const LEX_IMAGE_BAR = 80;

/**
 * Replay ONE query through attempt 0 of the real selection path, in the real order:
 * merge → weak-pool gate → bypass → prefilter → score → bars → rankKey.
 */
export function simulateQuery(q: CapturedQuery): QueryOutcome {
  const base: QueryOutcome = {
    query: q.query,
    poolSize: 0,
    scoredSize: 0,
    scoredVideos: 0,
    geminiImages: 0,
    visionCalls: 0,
    bypassed: false,
    pickProvider: null,
    pickKind: null,
    routedWeak: false,
  };

  // gatherCandidates tags each hit with its provider before merging; the capture stores the
  // lists keyed by provider, so re-tag here rather than trusting whatever was serialized.
  const lists = Object.entries(q.lists).map(([name, hits]) =>
    hits.slice(0, __testing.SOURCE_POOL_PER_PROVIDER).map((h) => ({ ...h, provider: name }))
  );
  const pool = __testing.mergePools(lists, new Set<string>(), __testing.SOURCE_POOL_MAX);
  base.poolSize = pool.length;
  if (pool.length === 0) return base;

  // The gate that turns into AI spend, before anything is scored.
  if (!__testing.hasLikelyEntity(q.query) && __testing.poolIsWeak(pool)) {
    return { ...base, routedWeak: true };
  }

  // A dominant Pexels video is taken with no vision call at all.
  const dominant = __testing.shouldBypassGemini(pool);
  if (dominant) {
    return { ...base, bypassed: true, pickProvider: dominant.provider ?? "?", pickKind: dominant.kind };
  }

  const keep = __testing.prefilterCandidates(pool, q.query, "pool-metrics", 0);
  // scoreAndPick sends a candidate's preview only when it has one; the rest go as a title line.
  const geminiImages = keep.filter((h) => h.thumbUrl).length;
  const scored = keep.map((hit) => ({ hit, score: __testing.fallbackSemanticScore(q.query, hit) }));
  const passing = scored
    .filter((c) => (c.hit.kind === "video" ? c.score >= LEX_VIDEO_BAR : c.score >= LEX_IMAGE_BAR))
    .sort((a, b) => __testing.rankKey(b) - __testing.rankKey(a));
  const pick = passing[0];

  return {
    ...base,
    scoredSize: keep.length,
    scoredVideos: keep.filter((h) => h.kind === "video").length,
    geminiImages,
    visionCalls: 1,
    pickProvider: pick ? pick.hit.provider ?? "?" : null,
    pickKind: pick ? pick.hit.kind : null,
  };
}

export function summarize(outcomes: QueryOutcome[]): Metrics {
  const providerMix: Record<string, number> = {};
  for (const o of outcomes) if (o.pickProvider) providerMix[o.pickProvider] = (providerMix[o.pickProvider] ?? 0) + 1;

  const scoredTotal = outcomes.reduce((n, o) => n + o.scoredSize, 0);
  const picks = outcomes.filter((o) => o.pickKind);

  return {
    queries: outcomes.length,
    noPass: outcomes.filter((o) => !o.pickProvider).length,
    routedWeak: outcomes.filter((o) => o.routedWeak).length,
    bypassed: outcomes.filter((o) => o.bypassed).length,
    visionCalls: outcomes.reduce((n, o) => n + o.visionCalls, 0),
    geminiImages: outcomes.reduce((n, o) => n + o.geminiImages, 0),
    poolTotal: outcomes.reduce((n, o) => n + o.poolSize, 0),
    scoredVideoShare: scoredTotal ? outcomes.reduce((n, o) => n + o.scoredVideos, 0) / scoredTotal : 0,
    pickVideoShare: picks.length ? picks.filter((o) => o.pickKind === "video").length / picks.length : 0,
    pickVideos: picks.filter((o) => o.pickKind === "video").length,
    pickTotal: picks.length,
    providerMix,
  };
}

export function measure(queries: CapturedQuery[]): { outcomes: QueryOutcome[]; metrics: Metrics } {
  const outcomes = queries.map(simulateQuery);
  return { outcomes, metrics: summarize(outcomes) };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** `12 (+3)` against a baseline; an unchanged number stays bare so real movement stands out. */
const delta = (now: number, was?: number) => {
  if (was === undefined || now === was) return String(now);
  const d = now - was;
  return `${now} (${d > 0 ? "+" : ""}${d})`;
};

/** Human-readable report; `baseline` turns every line into a before/after. */
export function formatMetrics(m: Metrics, baseline?: Metrics): string {
  const out: string[] = [];
  out.push(`queries            ${m.queries}`);
  out.push(
    `no pass (AI proxy) ${delta(m.noPass, baseline?.noPass)}` +
      `  of which weak-gate ${delta(m.routedWeak, baseline?.routedWeak)}`
  );
  out.push(`pool candidates    ${delta(m.poolTotal, baseline?.poolTotal)}`);
  out.push(
    `video share        scored ${pct(m.scoredVideoShare)}` +
      `${baseline ? ` (was ${pct(baseline.scoredVideoShare)})` : ""}` +
      `   picked ${pct(m.pickVideoShare)}${baseline ? ` (was ${pct(baseline.pickVideoShare)})` : ""}`
  );
  // The counts behind that share — a falling share with a RISING video count means stills
  // displaced AI, not video. Read this line before reacting to the one above.
  out.push(
    `video picks        ${delta(m.pickVideos, baseline?.pickVideos)} of ${delta(m.pickTotal, baseline?.pickTotal)} beats that picked anything`
  );
  out.push(
    `gemini             ${delta(m.visionCalls, baseline?.visionCalls)} calls, ` +
      `${delta(m.geminiImages, baseline?.geminiImages)} images, ` +
      `${delta(m.bypassed, baseline?.bypassed)} bypassed`
  );
  out.push(`provider mix (winning candidate)`);
  const names = new Set([...Object.keys(m.providerMix), ...Object.keys(baseline?.providerMix ?? {})]);
  for (const n of [...names].sort((a, b) => (m.providerMix[b] ?? 0) - (m.providerMix[a] ?? 0))) {
    const was = baseline ? ` (was ${baseline.providerMix[n] ?? 0})` : "";
    out.push(`  ${n.padEnd(12)} ${String(m.providerMix[n] ?? 0).padStart(4)}${was}`);
  }
  return out.join("\n");
}

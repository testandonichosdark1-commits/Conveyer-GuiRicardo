import { NextResponse } from "next/server";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { fxUsdToEur } from "@/lib/pricing";
import { probeAudioStrict } from "@/lib/services/video-assemble";
import fs from "node:fs";
import {
  monthlyUnitsByProvider,
  monthlySpendByProvider,
  spendByProvider,
  spendByRunProvider,
} from "@/lib/services/cost-ledger";
import {
  costProviders,
  getBillingProfiles,
  subscriptionView,
  elevenlabsCharsToCredits,
  effectiveAllocationEur,
  elevenlabsIsFlash,
  providerBillingMode,
  providerBase,
  billingPeriod,
  SUB_META,
  type SubProviderId,
} from "@/lib/billing";

/**
 * Cost Monitoring data for the /costs page — ONE consistent billing model, ONE clock.
 *
 * Everything reconciles within the CURRENT UTC calendar month:
 *   Total this month = Fixed subscription fees + Variable spend
 *   Variable spend   = Σ payg € (this month) + Σ subscription overage (this month)
 *
 * The subscription provider (ElevenLabs) never contributes an amortized per-unit € —
 * its `run_costs.amount_eur` is ignored on read (only its usage feeds the quota view);
 * its cost is the flat monthly plan fee (+ overage). HeyGen is now pay-as-you-go, so its
 * metered € is counted like any other payg provider. Every per-run number is the run's
 * MARGINAL (added) cost = its pay-as-you-go € only. `providerBillingMode()` is the single
 * classifier that decides payg-vs-subscription everywhere below.
 */
/**
 * Every run, not a window of them.
 *
 * This used to be `LIMIT 200`. With 217 runs the 17 oldest silently vanished from the
 * table — and, worse, from `thisPeriodMinutes`, whose denominator was built from this
 * same capped list while the € totals came from the unbounded ledger. A cap that
 * changes a headline number is not a display concern.
 *
 * `deleted_at` is deliberately NOT filtered (see db.ts): a soft-deleted run's costs
 * were still spent, so it stays in the accounting. It is flagged instead, because its
 * detail page 404s and a dead link with no explanation reads as a bug.
 */
const listRuns = db.prepare(
  `SELECT id, title, status, created_at, duration_sec, deleted_at
   FROM runs ORDER BY created_at DESC`
);

/**
 * Generated minutes inside the billing window — the €/min denominator.
 *
 * Computed in SQL over ALL runs rather than by looping the (previously capped) list,
 * and fixing three things at once:
 *   • an upper bound, so the window is closed-open exactly like the € side. It had
 *     only `>= start`, so any future-dated run leaked in.
 *   • `status = 'done'`, so cancelled/errored runs that happen to carry a duration
 *     stop inflating the denominator and deflating €/min.
 *   • `duration_sec > 0`, so the NULLs on pre-column runs are excluded rather than
 *     counted as zero-length.
 *
 * `runs.created_at` is sqlite `datetime('now')` — "YYYY-MM-DD HH:MM:SS", UTC, no "T"
 * and no "Z" — so it is compared against the period's DATE-ONLY prefix. Comparing it
 * to a full ISO string would be a lexical mismatch at position 10 (' ' vs 'T').
 */
const periodMinutesStmt = db.prepare(
  `SELECT COALESCE(SUM(duration_sec), 0) AS sec FROM runs
   WHERE status = 'done' AND duration_sec > 0
     AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) < ?`
);

interface RunRow {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  duration_sec: number | null;
  deleted_at: string | null;
}

/**
 * Recover `duration_sec` for finished runs that predate the column.
 *
 * 101 of 197 done runs have no duration, so they show "—" for cost/min AND drop out
 * of the €/min denominator — which silently inflates the blended rate for any period
 * containing them. Their `final.mp4` is still on disk, so the number is recoverable.
 *
 * Done in SMALL BATCHES on read, not as a boot migration: 101 ffprobe calls would
 * block app startup, and this is display data, not something the pipeline depends on.
 * The page polls every 5s, so an open Costs tab drains the backlog in about a minute
 * and then this costs one indexed query per request forever after.
 *
 * `probeAudioStrict`, never `probeDurationSafe`: the safe probe invents a duration
 * from file size when it cannot read a file, which would write a fabricated number
 * into the very column we are trying to make trustworthy. The audio track of the
 * final render is also exactly what a fresh run stores (`voiceover.durationSec`), so
 * the backfilled value means the same thing as a natively-written one.
 */
/**
 * Written when a run's duration is UNRECOVERABLE — its video is gone (deleting a run
 * removes the files but keeps the row for accounting) or ffprobe cannot read it.
 *
 * A distinct sentinel is required, not 0. The selection below has to mean "not yet
 * attempted", and marking a failure with 0 does not remove the row from a
 * `duration_sec <= 0` predicate — so the same handful of dead files were re-probed on
 * every request and, being newest-first, permanently blocked the batch window behind
 * them. Measured: 12 polls recovered 18 of 101 instead of draining it.
 *
 * -1 is safe downstream because every consumer tests `> 0`, so it reads as "no
 * duration" exactly like NULL.
 */
const DURATION_UNRECOVERABLE = -1;

const missingDurationStmt = db.prepare(
  `SELECT id, output_path FROM runs
   WHERE status = 'done' AND duration_sec IS NULL
     AND output_path IS NOT NULL AND output_path != ''
   ORDER BY created_at DESC LIMIT ?`
);
const setDurationStmt = db.prepare("UPDATE runs SET duration_sec = ? WHERE id = ?");

async function backfillDurations(batch = 10): Promise<void> {
  let pending: { id: string; output_path: string }[];
  try {
    pending = missingDurationStmt.all(batch) as { id: string; output_path: string }[];
  } catch {
    return;
  }
  for (const r of pending) {
    try {
      if (!fs.existsSync(r.output_path)) {
        setDurationStmt.run(DURATION_UNRECOVERABLE, r.id);
        continue;
      }
      const { durationSec } = await probeAudioStrict(r.output_path);
      setDurationStmt.run(durationSec > 0 ? durationSec : DURATION_UNRECOVERABLE, r.id);
    } catch {
      setDurationStmt.run(DURATION_UNRECOVERABLE, r.id);
    }
  }
}

export async function GET() {
  ensureInit();
  // Recover a few missing run durations per request (see backfillDurations).
  await backfillDurations();

  // ONE interpretation of the FX key. This was `Number(getSetting(...)) || 0.92`,
  // which treats a blank/0 rate as falsy and substitutes 0.92 — while pricing.ts's
  // `num()` honours the 0. The same setting therefore produced two different answers:
  // subscription fees converted at 0.92 while every metered row priced at €0.00.
  const fx = fxUsdToEur();
  const flash = elevenlabsIsFlash();

  // ── Current billing period — one shared clock anchored on a configurable day ──
  const cycleStartDay = Number(getSetting("BILLING_CYCLE_START_DAY")) || 1;
  const period = billingPeriod(Date.now(), cycleStartDay);
  const periodStartIso = period.startIso;
  const periodStartDay = periodStartIso.slice(0, 10); // YYYY-MM-DD anchor

  // ── Per-run derivation — ONE provider-keyed aggregation, classified by
  // providerBillingMode(). Every per-run number (marginal, Gemini €, AI-broll €, and
  // subscription credits) comes from this single source, so marginal = gemini + aiPayg
  // by construction — no cross-aggregation subtraction. ──
  const marginalByRun = new Map<string, number>(); // Σ payg € per run
  const geminiByRun = new Map<string, number>(); // payg Gemini €
  const heygenByRun = new Map<string, number>(); // payg HeyGen € (avatar clips)
  const voiceByRun = new Map<string, number>(); // payg narration + transcription €
  const aiPaygByRun = new Map<string, number>(); // payg AI b-roll €
  const elevenCharsByRun = new Map<string, number>();
  /** Runs holding at least one row whose rate is unset — their € is an understatement. */
  const unpricedByRun = new Map<string, Set<string>>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  /**
   * Which column a payg provider reports under.
   *
   * "AI b-roll" used to be a catch-all `else`, so it silently absorbed Groq
   * transcription, AI84, Fish Audio, Hume and Runware — narration and footage added
   * together under a header that says footage. Voice now reports as voice, and the
   * buckets stay exhaustive (marginal = gemini + heygen + voice + aiBroll), which is
   * what keeps the per-run total reconcilable against its parts.
   */
  const VOICE_BASES = new Set(["groq", "ai84", "fishaudio", "hume", "openai", "minimax", "genaipro"]);
  for (const row of spendByRunProvider()) {
    const mode = providerBillingMode(row.provider);
    const base = providerBase(row.provider);
    // A rate nobody has set contributes €0 — record WHICH provider, so the page can say
    // "69labs: 382 videos, rate not set" instead of a confident, wrong €0.00.
    if (!row.rateKnown && row.units > 0 && mode !== "free") {
      let s = unpricedByRun.get(row.runId);
      if (!s) unpricedByRun.set(row.runId, (s = new Set()));
      s.add(row.rateKind || base);
    }
    if (mode === "payg") {
      add(marginalByRun, row.runId, row.amountEur);
      // HeyGen's API is pay-as-you-go, so its metered € is REAL per-run spend. Split out
      // from aiBroll so it reports as itself (it's the avatar, not b-roll).
      if (base === "gemini") add(geminiByRun, row.runId, row.amountEur);
      else if (base === "heygen" && row.rateKind !== "heygen:tts") add(heygenByRun, row.runId, row.amountEur);
      else if (VOICE_BASES.has(base) || row.rateKind?.endsWith(":tts")) add(voiceByRun, row.runId, row.amountEur);
      else add(aiPaygByRun, row.runId, row.amountEur);
    } else if (mode === "subscription") {
      if (base === "elevenlabs") add(elevenCharsByRun, row.runId, row.units);
    }
  }

  const rows = listRuns.all() as RunRow[];

  const runs = rows.map((r) => {
    const durationSec = typeof r.duration_sec === "number" && r.duration_sec > 0 ? r.duration_sec : null;
    const marginalEur = marginalByRun.get(r.id) ?? 0;
    const geminiEur = geminiByRun.get(r.id) ?? 0;
    const heygenEur = heygenByRun.get(r.id) ?? 0;
    const voiceEur = voiceByRun.get(r.id) ?? 0;
    const aiPaygEur = aiPaygByRun.get(r.id) ?? 0;
    // A run with NO ledger rows at all predates cost tracking (or was never metered).
    // Its cost is UNKNOWN, and rendering €0.00 there — indistinguishable from a genuinely
    // free run — is the most misleading cell on the page. The client shows "—".
    const tracked = marginalByRun.has(r.id) || elevenCharsByRun.has(r.id);
    return {
      runId: r.id,
      title: r.title || r.id.slice(0, 8),
      status: r.status,
      createdAt: r.created_at,
      deleted: Boolean(r.deleted_at),
      durationSec,
      tracked,
      /** Providers used by this run whose rate is unset → its € is a floor, not a total. */
      unpricedProviders: [...(unpricedByRun.get(r.id) ?? [])].sort(),
      marginalEur,
      geminiEur,
      heygenEur,
      voiceEur,
      aiPaygEur,
      elevenlabsCredits: elevenlabsCharsToCredits(elevenCharsByRun.get(r.id) ?? 0, flash),
      // Per-video cost/min is MARGINAL ÷ minutes (the added cost only).
      costPerMinute: durationSec ? marginalEur / (durationSec / 60) : null,
    };
  });

  // ── Subscriptions (this period): fee + quota + overage, or "Set up" ──
  const profiles = getBillingProfiles();
  const providers = costProviders();
  const labelOf = (id: string) => providers.find((p) => p.id === id)?.label ?? id;

  const units = monthlyUnitsByProvider(periodStartIso, period.endIso);
  const sumUnits = (p: string) => units.filter((u) => u.provider === p).reduce((s, u) => s + u.units, 0);
  const elevenlabsChars = sumUnits("elevenlabs");

  interface SubEntry {
    id: string;
    label: string;
    configured: boolean;
    plan: string | null;
    monthlyEur: number;
    quotaCredits: number;
    usedCredits: number;
    quotaLabel: string;
    quotaKnown: boolean;
    pct: number;
    overageEur: number;
  }
  // HeyGen's API is pay-as-you-go (its metered € flows into marginal/Variable via
  // providerBillingMode), so it renders no subscription card — ElevenLabs is the only
  // subscription. A leftover BILLING_PROFILES.heygen entry is harmless: it's simply
  // ignored (never summed as a fixed fee, so no double-count with the payg spend).
  const subscriptions: SubEntry[] = (["elevenlabs"] as SubProviderId[])
    .filter((id) => providers.find((p) => p.id === id)?.active)
    .map((id): SubEntry => {
      const prof = profiles[id];
      const configured = Boolean(prof?.plan); // a plan (or "Custom") has been chosen
      if (configured) {
        const usedCredits = elevenlabsCharsToCredits(elevenlabsChars, flash);
        const v = subscriptionView(id, prof!, usedCredits);
        return {
          id,
          label: labelOf(id),
          configured: true,
          plan: v.plan,
          monthlyEur: v.monthlyUsd * fx,
          quotaCredits: v.quotaCredits,
          usedCredits: v.usedCredits,
          quotaLabel: v.quotaLabel,
          quotaKnown: v.quotaKnown,
          pct: v.pct,
          overageEur: v.overageUsd * fx,
        };
      }
      return { id, label: labelOf(id), configured: false, plan: null, monthlyEur: 0, quotaCredits: 0, usedCredits: 0, quotaLabel: "credits", quotaKnown: false, pct: 0, overageEur: 0 };
    });

  // ── Effective subscription allocation (SECOND reporting layer — management metric, NOT an
  // invoice; see docs). Per run: the pro-rata share of each subscription's flat monthly fee
  // attributable to that run's usage = runCredits × (planFee / planQuota). This does NOT touch the
  // ledger, marginalEur, or the Fixed+Variable=Total reconciliation below — it's a derived read-side
  // number shown alongside marginal. `subscriptionAllocEur` is null when the run used a subscription
  // provider whose quota is unknown/unlimited/unconfigured (not allocatable) → the UI shows "—" and
  // falls back to marginal; effectiveTotal/perMinute are null in that case. ──
  const allocPlan: Record<string, { monthlyEur: number; quotaCredits: number }> = {};
  for (const s of subscriptions) allocPlan[s.id] = { monthlyEur: s.monthlyEur, quotaCredits: s.quotaKnown ? s.quotaCredits : 0 };
  const runsWithEffective = runs.map((r) => {
    let estimable = true;
    let alloc = 0;
    let usedSubscription = false;
    // ElevenLabs only — HeyGen has no monthly fee to allocate a share of; its API spend is
    // already real money in r.marginalEur (pay-as-you-go).
    for (const [id, credits] of [["elevenlabs", r.elevenlabsCredits]] as const) {
      if (credits <= 0) continue; // this run didn't use that subscription provider
      usedSubscription = true;
      const plan = allocPlan[id];
      const part = plan ? effectiveAllocationEur(credits, plan.monthlyEur, plan.quotaCredits) : null;
      if (part == null) estimable = false; // used a provider with unknown quota → not fully allocatable
      else alloc += part;
    }
    // Null, never 0, when there is nothing to allocate. A run that used no subscription
    // provider — or one on an install with no plan configured — used to render "€0.00"
    // here, which reads as "this video's subscription share was free" rather than "there
    // is no figure". Only a run that really did consume a priced quota gets a number.
    const subscriptionAllocEur = estimable && usedSubscription ? alloc : null;
    const effectiveTotalEur = subscriptionAllocEur == null ? null : r.marginalEur + subscriptionAllocEur;
    const effectiveCostPerMinute =
      effectiveTotalEur != null && r.durationSec ? effectiveTotalEur / (r.durationSec / 60) : null;
    return { ...r, subscriptionAllocEur, effectiveTotalEur, effectiveCostPerMinute };
  });

  // ── Reconciling period totals (all on the same period.startIso clock) ──
  const fixedThisPeriodEur = subscriptions.reduce((s, x) => s + (x.configured ? x.monthlyEur : 0), 0);
  const overageThisPeriodEur = subscriptions.reduce((s, x) => s + (x.configured ? x.overageEur : 0), 0);

  // Variable = payg € this period (subs excluded by classification) + subscription overage.
  const variablePaygEur = monthlySpendByProvider(periodStartIso, period.endIso).reduce(
    (s, r) => s + (providerBillingMode(r.provider) === "payg" ? r.amountEur : 0),
    0
  );
  const variableThisPeriodEur = variablePaygEur + overageThisPeriodEur;
  const totalThisPeriodEur = fixedThisPeriodEur + variableThisPeriodEur;

  // Secondary stats: all-time payg (context) + blended €/min this period (average, incl. overhead).
  const allTimePaygEur = spendByProvider().reduce(
    (s, r) => s + (providerBillingMode(r.provider) === "payg" ? r.amountEur : 0),
    0
  );

  /**
   * Spend the per-run table can never account for: ledger rows whose run was HARD
   * deleted. The runs are gone, the costs remain (correctly — the money was spent), so
   * the all-time card summed 66 rows the table cannot show and quietly disagreed with
   * it by €0.24. Publishing the difference is what makes the two reconcile:
   *   allTimePayg = Σ visible rows + orphaned
   */
  const attributedPaygEur = runs.reduce((s, r) => s + r.marginalEur, 0);
  const orphanedPaygEur = Math.max(0, allTimePaygEur - attributedPaygEur);

  /** Providers with recorded usage but no configured rate — every € here is a floor. */
  const unpricedProviders = [...new Set(runs.flatMap((r) => r.unpricedProviders))].sort();
  /** Runs that predate cost tracking: shown as "—", and counted so the gap is visible. */
  const untrackedRuns = runs.filter((r) => !r.tracked).length;

  const thisPeriodMinutes = (periodMinutesStmt.get(periodStartDay, period.endIso.slice(0, 10)) as { sec: number }).sec / 60;
  const blendedEurPerMin = thisPeriodMinutes > 0 ? totalThisPeriodEur / thisPeriodMinutes : null;

  const overview = {
    fixedThisPeriodEur,
    variableThisPeriodEur,
    variablePaygEur,
    overageThisPeriodEur,
    totalThisPeriodEur,
    allTimePaygEur,
    attributedPaygEur,
    orphanedPaygEur,
    blendedEurPerMin,
    thisPeriodMinutes,
    unpricedProviders,
    untrackedRuns,
    totalRuns: runs.length,
  };

  const billing = {
    fxUsdToEur: fx,
    cycleStartDay: period.startDay,
    providers: providers.map((p) => ({
      id: p.id,
      label: p.label,
      billingType: p.billingType,
      active: p.active,
      // payg/free are always "ready"; subscription providers need a saved plan.
      configured: p.billingType === "subscription" ? Boolean(profiles[p.id]?.plan) : true,
      plan: profiles[p.id]?.plan ?? null,
    })),
    subscriptions,
    subMeta: SUB_META, // plan catalog for the setup dropdown
    profiles, // current saved profiles (prefill the setup form)
  };

  return NextResponse.json({ period, overview, runs: runsWithEffective, billing });
}

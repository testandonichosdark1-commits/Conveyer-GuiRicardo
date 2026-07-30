import { NextResponse } from "next/server";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
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
  heygenSecondsToCredits,
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
 * Subscription providers (ElevenLabs/HeyGen) never contribute an amortized per-unit € —
 * their `run_costs.amount_eur` is ignored on read (only their usage feeds the quota view);
 * their cost is the flat monthly plan fee (+ overage). Every per-run number is the run's
 * MARGINAL (added) cost = its pay-as-you-go € only. `providerBillingMode()` is the single
 * classifier that decides payg-vs-subscription everywhere below.
 */
const listRuns = db.prepare(
  `SELECT id, title, status, created_at, duration_sec
   FROM runs ORDER BY created_at DESC LIMIT 200`
);

interface RunRow {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  duration_sec: number | null;
}

export async function GET() {
  ensureInit();

  const fx = Number(getSetting("COST_USD_TO_EUR")) || 0.92;
  const flash = elevenlabsIsFlash();
  const heygenCreditsPerMin = SUB_META.heygen.creditsPerMinute ?? 20;

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
  const aiPaygByRun = new Map<string, number>(); // payg AI b-roll € (kie + 69labs)
  const elevenCharsByRun = new Map<string, number>();
  const heygenSecByRun = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const row of spendByRunProvider()) {
    const mode = providerBillingMode(row.provider);
    if (mode === "payg") {
      add(marginalByRun, row.runId, row.amountEur);
      if (providerBase(row.provider) === "gemini") add(geminiByRun, row.runId, row.amountEur);
      else add(aiPaygByRun, row.runId, row.amountEur);
    } else if (mode === "subscription") {
      const base = providerBase(row.provider);
      if (base === "elevenlabs") add(elevenCharsByRun, row.runId, row.units);
      else if (base === "heygen") add(heygenSecByRun, row.runId, row.units);
    }
  }

  const rows = listRuns.all() as RunRow[];

  const runs = rows.map((r) => {
    const durationSec = typeof r.duration_sec === "number" && r.duration_sec > 0 ? r.duration_sec : null;
    const marginalEur = marginalByRun.get(r.id) ?? 0;
    const geminiEur = geminiByRun.get(r.id) ?? 0;
    const aiPaygEur = aiPaygByRun.get(r.id) ?? 0;
    return {
      runId: r.id,
      title: r.title || r.id.slice(0, 8),
      status: r.status,
      createdAt: r.created_at,
      durationSec,
      marginalEur,
      geminiEur,
      aiPaygEur,
      elevenlabsCredits: elevenlabsCharsToCredits(elevenCharsByRun.get(r.id) ?? 0, flash),
      heygenCredits: heygenSecondsToCredits(heygenSecByRun.get(r.id) ?? 0, heygenCreditsPerMin),
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
  const heygenSeconds = sumUnits("heygen");

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
  const subscriptions: SubEntry[] = (["elevenlabs", "heygen"] as SubProviderId[])
    .filter((id) => providers.find((p) => p.id === id)?.active)
    .map((id): SubEntry => {
      const prof = profiles[id];
      const configured = Boolean(prof?.plan); // a plan (or "Custom") has been chosen
      if (configured) {
        const usedCredits =
          id === "elevenlabs"
            ? elevenlabsCharsToCredits(elevenlabsChars, flash)
            : heygenSecondsToCredits(heygenSeconds, heygenCreditsPerMin);
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
    for (const [id, credits] of [["elevenlabs", r.elevenlabsCredits], ["heygen", r.heygenCredits]] as const) {
      if (credits <= 0) continue; // this run didn't use that subscription provider
      const plan = allocPlan[id];
      const part = plan ? effectiveAllocationEur(credits, plan.monthlyEur, plan.quotaCredits) : null;
      if (part == null) estimable = false; // used a provider with unknown quota → not fully allocatable
      else alloc += part;
    }
    const subscriptionAllocEur = estimable ? alloc : null;
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
  let thisPeriodMinutes = 0;
  for (const r of runs) {
    if (r.durationSec && (r.createdAt || "").slice(0, 10) >= periodStartDay) thisPeriodMinutes += r.durationSec / 60;
  }
  const blendedEurPerMin = thisPeriodMinutes > 0 ? totalThisPeriodEur / thisPeriodMinutes : null;

  const overview = {
    fixedThisPeriodEur,
    variableThisPeriodEur,
    variablePaygEur,
    overageThisPeriodEur,
    totalThisPeriodEur,
    allTimePaygEur,
    blendedEurPerMin,
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

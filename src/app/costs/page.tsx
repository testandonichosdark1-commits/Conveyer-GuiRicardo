"use client";
import { useEffect, useMemo, useState, useRef } from "react";

/** Shape returned by GET /api/costs. */
interface CostRun {
  runId: string;
  title: string;
  status: string;
  createdAt: string;
  durationSec: number | null;
  marginalEur: number; // added (pay-as-you-go) cost of this run
  geminiEur: number;
  aiPaygEur: number; // AI b-roll only (kie / 69labs / magnific / higgsfield / runware)
  voiceEur: number; // narration + transcription (was silently inside aiPaygEur)
  elevenlabsCredits: number; // subscription usage — NOT billed per video
  heygenEur: number;
  costPerMinute: number | null; // marginal ÷ min
  /** false = this run predates cost tracking. Its cost is UNKNOWN, not €0.00. */
  tracked: boolean;
  /** Soft-deleted: kept for accounting, but its detail page is gone. */
  deleted: boolean;
  /** Providers it used whose rate is unset → its € is a floor, not a total. */
  unpricedProviders: string[];
  // Effective subscription allocation (2nd reporting layer — mgmt metric, not an invoice).
  // null when a used subscription provider's quota is unknown/unlimited/unconfigured → show "—".
  subscriptionAllocEur: number | null; // pro-rata share of the monthly plan fee for this run
  effectiveTotalEur: number | null; // marginal + subscription allocation
  effectiveCostPerMinute: number | null; // effective total ÷ min
}
interface Overview {
  fixedThisPeriodEur: number;
  variableThisPeriodEur: number;
  variablePaygEur: number;
  overageThisPeriodEur: number;
  totalThisPeriodEur: number;
  allTimePaygEur: number;
  attributedPaygEur: number;
  orphanedPaygEur: number;
  blendedEurPerMin: number | null;
  thisPeriodMinutes: number;
  unpricedProviders: string[];
  untrackedRuns: number;
  totalRuns: number;
}
interface Period {
  startIso: string;
  label: string;
  startDay: number;
}

// ── Billing block (interpret usage through each provider's real billing model) ──
type BillingType = "subscription" | "payg" | "free";
interface BillingProviderView {
  id: string;
  label: string;
  billingType: BillingType;
  active: boolean;
  configured: boolean;
  plan: string | null;
}
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
interface SubPlan {
  id: string;
  monthlyUsd: number;
  quotaCredits: number;
}
interface SubMetaEntry {
  quotaLabel: string;
  plans: SubPlan[];
  overageUsdPerCredit: number;
}
interface BillingProfile {
  mode: "payg" | "subscription";
  plan?: string;
  monthlyUsd?: number;
  quotaCredits?: number;
}
interface Billing {
  fxUsdToEur: number;
  providers: BillingProviderView[];
  subscriptions: SubEntry[];
  subMeta: Record<string, SubMetaEntry>;
  profiles: Record<string, BillingProfile>;
}

// EUR formatting. Cards (sums) use 2 decimals; per-bucket cells can be sub-cent,
// so eurFine keeps 4 decimals under €0.01 instead of misreporting a real cost as €0.00.
const eur = (v: number | null | undefined) => "€" + (v ?? 0).toFixed(2);
const eurFine = (v: number | null | undefined) => {
  const n = v ?? 0;
  if (n === 0) return "€0.00";
  return "€" + (n >= 0.01 ? n.toFixed(2) : n.toFixed(4));
};
const fmtInt = (v: number) => Math.round(v).toLocaleString("en-US");
// Credits are an estimated conversion from recorded usage — mark them ≈ so they never read as exact.
const fmtCredits = (v: number) => (v > 0 ? `≈${fmtInt(v)} cr` : "—");

/**
 * A euro cell for one run.
 *
 * An UNTRACKED run (no ledger rows at all — it predates cost tracking) renders "—",
 * never €0.00. The two are completely different claims, and the page used to make the
 * confident one for 112 of 219 runs.
 */
const cell = (r: { tracked: boolean }, v: number) => (r.tracked ? eurFine(v) : "—");

/** Tooltip for a run whose total is held down by a provider with no rate configured. */
const floorNote = (r: { tracked: boolean; unpricedProviders: string[] }) =>
  !r.tracked
    ? "No costs were recorded for this run — its cost is unknown, not zero."
    : r.unpricedProviders.length > 0
      ? `At least a floor: ${r.unpricedProviders.join(", ")} ${r.unpricedProviders.length === 1 ? "has" : "have"} no rate configured, so their usage is valued at €0.00.`
      : "Marginal cost — the real EXTRA money this video added (pay-as-you-go providers only).";

// runs.created_at is sqlite "YYYY-MM-DD HH:MM:SS" (UTC, no Z). Format the date
// part directly to DD.MM.YYYY to avoid browser timezone-parsing quirks.
const fmtDate = (iso: string) => {
  const d = (iso || "").slice(0, 10).split("-");
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : iso;
};
const fmtDuration = (sec: number | null) => {
  if (!sec || sec <= 0) return "—";
  const s = Math.round(sec);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const statusTag = (s: string) =>
  ["pending", "running", "done", "error", "cancelled"].includes(s) ? `tag-${s}` : "tag-pending";

type ProviderFilter = "all" | "elevenlabs" | "gemini" | "ai" | "voice" | "heygen";

export default function CostsPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [runs, setRuns] = useState<CostRun[]>([]);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Filters
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [provider, setProvider] = useState<ProviderFilter>("all");

  // Editable draft of the billing profiles (the setup panel). null until first load;
  // we do NOT overwrite it on every 5s poll so the user's in-progress edits survive.
  const [draft, setDraft] = useState<Record<string, BillingProfile> | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  function applyPayload(j: { period?: Period; overview: Overview; runs: CostRun[]; billing?: Billing }) {
    if (j.period) setPeriod(j.period);
    setOverview(j.overview);
    setRuns(Array.isArray(j.runs) ? j.runs : []);
    if (j.billing) setBilling(j.billing);
  }

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await fetch("/api/costs");
        if (!alive) return;
        const j = (await r.json()) as { period?: Period; overview: Overview; runs: CostRun[]; billing?: Billing };
        applyPayload(j);
        // Seed the editable draft once; don't clobber in-progress edits.
        if (j.billing) setDraft((d) => d ?? { ...(j.billing!.profiles || {}) });
      } catch {
        /* keep last good data */
      } finally {
        if (alive) setLoaded(true);
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return runs.filter((r) => {
      if (q && !r.title.toLowerCase().includes(q)) return false;
      const day = (r.createdAt || "").slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (provider === "elevenlabs" && r.elevenlabsCredits <= 0) return false;
      if (provider === "gemini" && r.geminiEur <= 0) return false;
      if (provider === "ai" && r.aiPaygEur <= 0) return false;
      if (provider === "voice" && r.voiceEur <= 0) return false;
      if (provider === "heygen" && r.heygenEur <= 0) return false;
      return true;
    });
  }, [runs, search, from, to, provider]);

  // Primary reconciling cards (all this period): Total = Fixed + Variable.
  const cards: { label: string; value: string; hint?: string }[] = [
    { label: "Fixed subscriptions / mo", value: eur(overview?.fixedThisPeriodEur), hint: "Your recurring monthly fees" },
    { label: "Variable spend (this period)", value: eur(overview?.variableThisPeriodEur), hint: "Pay-as-you-go usage + overage" },
    { label: "Total this period", value: eur(overview?.totalThisPeriodEur), hint: "= Fixed + Variable" },
  ];

  // Subscription providers that are active (have an API key) — drive the setup panel.
  const subProviders = useMemo(
    () => (billing?.providers || []).filter((p) => p.billingType === "subscription" && p.active),
    [billing]
  );
  const paygProviders = useMemo(
    () => (billing?.providers || []).filter((p) => p.billingType !== "subscription" && p.active),
    [billing]
  );
  // Quota cards: only subscription providers the user has configured with a plan.
  const quotaCards = useMemo(
    () => (billing?.subscriptions || []).filter((s) => s.configured),
    [billing]
  );

  function updateDraft(id: string, patch: Partial<BillingProfile> | null) {
    setDraft((d) => {
      const next = { ...(d || {}) };
      if (patch === null) delete next[id];
      else next[id] = { ...(next[id] || { mode: "subscription" }), ...patch } as BillingProfile;
      return next;
    });
  }

  async function saveProfiles() {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ BILLING_PROFILES: JSON.stringify(draft) }),
      });
      if (r.ok) {
        setSavedAt(Date.now());
        // Refresh immediately so the quota bars + totals reflect the new plan.
        const jr = await fetch("/api/costs");
        applyPayload((await jr.json()) as { period?: Period; overview: Overview; runs: CostRun[]; billing?: Billing });
      }
    } catch {
      /* leave the draft as-is so the user can retry */
    } finally {
      setSaving(false);
    }
  }

  const dirty = useMemo(() => {
    if (!billing || !draft) return false;
    return JSON.stringify(draft) !== JSON.stringify(billing.profiles || {});
  }, [billing, draft]);

  // ── Table UX (desktop-only, gated by CSS ≥768px): the whole table scrolls as one
  // piece. A horizontal scrollbar is pinned to the BOTTOM of the viewport so it's
  // reachable from any vertical position, and the table can be dragged (grab & pan)
  // from anywhere. Trackpad/Shift-wheel work natively. No data changes. ──
  const barRef = useRef<HTMLDivElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [scrollW, setScrollW] = useState(0); // full table width → bottom scrollbar spacer
  const [overflowing, setOverflowing] = useState(false); // hide the bar when nothing to scroll
  const scrollLock = useRef(false);

  // Collapsible advanced cost columns — the detailed provider breakdown (ElevenLabs,
  // HeyGen, Gemini, AI b-roll, Added, Added/Min) is hidden by default; the user expands
  // it on demand. Choice persisted in localStorage. Presentation only — every value,
  // calculation, sort and filter is untouched; this just toggles which cells render.
  const [showBreakdown, setShowBreakdown] = useState(false);
  useEffect(() => {
    try {
      // Don't default to the wide 13-column breakdown on phones — it forces a
      // 1120px-min table into a lot of side-scroll. Desktop/tablet honor the pref.
      const isPhone = window.matchMedia("(max-width: 767px)").matches;
      if (localStorage.getItem("costsShowBreakdown") === "1" && !isPhone) setShowBreakdown(true);
    } catch {}
  }, []);
  const toggleBreakdown = () =>
    setShowBreakdown((s) => {
      const next = !s;
      try {
        localStorage.setItem("costsShowBreakdown", next ? "1" : "0");
      } catch {}
      return next;
    });

  useEffect(() => {
    const measure = () => {
      const el = tableScrollRef.current;
      if (!el) return;
      setScrollW(el.scrollWidth);
      setOverflowing(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const el = tableScrollRef.current;
    const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el!);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [filtered.length, loaded, showBreakdown]);

  // Mirror horizontal scroll between the bottom bar and the table. Trackpad / drag /
  // native scroll all fire the table's onScroll, so the bar follows automatically. The
  // lock swallows the echo event the programmatic scrollLeft assignment triggers.
  const syncScroll = (from: "bar" | "table") => (e: React.UIEvent<HTMLDivElement>) => {
    if (scrollLock.current) {
      scrollLock.current = false;
      return;
    }
    const target = from === "bar" ? tableScrollRef.current : barRef.current;
    if (!target) return;
    scrollLock.current = true;
    target.scrollLeft = e.currentTarget.scrollLeft;
  };

  // Drag-to-pan: grab the table anywhere and drag left/right. A 4px movement threshold
  // keeps plain clicks (the Title link) and text selection working; once past it we pan
  // and suppress the trailing click. mousemove is a native listener so we can
  // preventDefault (stop text selection) during the drag.
  const drag = useRef({ active: false, startX: 0, startLeft: 0, moved: false });
  const onDragDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = tableScrollRef.current;
    if (e.button !== 0 || !el) return;
    drag.current = { active: true, startX: e.clientX, startLeft: el.scrollLeft, moved: false };
  };
  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      if (!drag.current.active) return;
      const dx = e.clientX - drag.current.startX;
      if (!drag.current.moved && Math.abs(dx) > 4) {
        drag.current.moved = true;
        el.classList.add("costs-dragging");
      }
      if (drag.current.moved) {
        e.preventDefault();
        el.scrollLeft = drag.current.startLeft - dx;
      }
    };
    const onUp = () => {
      if (!drag.current.active) return;
      drag.current.active = false;
      el.classList.remove("costs-dragging");
      // leave `moved` set so the trailing click handler can cancel navigation/selection
    };
    const onClickCapture = (e: MouseEvent) => {
      if (drag.current.moved) {
        e.preventDefault();
        e.stopPropagation();
        drag.current.moved = false;
      }
    };
    window.addEventListener("mousemove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);
    el.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.removeEventListener("click", onClickCapture, true);
    };
  }, [loaded]);

  // Collapsed (7 columns at the normal ~942px page width): tighten horizontal padding,
  // header font and letter-spacing so every header stays on ONE line (nowrap) and the
  // table still fits with no horizontal scroll or clipped edge columns. Expanded keeps the
  // roomier spacing (it scrolls inside the wide breakout, so it doesn't need to be compact).
  const th: React.CSSProperties = {
    textAlign: "left",
    padding: showBreakdown ? "10px 12px" : "10px 7px",
    fontSize: showBreakdown ? 11 : 10,
    fontWeight: 700,
    letterSpacing: showBreakdown ? "0.04em" : "0.02em",
    textTransform: "uppercase",
    color: "var(--fg-faint)",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
  };
  const td: React.CSSProperties = {
    padding: showBreakdown ? "11px 12px" : "11px 7px",
    fontSize: 13,
    color: "var(--fg)",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
  };
  const numTd: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const subTd: React.CSSProperties = { ...numTd, color: "var(--fg-faint)" };

  return (
    <div>
      <h1>Costs</h1>

      {/* ── The standing disclaimer ──────────────────────────────────────────
          Deliberately the FIRST thing on the page, and deliberately loud.
          Almost every amount here is modelled, not observed: most providers do
          not return the cost of an individual call, so we multiply a published
          per-unit rate by what we metered. That is good enough to compare videos
          and spot trends, and NOT good enough to argue with an invoice. The page
          has to say so before it shows a single number — otherwise a euro sign
          and two decimal places imply a precision we do not have. */}
      <div
        className="card"
        style={{
          padding: "16px 18px",
          marginBottom: 16,
          border: "2px solid var(--danger, #e5484d)",
          background: "color-mix(in srgb, var(--danger, #e5484d) 8%, transparent)",
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 800,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            marginBottom: 8,
            color: "var(--fg)",
          }}
        >
          ⚠ Every figure on this page is an estimate
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--fg)" }}>
          Most providers do not expose the cost of an individual call through their API, so we cannot read
          back what you were actually charged. Every amount here is <strong>calculated</strong>{" — "}the metered
          usage multiplied by the published per-unit rate from that provider&apos;s own documentation, as
          configured in <a href="/full-settings">Settings → Cost Monitoring Rates</a>.
          <br />
          <br />
          That makes these numbers useful for comparing videos, spotting trends and catching runaway spend.
          It does{" "}<strong>not</strong>{" "}make them an invoice, and they will not match a provider&apos;s billing
          page to the cent. Where a rate has not been set at all, the amount is €0.00 and the page says so
          explicitly rather than pretending the usage was free.
          <br />
          <br />
          <strong>
            If a number here looks wrong, check the spend in that provider&apos;s own account — their figure
            is the authoritative one, not ours.
          </strong>
        </div>
      </div>
      <p className="muted" style={{ marginBottom: 6, fontSize: 14 }}>
        Spend interpreted through each provider&apos;s real billing model. Subscriptions (ElevenLabs) are a
        fixed monthly overhead + quota; pay-as-you-go providers (HeyGen, Gemini, kie.ai, …) are metered. A video&apos;s cost is
        its <strong>added</strong> (marginal) spend — pay-as-you-go usage only; subscription usage within quota adds nothing.
      </p>

      {/* Billing period banner */}
      <div className="card" style={{ padding: "10px 14px", marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-faint)" }}>
            Current billing period
          </span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{period?.label ?? "—"}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            — totals below cover this window; quota and pay-as-you-go reset on day {period?.startDay ?? 1} (UTC).
          </span>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          ⚠ Approximation: the window is anchored on the billing cycle start day (default 1 = calendar month; change it in{" "}
          <a href="/advanced">Advanced settings</a> → Cost Monitoring Rates). It may not exactly match your provider&apos;s
          real reset date, and ElevenLabs credit rollover is not modelled.
        </div>
      </div>

      {/* Billing setup — auto-detected providers; pick a plan for subscription ones */}
      <div className="card" style={{ padding: "16px 18px", marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Billing setup</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {savedAt > 0 && !dirty && <span className="muted" style={{ fontSize: 12 }}>Saved ✓</span>}
            <button
              className="btn"
              disabled={!dirty || saving}
              onClick={saveProfiles}
              style={{ opacity: !dirty || saving ? 0.45 : 1, cursor: !dirty || saving ? "default" : "pointer" }}
            >
              {saving ? "Saving…" : "Save billing"}
            </button>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0, marginBottom: 12 }}>
          Detected automatically from your configured API keys. Pick the subscription plan you&apos;re on for each
          subscription provider — nothing is estimated for it until you do. (ElevenLabs bills only by plan; there is no
          pay-as-you-go option. Plan prices/quotas are approximate list prices — use Custom for your exact figures.)
        </p>

        {!loaded ? (
          <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
        ) : subProviders.length === 0 && paygProviders.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            No cost-relevant providers detected. Add API keys in <a href="/full-settings">Settings</a>.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {subProviders.map((p) => {
              const meta = billing?.subMeta[p.id];
              const prof = draft?.[p.id];
              const plan = prof?.plan ?? ""; // "" = not set up
              const isCustom = plan === "Custom";
              return (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                  }}
                >
                  <div style={{ minWidth: 130, fontWeight: 600, fontSize: 14 }}>
                    {p.label}
                    <span className="muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      subscription
                    </span>
                  </div>

                  {meta && (
                    <select
                      className="input"
                      style={{ width: "auto", minWidth: 220 }}
                      value={plan}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "") updateDraft(p.id, null);
                        else updateDraft(p.id, { mode: "subscription", plan: v });
                      }}
                    >
                      <option value="">— Not set up —</option>
                      {meta.plans.map((pl) => (
                        <option key={pl.id} value={pl.id}>
                          {pl.id} — ${pl.monthlyUsd}/mo · {fmtInt(pl.quotaCredits)} {meta.quotaLabel}
                        </option>
                      ))}
                      <option value="Custom">Custom…</option>
                    </select>
                  )}

                  {isCustom && meta && (
                    <>
                      <label className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                        $/mo
                        <input
                          className="input"
                          type="number"
                          min={0}
                          step={1}
                          style={{ width: 90 }}
                          value={prof?.monthlyUsd ?? ""}
                          onChange={(e) => updateDraft(p.id, { monthlyUsd: e.target.value === "" ? undefined : Number(e.target.value) })}
                        />
                      </label>
                      <label className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                        {meta.quotaLabel}/mo
                        <input
                          className="input"
                          type="number"
                          min={0}
                          step={1000}
                          style={{ width: 120 }}
                          value={prof?.quotaCredits ?? ""}
                          onChange={(e) => updateDraft(p.id, { quotaCredits: e.target.value === "" ? undefined : Number(e.target.value) })}
                        />
                      </label>
                    </>
                  )}

                  {plan === "" && (
                    <span className="tag" style={{ fontSize: 11, background: "var(--warn-bg, #7c5b00)", color: "#fff" }}>
                      Set up your plan
                    </span>
                  )}
                </div>
              );
            })}

            {paygProviders.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 2 }}>
                <span className="muted" style={{ fontSize: 12, marginRight: 4 }}>Pay-as-you-go (metered automatically):</span>
                {paygProviders.map((p) => (
                  <span key={p.id} className="tag" style={{ fontSize: 11 }}>
                    {p.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Overview — primary reconciling cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 10,
          marginBottom: 10,
        }}
      >
        {cards.map((c) => (
          <div key={c.label} className="card" style={{ padding: "14px 16px" }}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.07em",
                textTransform: "uppercase",
                color: "var(--fg-faint)",
                marginBottom: 7,
              }}
            >
              {c.label}
            </div>
            <div style={{ fontSize: 23, fontWeight: 700, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
              {c.value}
            </div>
            {c.hint && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{c.hint}</div>}
          </div>
        ))}
      </div>

      {/* Secondary stats */}
      <div className="muted" style={{ fontSize: 12, marginBottom: 18, display: "flex", flexWrap: "wrap", gap: 16 }}>
        <span>
          All-time pay-as-you-go: <strong style={{ color: "var(--fg)" }}>{eur(overview?.allTimePaygEur)}</strong>
        </span>
        <span title="Total cost this billing period ÷ total generated video minutes (includes subscription fees). Not a per-minute price you are charged.">
          Effective cost / generated minute:{" "}
          <strong style={{ color: "var(--fg)" }}>{overview?.blendedEurPerMin != null ? eur(overview.blendedEurPerMin) : "—"}</strong>
          {overview != null && overview.thisPeriodMinutes > 0 && (
            <span style={{ opacity: 0.8 }}> ({overview.thisPeriodMinutes.toFixed(1)} min)</span>
          )}
        </span>
        {/* Reconciliation: the all-time card sums the whole ledger, but the table can only
            show runs that still exist. Publishing the difference is what makes the two
            agree instead of quietly disagreeing by the cost of hard-deleted runs. */}
        {overview != null && overview.orphanedPaygEur > 0.0001 && (
          <span title="Cost rows whose run was permanently deleted. The money was spent, so it stays in the all-time total, but no row below can show it.">
            of which not attributable to any run:{" "}
            <strong style={{ color: "var(--fg)" }}>{eur(overview.orphanedPaygEur)}</strong>
          </span>
        )}
      </div>

      {/* ── Honesty markers ──────────────────────────────────────────────────
          Two things could make every euro on this page an understatement, and
          neither was visible before: a provider with usage but no configured rate
          (its spend silently counts as €0.00), and runs that predate cost tracking
          (their unknown cost rendered as a confident €0.00). Both are stated here
          rather than left for the reader to infer from suspiciously round numbers. */}
      {overview != null && overview.unpricedProviders.length > 0 && (
        <div
          className="card"
          style={{ padding: "11px 14px", marginBottom: 12, borderColor: "var(--danger, #e5484d)" }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>
            ⚠ {overview.unpricedProviders.length} provider{overview.unpricedProviders.length === 1 ? " has" : "s have"} recorded usage but no price set
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            <strong>{overview.unpricedProviders.join(", ")}</strong> — their usage is counted but valued at
            €0.00, so every total below is a <strong>floor, not a total</strong>. Set their rates in{" "}
            <a href="/full-settings">Settings → Cost Monitoring Rates</a>; already-recorded spend reprices
            immediately.
          </div>
        </div>
      )}
      {overview != null && overview.untrackedRuns > 0 && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 18 }}>
          {overview.untrackedRuns} of {overview.totalRuns} runs have no recorded costs (they predate cost
          tracking, or used providers that were not metered at the time). They show <strong>—</strong> below
          rather than €0.00 — their cost is unknown, not zero.
        </div>
      )}

      {/* Subscription quota bars — one per configured subscription provider */}
      {quotaCards.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 10,
            marginBottom: 18,
          }}
        >
          {quotaCards.map((s) => {
            const creditNote = "≈ estimated credits — 1 credit ≈ 1 character (0.5 for Flash/Turbo)";
            return (
              <div key={s.id} className="card" style={{ padding: "14px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{s.label}</div>
                  <div
                    className="muted"
                    style={{ fontSize: 12 }}
                    title="Converted from the plan's USD price at your current USD→EUR rate (Advanced settings). Not a different price."
                  >
                    {s.plan} · ≈{eur(s.monthlyEur)}/mo
                  </div>
                </div>

                {s.quotaKnown ? (
                  <>
                    <div style={{ height: 8, borderRadius: 999, background: "var(--border)", overflow: "hidden", marginBottom: 6 }}>
                      <div
                        style={{
                          width: `${Math.min(100, s.pct)}%`,
                          height: "100%",
                          borderRadius: 999,
                          background: s.pct > 100 ? "var(--danger, #e5484d)" : s.pct > 85 ? "#e5a000" : "var(--accent, #3b82f6)",
                          transition: "width 240ms ease",
                        }}
                      />
                    </div>
                    <div className="muted" style={{ fontSize: 12, display: "flex", justifyContent: "space-between" }}>
                      <span>
                        ≈{fmtInt(s.usedCredits)} / {fmtInt(s.quotaCredits)} {s.quotaLabel} this period
                      </span>
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>≈{Math.round(s.pct)}%</span>
                    </div>
                    {s.overageEur > 0 && (
                      <div style={{ fontSize: 12, marginTop: 6, color: "var(--danger, #e5484d)", fontWeight: 600 }}>
                        Over quota — est. overage {eur(s.overageEur)} (counts toward Variable spend)
                      </div>
                    )}
                  </>
                ) : (
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    ≈{fmtInt(s.usedCredits)} {s.quotaLabel} used this period · no quota set — usage not capped (no overage tracked).
                    Add a quota in Billing setup to see a usage bar.
                  </div>
                )}
                <div className="muted" style={{ fontSize: 11, marginTop: 6, opacity: 0.85 }}>{creditNote}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Filters */}
      <div
        className="card costs-filters"
        style={{
          display: "grid",
          gap: 12,
          marginBottom: 16,
          alignItems: "end",
        }}
      >
        <div>
          <label className="label">Search title</label>
          <input className="input" placeholder="Search by video title…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div>
          <label className="label">From</label>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">To</label>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label className="label">Provider</label>
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as ProviderFilter)}>
            <option value="all">All</option>
            <option value="elevenlabs">ElevenLabs</option>
            <option value="gemini">Gemini</option>
            <option value="ai">AI b-roll</option>
            <option value="voice">Voice</option>
            <option value="heygen">HeyGen</option>
          </select>
        </div>
      </div>

      {/* Runs table */}
      <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Per-video <strong>added</strong> cost — pay-as-you-go usage only. The ElevenLabs column shows
        <em> ≈ estimated quota credits</em> consumed, not euros: that usage is covered by your flat monthly plan above,
        not billed per video (credit conversions are approximate — see the notes on the quota cards). HeyGen is
        pay-as-you-go, so its column is real metered spend and is included in Added. HeyGen + Voice + Gemini + AI b-roll
        add up to Added exactly. Every figure is modelled from the rates in Settings, not read back from a provider
        invoice — a <strong style={{ color: "var(--danger, #e5484d)" }}>+</strong> marks a total held down by a provider
        with no rate set, and <strong>—</strong> means no cost was recorded at all.
        <br />
        <strong>Estimated video cost</strong> = Added cost + allocated share of your monthly subscription.
        This is a management estimate, not your provider&rsquo;s invoice.
      </p>
      {/* Disclosure — reveal/hide the detailed per-provider breakdown columns (default hidden). */}
      <button
        type="button"
        onClick={toggleBreakdown}
        className="btn-secondary"
        aria-expanded={showBreakdown}
        title={showBreakdown ? "Hide the detailed provider columns" : "Show ElevenLabs, HeyGen, Gemini, AI b-roll, Added and Added / Min"}
        style={{ marginBottom: 10, fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer" }}
      >
        <span aria-hidden="true" style={{ fontSize: 10, transition: "transform 160ms ease", transform: showBreakdown ? "rotate(90deg)" : "none" }}>▶</span>
        {showBreakdown ? "Hide cost breakdown" : "Show cost breakdown"}
      </button>
      {/* When the breakdown is EXPANDED the table breaks out wider than the 1000px
          dashboard container (desktop only, centered) so the extra columns are visible;
          when COLLAPSED the few columns fit the normal page width, so we drop the
          breakout wrapper (and the 1120px min) to avoid excess empty space / stretching.
          Same wrapper, reused — only its width switches with showBreakdown. */}
      <div className={showBreakdown ? "costs-table-wide" : undefined}>
      <div
        ref={tableScrollRef}
        className="card costs-scroll-host"
        style={{ padding: 0, overflowX: "auto" }}
        onScroll={syncScroll("table")}
        onMouseDown={onDragDown}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: showBreakdown ? 1120 : undefined }}>
          <thead>
            <tr>
              {/* Video */}
              <th style={th}>Date</th>
              <th style={th}>Title</th>
              <th style={th}>Status</th>
              <th style={{ ...th, textAlign: "right" }}>Duration</th>
              {/* Usage + Pay-as-you-go breakdown — hidden by default (toggle above) */}
              {showBreakdown && (
                <>
                  <th className="costs-group-sep" style={{ ...th, textAlign: "right" }}>ElevenLabs</th>
                  <th className="costs-group-sep" style={{ ...th, textAlign: "right" }} title="HeyGen API spend for this video — pay-as-you-go, billed per second of avatar clip. Counts toward Added.">HeyGen</th>
                  <th style={{ ...th, textAlign: "right" }} title="Narration and transcription spend (Groq, Fish Audio, Hume, AI84, OpenAI, MiniMax, GenAIPro). Previously added into the AI b-roll column, which made footage look more expensive than it was.">Voice</th>
                  <th style={{ ...th, textAlign: "right" }}>Gemini</th>
                  <th style={{ ...th, textAlign: "right" }} title="AI-generated footage only (kie.ai, 69labs, Magnific, Higgsfield, Runware).">AI b-roll</th>
                  <th style={{ ...th, textAlign: "right" }} title="Marginal cost — the real EXTRA money this video added (pay-as-you-go providers only). €0 for work covered by an already-paid subscription quota.">Added</th>
                  <th style={{ ...th, textAlign: "right" }}>Added / Min</th>
                </>
              )}
              {/* Management */}
              <th className="costs-group-sep" style={{ ...th, textAlign: "right" }} title="Estimated share of your monthly subscription allocated to this video based on actual credit usage.">Subscription share</th>
              <th style={{ ...th, textAlign: "right" }} title="Added cost plus the allocated share of your monthly subscription.">Estimated video cost</th>
              <th style={{ ...th, textAlign: "right" }} title="Estimated video cost divided by the generated video duration.">Estimated cost / min</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.runId} className="hover-row">
                {/* Video */}
                <td style={td}>{fmtDate(r.createdAt)}</td>
                <td style={{ ...td, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {/* A deleted run keeps its costs (the money was spent) but its detail page
                      is gone. Marked, not hidden — an unexplained dead link reads as a bug. */}
                  {r.deleted ? (
                    <span style={{ color: "var(--fg-faint)" }} title="This run was deleted. Its costs are kept so the totals stay accurate, but its detail page no longer exists.">
                      {r.title} <span style={{ fontSize: 11 }}>(deleted)</span>
                    </span>
                  ) : (
                    <a href={`/runs/${r.runId}`} style={{ color: "var(--fg)", textDecoration: "none" }}>
                      {r.title}
                    </a>
                  )}
                </td>
                <td style={td}>
                  <span className={`tag ${statusTag(r.status)}`}>{r.status}</span>
                </td>
                <td style={numTd}>{fmtDuration(r.durationSec)}</td>
                {/* Usage + Pay-as-you-go breakdown — hidden by default (toggle above) */}
                {showBreakdown && (
                  <>
                    <td className="costs-group-sep" style={subTd} title="Subscription usage — covered by your plan, not billed per video">
                      {fmtCredits(r.elevenlabsCredits)}
                    </td>
                    <td className="costs-group-sep" style={numTd}>{cell(r, r.heygenEur)}</td>
                    <td style={numTd}>{cell(r, r.voiceEur)}</td>
                    <td style={numTd}>{cell(r, r.geminiEur)}</td>
                    <td style={numTd}>{cell(r, r.aiPaygEur)}</td>
                    <td style={{ ...numTd, fontWeight: 700 }} title={floorNote(r)}>
                      {cell(r, r.marginalEur)}
                      {r.tracked && r.unpricedProviders.length > 0 && <span style={{ color: "var(--danger, #e5484d)" }}>+</span>}
                    </td>
                    <td style={numTd}>{r.tracked && r.costPerMinute != null ? `${eurFine(r.costPerMinute)}/min` : "—"}</td>
                  </>
                )}
                {/* Management */}
                <td className="costs-group-sep" style={subTd} title="Pro-rata share of your monthly subscription fee for this video's usage (management metric, not an invoice). “—” means there is no figure — either this video used no subscription provider, or no plan is configured.">
                  {r.subscriptionAllocEur != null ? eurFine(r.subscriptionAllocEur) : "—"}
                </td>
                <td style={{ ...numTd, fontWeight: 700 }} title={floorNote(r)}>
                  {r.effectiveTotalEur != null ? eurFine(r.effectiveTotalEur) : "—"}
                  {r.tracked && r.effectiveTotalEur != null && r.unpricedProviders.length > 0 && (
                    <span style={{ color: "var(--danger, #e5484d)" }}>+</span>
                  )}
                </td>
                <td style={numTd}>{r.effectiveCostPerMinute != null ? `${eurFine(r.effectiveCostPerMinute)}/min` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {loaded && filtered.length === 0 && (
          <div style={{ padding: "26px 16px", textAlign: "center" }} className="muted">
            {runs.length === 0 ? "No runs with tracked costs yet." : "No runs match these filters."}
          </div>
        )}
      </div>
      {/* Always-reachable horizontal scrollbar: pinned to the viewport bottom (desktop
          only; hidden on mobile and when the table already fits) and synced to the table. */}
      <div
        ref={barRef}
        className="costs-hscroll"
        onScroll={syncScroll("bar")}
        aria-hidden="true"
        style={{ display: overflowing ? undefined : "none" }}
      >
        <div style={{ width: scrollW || undefined }} />
      </div>
      </div>
    </div>
  );
}

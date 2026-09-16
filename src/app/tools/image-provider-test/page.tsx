"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Retry = {
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  status?: number;
  code?: number;
  message: string;
  profileId?: string;
  profileLabel?: string;
  atMs?: number;
};

type ProfileFailover = {
  fromProfileId: string;
  fromProfileLabel: string;
  toProfileId: string;
  toProfileLabel: string;
  status?: number;
  code?: number;
  message: string;
  atMs?: number;
};

type ProfileSummary = {
  id: string;
  label: string;
  slot: number;
  accountHint: string;
};

type TestResult = {
  ok: boolean;
  mode: "real" | "simulation";
  simulation?: string;
  threshold: number;
  aspectRatio?: string;
  model?: string;
  totalElapsedMs?: number;
  configuredProfiles?: ProfileSummary[];
  cloudflare: {
    success: boolean;
    elapsedMs?: number;
    retries?: Retry[] | string[];
    failovers?: ProfileFailover[];
    profileId?: string;
    profileLabel?: string;
    dailyQuotaExhausted?: boolean;
    imageDataUrl?: string;
    score?: number | null;
    scoreModel?: string;
    scoreError?: string;
    passed?: boolean | null;
    status?: number;
    code?: number;
    message?: string;
  };
  fallback: {
    wouldUseKie: boolean;
    called: boolean;
    elapsedMs?: number;
    imageDataUrl?: string;
    score?: number | null;
    scoreModel?: string;
    scoreError?: string;
    error?: string;
  };
  action: string;
  externalCalls: {
    cloudflare: boolean;
    gemini: boolean;
    kie: boolean;
    ai33: boolean;
    groq: boolean;
  };
};

type HistoryEntry = {
  id: string;
  at: string;
  status: string;
  cloudflare: string;
  score: string;
  fallback: string;
  elapsed: string;
};

const DEFAULT_PROMPT = `Close-up of a human finger pressing a modern light switch on the wall of a hotel room, realistic everyday environment, the switch plate slightly worn from frequent use, natural hand position, believable hotel interior softly visible in the background.\n\nCandid amateur YouTube vlog video still, raw handheld smartphone footage, natural indoor lighting, authentic domestic or hotel environment, slight motion blur, 2010s home video snapshot, unedited, realistic and human.\n\nThe image should feel like a real frame casually captured on a phone camera, not a polished advertisement or studio photo. Prioritize believable imperfection, natural composition, soft realism, everyday authenticity, and practical real-world environments.\n\nUse soft natural light, subtle depth of field, and imperfect real-world framing.\n\nAvoid glossy commercial photography, cinematic lighting, heavy stylization, overdesigned sets, hyper-polished beauty, dramatic color grading, cartoon looks, artificial perfection, or stock-photo energy.`;

const card: React.CSSProperties = {
  background: "var(--surface-1)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 18,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 700,
  color: "var(--fg-muted)",
  marginBottom: 7,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-deep)",
  color: "var(--fg)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  padding: "9px 10px",
  fontSize: 13,
  outline: "none",
};

function fmtMs(ms?: number) {
  if (ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function historyFromResult(result: TestResult): HistoryEntry {
  const score = result.cloudflare.score;
  const code = result.cloudflare.code;
  const status = result.cloudflare.status;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toLocaleTimeString(),
    status: result.mode === "simulation" ? `SIM ${result.simulation}` : result.cloudflare.success ? "SUCCESS" : "FAILED",
    cloudflare: result.cloudflare.success ? "OK" : `${status ?? "?"}${code ? `/${code}` : ""}`,
    score: typeof score === "number" ? `${score}%` : "—",
    fallback: result.fallback.called ? "Kie CALLED" : result.fallback.wouldUseKie ? "Would use Kie" : "No fallback",
    elapsed: fmtMs(result.totalElapsedMs ?? result.cloudflare.elapsedMs),
  };
}

export default function ImageProviderTestPage() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [threshold, setThreshold] = useState(75);
  const [runGeminiScore, setRunGeminiScore] = useState(false);
  const [actuallyCallKieFallback, setActuallyCallKieFallback] = useState(false);
  const [simulation, setSimulation] = useState("none");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("image-provider-test-history-v1");
      if (raw) setHistory(JSON.parse(raw) as HistoryEntry[]);
    } catch {}
  }, []);

  const realMode = simulation === "none";
  const providerSpend = useMemo(() => {
    const calls = ["Cloudflare"];
    if (runGeminiScore && realMode) calls.push("Gemini Vision");
    if (actuallyCallKieFallback && realMode) calls.push("Kie only if fallback is needed");
    return calls.join(" · ");
  }, [runGeminiScore, actuallyCallKieFallback, realMode]);

  async function runTest() {
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const r = await fetch("/api/tools/image-provider-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          aspectRatio,
          threshold,
          runGeminiScore: realMode ? runGeminiScore : false,
          actuallyCallKieFallback: realMode ? actuallyCallKieFallback : false,
          simulation,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      const next = j as TestResult;
      setResult(next);
      const entry = historyFromResult(next);
      setHistory((prev) => {
        const updated = [entry, ...prev].slice(0, 20);
        try { localStorage.setItem("image-provider-test-history-v1", JSON.stringify(updated)); } catch {}
        return updated;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function clearHistory() {
    setHistory([]);
    try { localStorage.removeItem("image-provider-test-history-v1"); } catch {}
  }

  return (
    <main style={{ width: "100%", maxWidth: 1180, margin: "0 auto", padding: "28px 30px 60px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 22 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 25, letterSpacing: "-0.03em" }}>Image Provider Test</h1>
          <p style={{ margin: "7px 0 0", color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.55 }}>
            Test Cloudflare image generation without running voiceover, planning, stock search, or video assembly.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Link href="/tools/pollinations-image-test" style={{ padding: "8px 11px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--fg)", fontSize: 11.5, textDecoration: "none", background: "var(--surface-2)" }}>
            Test Pollinations →
          </Link>
          <Link href="/tools/meta-image-test" style={{ padding: "8px 11px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--fg)", fontSize: 11.5, textDecoration: "none", background: "var(--surface-2)" }}>
            Test Meta Muse Image →
          </Link>
          <div style={{ padding: "8px 11px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--fg-muted)", fontSize: 11.5, whiteSpace: "nowrap" }}>
            AI33: never called · Groq: never called
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(320px, .85fr)", gap: 18, alignItems: "start" }}>
        <section style={card}>
          <div style={{ fontSize: 15, fontWeight: 750, marginBottom: 16 }}>Test configuration</div>

          <label style={labelStyle}>Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={12}
            disabled={!realMode}
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, opacity: realMode ? 1 : 0.55 }}
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 14 }}>
            <div>
              <label style={labelStyle}>Aspect ratio</label>
              <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as "16:9" | "9:16")} style={inputStyle}>
                <option value="16:9">16:9 · 1024×576</option>
                <option value="9:16">9:16 · 576×1024</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Pass score</label>
              <input type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Simulation</label>
              <select value={simulation} onChange={(e) => setSimulation(e.target.value)} style={inputStyle}>
                <option value="none">None · real Cloudflare</option>
                <option value="3040">3040 · Out of capacity</option>
                <option value="3036">3036 · Daily quota exhausted</option>
                <option value="4006">4006 · Daily free allocation exhausted</option>
                <option value="401">401 · Invalid credentials</option>
                <option value="403">403 · Permission denied</option>
                <option value="500">500 · Server error</option>
              </select>
            </div>
          </div>

          <div style={{ marginTop: 17, display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 13, cursor: realMode ? "pointer" : "default", opacity: realMode ? 1 : 0.5 }}>
              <input type="checkbox" checked={runGeminiScore} disabled={!realMode} onChange={(e) => setRunGeminiScore(e.target.checked)} style={{ marginTop: 2 }} />
              <span><b>Run Gemini quality score</b><br /><span style={{ color: "var(--fg-faint)", fontSize: 11.5 }}>Optional. Makes one Vision scoring call so you can see whether production would accept the Cloudflare image.</span></span>
            </label>

            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 13, cursor: realMode ? "pointer" : "default", opacity: realMode ? 1 : 0.5 }}>
              <input type="checkbox" checked={actuallyCallKieFallback} disabled={!realMode} onChange={(e) => setActuallyCallKieFallback(e.target.checked)} style={{ marginTop: 2 }} />
              <span><b>Actually call Kie fallback</b> <span style={{ color: "#e58b42", fontWeight: 800 }}>PAID</span><br /><span style={{ color: "var(--fg-faint)", fontSize: 11.5 }}>Off by default. When off, the tester only tells you that production would fall back to Kie — it does not create a paid Kie task.</span></span>
            </label>
          </div>

          <div style={{ marginTop: 17, padding: "11px 12px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.55 }}>
            {realMode ? <>This test can call: <b style={{ color: "var(--fg)" }}>{providerSpend}</b>.</> : <><b style={{ color: "var(--fg)" }}>Simulation mode:</b> zero external API calls. No Cloudflare, Gemini, Kie, AI33, or Groq usage.</>}
          </div>

          <button
            onClick={runTest}
            disabled={running || (realMode && !prompt.trim())}
            style={{
              marginTop: 16,
              width: "100%",
              border: 0,
              borderRadius: 9,
              padding: "11px 14px",
              background: running ? "var(--surface-3)" : "var(--accent)",
              color: "white",
              fontWeight: 750,
              fontSize: 13.5,
              cursor: running ? "wait" : "pointer",
            }}
          >
            {running ? "Running test…" : realMode ? "Generate Cloudflare test" : "Run simulation"}
          </button>

          {error && <div style={{ marginTop: 12, padding: 11, borderRadius: 8, background: "rgba(220,70,70,.10)", border: "1px solid rgba(220,70,70,.25)", color: "#d85c5c", fontSize: 12.5 }}>{error}</div>}
        </section>

        <section style={{ ...card, minHeight: 340 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 750 }}>Latest result</div>
            {result && <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>{result.mode === "simulation" ? "simulation" : fmtMs(result.totalElapsedMs)}</div>}
          </div>

          {!result ? (
            <div style={{ color: "var(--fg-faint)", fontSize: 12.5, lineHeight: 1.6, paddingTop: 6 }}>
              Run a test. The generated image, HTTP/Cloudflare status, retries, score and fallback decision will appear here.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Metric label="Cloudflare" value={result.cloudflare.success ? "SUCCESS" : `HTTP ${result.cloudflare.status ?? "?"}${result.cloudflare.code ? ` / ${result.cloudflare.code}` : ""}`} good={result.cloudflare.success} />
                <Metric label="Cloudflare profile" value={result.cloudflare.profileLabel || "—"} />
                <Metric label="Gemini score" value={typeof result.cloudflare.score === "number" ? `${result.cloudflare.score}%` : "not run"} good={result.cloudflare.passed ?? undefined} />
                <Metric label="Kie fallback" value={result.fallback.called ? "CALLED" : result.fallback.wouldUseKie ? "WOULD FALLBACK" : "NOT NEEDED"} good={!result.fallback.called && !result.fallback.wouldUseKie} />
                <Metric label="Cloudflare time" value={fmtMs(result.cloudflare.elapsedMs)} />
                <Metric label="Configured profiles" value={String(result.configuredProfiles?.length ?? 0)} />
              </div>

              {result.cloudflare.message && <div style={{ fontSize: 12, color: "var(--fg-muted)", padding: 10, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-deep)" }}>{result.cloudflare.message}</div>}

              {result.configuredProfiles && result.configuredProfiles.length > 0 && (
                <div>
                  <div style={{ ...labelStyle, marginBottom: 5 }}>Configured Cloudflare profiles</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {result.configuredProfiles.map((p) => (
                      <span key={p.id} style={{ fontSize: 11, padding: "5px 7px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--fg-muted)", background: "var(--bg-deep)" }}>
                        {p.label} · {p.accountHint}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {result.cloudflare.failovers && result.cloudflare.failovers.length > 0 && (
                <div>
                  <div style={{ ...labelStyle, marginBottom: 5 }}>Operational profile failover</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {result.cloudflare.failovers.map((f, i) => (
                      <div key={i} style={{ fontSize: 11.5, color: "var(--fg-muted)", background: "var(--bg-deep)", borderRadius: 7, padding: "7px 9px" }}>
                        {f.fromProfileLabel} → {f.toProfileLabel} · HTTP {f.status ?? "?"}{f.code ? `/${f.code}` : ""} · {f.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.cloudflare.retries && result.cloudflare.retries.length > 0 && (
                <div>
                  <div style={{ ...labelStyle, marginBottom: 5 }}>Retries</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {result.cloudflare.retries.map((r, i) => (
                      <div key={i} style={{ fontSize: 11.5, color: "var(--fg-muted)", background: "var(--bg-deep)", borderRadius: 7, padding: "7px 9px" }}>
                        {typeof r === "string" ? r : `${r.profileLabel ? `${r.profileLabel} · ` : ""}HTTP ${r.status ?? "?"}${r.code ? `/${r.code}` : ""} · attempt ${r.attempt} → ${r.nextAttempt} after ${(r.delayMs / 1000).toFixed(0)}s`}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.cloudflare.imageDataUrl && (
                <div>
                  <div style={labelStyle}>Cloudflare result</div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result.cloudflare.imageDataUrl} alt="Cloudflare test result" style={{ width: "100%", borderRadius: 9, border: "1px solid var(--border)", display: "block" }} />
                </div>
              )}

              {result.fallback.imageDataUrl && (
                <div>
                  <div style={labelStyle}>Kie fallback result</div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result.fallback.imageDataUrl} alt="Kie fallback test result" style={{ width: "100%", borderRadius: 9, border: "1px solid var(--border)", display: "block" }} />
                  {typeof result.fallback.score === "number" && <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--fg-muted)" }}>Kie Gemini score: {result.fallback.score}%</div>}
                </div>
              )}

              {result.fallback.error && <div style={{ fontSize: 12, color: "#d85c5c" }}>Kie error: {result.fallback.error}</div>}

              <div style={{ padding: 11, borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--border)", fontSize: 12, lineHeight: 1.55, color: "var(--fg-muted)" }}>
                <b style={{ color: "var(--fg)" }}>Production decision:</b> {result.action}
              </div>

              <div style={{ fontSize: 10.8, color: "var(--fg-faint)" }}>
                Calls: Cloudflare {result.externalCalls.cloudflare ? "yes" : "no"} · Gemini {result.externalCalls.gemini ? "yes" : "no"} · Kie {result.externalCalls.kie ? "yes" : "no"} · AI33 no · Groq no
              </div>
            </div>
          )}
        </section>
      </div>

      <section style={{ ...card, marginTop: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 750 }}>Local test history</div>
            <div style={{ fontSize: 11.5, color: "var(--fg-faint)", marginTop: 3 }}>Last 20 tests. Images and API secrets are not stored in this history.</div>
          </div>
          <button onClick={clearHistory} style={{ background: "transparent", color: "var(--fg-muted)", border: "1px solid var(--border)", borderRadius: 7, padding: "6px 9px", cursor: "pointer", fontSize: 11.5 }}>Clear</button>
        </div>
        {history.length === 0 ? (
          <div style={{ color: "var(--fg-faint)", fontSize: 12 }}>No tests yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>{["Time", "Result", "Cloudflare", "Score", "Fallback", "Elapsed"].map((h) => <th key={h} style={{ textAlign: "left", color: "var(--fg-faint)", fontWeight: 700, padding: "7px 8px", borderBottom: "1px solid var(--border)" }}>{h}</th>)}</tr></thead>
              <tbody>{history.map((h) => <tr key={h.id}>{[h.at, h.status, h.cloudflare, h.score, h.fallback, h.elapsed].map((v, i) => <td key={i} style={{ padding: "8px", borderBottom: "1px solid var(--border)", color: i === 1 ? "var(--fg)" : "var(--fg-muted)" }}>{v}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div style={{ padding: "9px 10px", borderRadius: 8, background: "var(--bg-deep)", border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 10.5, color: "var(--fg-faint)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 750, color: good === true ? "#4fa878" : good === false ? "#d85c5c" : "var(--fg)" }}>{value}</div>
    </div>
  );
}

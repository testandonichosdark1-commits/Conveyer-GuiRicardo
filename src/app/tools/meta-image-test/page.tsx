"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Result = {
  ok: boolean;
  providerLabel: string;
  threshold: number;
  aspectRatio: string;
  model: string;
  baseUrl: string;
  totalElapsedMs?: number;
  meta: {
    success: boolean;
    elapsedMs?: number;
    imageDataUrl?: string;
    score?: number | null;
    scoreModel?: string;
    scoreError?: string;
    passed?: boolean | null;
    status?: number;
    code?: string | number;
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
  externalCalls: { meta: boolean; gemini: boolean; kie: boolean; ai33: boolean; groq: boolean };
};

const DEFAULT_PROMPT = `Close-up of a human finger pressing a modern light switch on the wall of a hotel room, realistic everyday environment, the switch plate slightly worn from frequent use, natural hand position, believable hotel interior softly visible in the background.\n\nCandid amateur YouTube vlog video still, raw handheld smartphone footage, natural indoor lighting, authentic domestic or hotel environment, slight motion blur, 2010s home video snapshot, unedited, realistic and human.\n\nThe image should feel like a real frame casually captured on a phone camera, not a polished advertisement or studio photo. Prioritize believable imperfection, natural composition, soft realism, everyday authenticity, and practical real-world environments.`;

const card: React.CSSProperties = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 12, padding: 18 };
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--fg-muted)", marginBottom: 7 };
const input: React.CSSProperties = { width: "100%", background: "var(--bg-deep)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "9px 10px", fontSize: 13, outline: "none" };

function fmt(ms?: number) {
  if (ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export default function MetaImageTestPage() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [threshold, setThreshold] = useState(75);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.meta.ai/v1");
  const [model, setModel] = useState("muse-image-1.0");
  const [runGeminiScore, setRunGeminiScore] = useState(false);
  const [callKie, setCallKie] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      setApiKey(localStorage.getItem("meta-muse-test-key-v1") || "");
      setBaseUrl(localStorage.getItem("meta-muse-test-base-v1") || "https://api.meta.ai/v1");
      setModel(localStorage.getItem("meta-muse-test-model-v1") || "muse-image-1.0");
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("meta-muse-test-key-v1", apiKey);
      localStorage.setItem("meta-muse-test-base-v1", baseUrl);
      localStorage.setItem("meta-muse-test-model-v1", model);
    } catch {}
  }, [apiKey, baseUrl, model]);

  const calls = useMemo(() => {
    const x = ["Meta Muse Image"];
    if (runGeminiScore) x.push("Gemini Vision");
    if (callKie) x.push("Kie only if fallback is needed");
    return x.join(" · ");
  }, [runGeminiScore, callKie]);

  async function run() {
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const r = await fetch("/api/tools/meta-image-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          aspectRatio,
          threshold,
          runGeminiScore,
          actuallyCallKieFallback: callKie,
          metaApiKey: apiKey,
          metaBaseUrl: baseUrl,
          metaModel: model,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setResult(j as Result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main style={{ width: "100%", maxWidth: 1120, margin: "0 auto", padding: "28px 30px 60px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 12, marginBottom: 8 }}><Link href="/tools/image-provider-test" style={{ color: "var(--fg-muted)" }}>← Cloudflare Image Provider Test</Link></div>
          <h1 style={{ margin: 0, fontSize: 25 }}>Meta Muse Image Test</h1>
          <p style={{ color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.55 }}>Isolated Muse Image test. AI33, Groq, planning and video assembly are never called.</p>
        </div>
        <div style={{ padding: "8px 11px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--fg-muted)", fontSize: 11.5 }}>AI33: never · Groq: never</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(320px, .9fr)", gap: 18, alignItems: "start" }}>
        <section style={card}>
          <div style={{ fontWeight: 750, marginBottom: 16 }}>Meta Model API</div>

          <label style={label}>Meta API key</label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste your API key" style={input} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 13 }}>
            <div><label style={label}>Base URL</label><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={input} /></div>
            <div><label style={label}>Model ID</label><input value={model} onChange={(e) => setModel(e.target.value)} style={input} /></div>
          </div>

          <label style={{ ...label, marginTop: 14 }}>Prompt</label>
          <textarea rows={11} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ ...input, resize: "vertical", lineHeight: 1.5 }} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 13 }}>
            <div>
              <label style={label}>Aspect ratio</label>
              <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as "16:9" | "9:16")} style={input}><option value="16:9">16:9</option><option value="9:16">9:16</option></select>
            </div>
            <div><label style={label}>Pass score</label><input type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={input} /></div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
            <label style={{ display: "flex", gap: 9, fontSize: 13 }}><input type="checkbox" checked={runGeminiScore} onChange={(e) => setRunGeminiScore(e.target.checked)} /><span><b>Run Gemini quality score</b><br /><span style={{ color: "var(--fg-faint)", fontSize: 11.5 }}>Optional Vision call after Muse Image generates.</span></span></label>
            <label style={{ display: "flex", gap: 9, fontSize: 13 }}><input type="checkbox" checked={callKie} onChange={(e) => setCallKie(e.target.checked)} /><span><b>Actually call Kie fallback</b> <span style={{ color: "#e58b42", fontWeight: 800 }}>PAID</span><br /><span style={{ color: "var(--fg-faint)", fontSize: 11.5 }}>Off by default.</span></span></label>
          </div>

          <div style={{ marginTop: 16, padding: 10, border: "1px solid var(--border)", borderRadius: 8, color: "var(--fg-muted)", fontSize: 12 }}>This test can call: <b style={{ color: "var(--fg)" }}>{calls}</b>.</div>

          <button onClick={run} disabled={running || !apiKey.trim() || !prompt.trim()} style={{ marginTop: 15, width: "100%", border: 0, borderRadius: 9, padding: "11px 14px", background: running ? "var(--surface-3)" : "var(--accent)", color: "white", fontWeight: 750, cursor: running ? "wait" : "pointer" }}>{running ? "Generating…" : "Generate Meta Muse test"}</button>
          {error && <div style={{ marginTop: 11, padding: 10, borderRadius: 8, color: "#d85c5c", background: "rgba(220,70,70,.10)", border: "1px solid rgba(220,70,70,.25)", fontSize: 12.5 }}>{error}</div>}
        </section>

        <section style={{ ...card, minHeight: 330 }}>
          <div style={{ fontWeight: 750, marginBottom: 14 }}>Latest result</div>
          {!result ? <div style={{ color: "var(--fg-faint)", fontSize: 12.5 }}>Run a Muse Image test. The image and API status will appear here.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Metric label="Meta Muse" value={result.meta.success ? "SUCCESS" : `HTTP ${result.meta.status ?? "?"}${result.meta.code ? ` / ${result.meta.code}` : ""}`} good={result.meta.success} />
                <Metric label="Gemini score" value={typeof result.meta.score === "number" ? `${result.meta.score}%` : "not run"} good={result.meta.passed ?? undefined} />
                <Metric label="Muse time" value={fmt(result.meta.elapsedMs)} />
                <Metric label="Kie fallback" value={result.fallback.called ? "CALLED" : result.fallback.wouldUseKie ? "WOULD FALLBACK" : "NOT NEEDED"} good={!result.fallback.called && !result.fallback.wouldUseKie} />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--fg-faint)" }}>Model: <span style={{ color: "var(--fg)" }}>{result.model}</span><br />Base: <span style={{ color: "var(--fg)" }}>{result.baseUrl}</span></div>
              {result.meta.message && <div style={{ padding: 9, borderRadius: 8, border: "1px solid var(--border)", color: "var(--fg-muted)", fontSize: 12 }}>{result.meta.message}</div>}
              {result.meta.imageDataUrl && <div><div style={label}>Muse Image result</div>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={result.meta.imageDataUrl} alt="Muse Image result" style={{ width: "100%", borderRadius: 9, border: "1px solid var(--border)" }} /></div>}
              {result.fallback.imageDataUrl && <div><div style={label}>Kie fallback result</div>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={result.fallback.imageDataUrl} alt="Kie fallback" style={{ width: "100%", borderRadius: 9, border: "1px solid var(--border)" }} /></div>}
              {result.fallback.error && <div style={{ color: "#d85c5c", fontSize: 12 }}>Kie error: {result.fallback.error}</div>}
              <div style={{ padding: 10, borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5 }}><b style={{ color: "var(--fg)" }}>Decision:</b> {result.action}</div>
              <div style={{ fontSize: 10.8, color: "var(--fg-faint)" }}>Calls: Meta yes · Gemini {result.externalCalls.gemini ? "yes" : "no"} · Kie {result.externalCalls.kie ? "yes" : "no"} · AI33 no · Groq no</div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div style={{ padding: "9px 10px", borderRadius: 8, background: "var(--bg-deep)", border: "1px solid var(--border)" }}><div style={{ fontSize: 10.5, color: "var(--fg-faint)", marginBottom: 4 }}>{label}</div><div style={{ fontSize: 12.5, fontWeight: 750, color: good === true ? "#4fa878" : good === false ? "#d85c5c" : "var(--fg)" }}>{value}</div></div>;
}

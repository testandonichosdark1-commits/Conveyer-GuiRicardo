"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const DEFAULT_PROMPT = `Close-up of a human finger pressing a modern light switch on the wall of a hotel room, realistic everyday environment, the switch plate slightly worn from frequent use, natural hand position, believable hotel interior softly visible in the background. Candid amateur YouTube vlog video still, raw handheld smartphone footage, natural indoor lighting, realistic and human.`;
const card: React.CSSProperties = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 12, padding: 18 };
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--fg-muted)", marginBottom: 7 };
const input: React.CSSProperties = { width: "100%", background: "var(--bg-deep)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "9px 10px", fontSize: 13, outline: "none" };

type Result = any;

export default function PollinationsImageTestPage() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("zimage");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [threshold, setThreshold] = useState(75);
  const [score, setScore] = useState(false);
  const [kie, setKie] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  useEffect(() => { try { setApiKey(localStorage.getItem("pollinations-test-key-v1") || ""); setModel(localStorage.getItem("pollinations-test-model-v1") || "zimage"); } catch {} }, []);
  useEffect(() => { try { localStorage.setItem("pollinations-test-key-v1", apiKey); localStorage.setItem("pollinations-test-model-v1", model); } catch {} }, [apiKey, model]);

  async function run() {
    setRunning(true); setError(""); setResult(null);
    try {
      const r = await fetch("/api/tools/pollinations-image-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey, model, prompt, aspectRatio, threshold, runGeminiScore: score, actuallyCallKieFallback: kie }) });
      const j = await r.json(); if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`); setResult(j);
    } catch (e) { setError((e as Error).message); } finally { setRunning(false); }
  }

  return <main style={{ width: "100%", maxWidth: 1120, margin: "0 auto", padding: "28px 30px 60px" }}>
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 12, marginBottom: 8 }}><Link href="/tools/image-provider-test" style={{ color: "var(--fg-muted)" }}>← Image Provider Test</Link></div>
      <h1 style={{ margin: 0, fontSize: 25 }}>Pollinations Image Test</h1>
      <p style={{ color: "var(--fg-muted)", fontSize: 13.5 }}>Isolated Pollinations test. AI33, Groq, planning and assembly are never called.</p>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(320px, .9fr)", gap: 18, alignItems: "start" }}>
      <section style={card}>
        <label style={label}>Pollinations API key</label><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk_…" style={input} />
        <label style={{ ...label, marginTop: 12 }}>Model</label><input value={model} onChange={(e) => setModel(e.target.value)} style={input} />
        <label style={{ ...label, marginTop: 12 }}>Prompt</label><textarea rows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ ...input, resize: "vertical", lineHeight: 1.5 }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <div><label style={label}>Aspect ratio</label><select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as any)} style={input}><option value="16:9">16:9 · 1024×576</option><option value="9:16">9:16 · 576×1024</option></select></div>
          <div><label style={label}>Pass score</label><input type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={input} /></div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          <label style={{ fontSize: 13 }}><input type="checkbox" checked={score} onChange={(e) => setScore(e.target.checked)} /> <b>Run Gemini quality score</b></label>
          <label style={{ fontSize: 13 }}><input type="checkbox" checked={kie} onChange={(e) => setKie(e.target.checked)} /> <b>Actually call Kie fallback</b> <span style={{ color: "#e58b42", fontWeight: 800 }}>PAID</span></label>
        </div>
        <button onClick={run} disabled={running || !apiKey.trim() || !prompt.trim()} style={{ marginTop: 15, width: "100%", border: 0, borderRadius: 9, padding: "11px 14px", background: running ? "var(--surface-3)" : "var(--accent)", color: "white", fontWeight: 750 }}>{running ? "Generating…" : "Generate Pollinations test"}</button>
        {error && <div style={{ marginTop: 11, color: "#d85c5c", fontSize: 12 }}>{error}</div>}
      </section>
      <section style={{ ...card, minHeight: 330 }}>
        <div style={{ fontWeight: 750, marginBottom: 14 }}>Latest result</div>
        {!result ? <div style={{ color: "var(--fg-faint)", fontSize: 12.5 }}>Run a test.</div> : <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontWeight: 750, color: result.pollinations.success ? "#4fa878" : "#d85c5c" }}>{result.pollinations.success ? `SUCCESS · ${result.model}` : `FAILED · HTTP ${result.pollinations.status ?? "?"}${result.pollinations.code ? ` / ${result.pollinations.code}` : ""}`}</div>
          {result.pollinations.message && <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{result.pollinations.message}</div>}
          {typeof result.pollinations.score === "number" && <div style={{ fontSize: 12 }}>Gemini score: <b>{result.pollinations.score}%</b></div>}
          {result.pollinations.imageDataUrl && <img src={result.pollinations.imageDataUrl} alt="Pollinations result" style={{ width: "100%", borderRadius: 9, border: "1px solid var(--border)" }} />}
          <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>Calls: Pollinations yes · Gemini {result.externalCalls.gemini ? "yes" : "no"} · Kie {result.externalCalls.kie ? "yes" : "no"} · AI33 no · Groq no</div>
        </div>}
      </section>
    </div>
  </main>;
}

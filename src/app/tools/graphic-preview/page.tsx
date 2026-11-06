"use client";

import { useState } from "react";

const card: React.CSSProperties = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 12, padding: 18 };
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--fg-muted)", marginBottom: 7 };
const input: React.CSSProperties = { width: "100%", background: "var(--bg-deep)", color: "var(--fg)", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "9px 10px", fontSize: 13, outline: "none" };
const mono: React.CSSProperties = { ...input, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, lineHeight: 1.5, resize: "vertical" };

type Preset = { name: string; refs: string; data: Record<string, unknown>; narration: string };

const PRESETS: Record<string, Preset[]> = {
  product_hero: [
    { name: "Dark", refs: "00:00 · 06:15", narration: "In 1984 Maglite shrank its famous flashlight into something you could carry every single day.",
      data: { image: "sample:flashlight", overline: "1984", title: "Mini Maglite", subtitle: "America's pocket flashlight", bg: "dark" } },
    { name: "Reveal + chip", refs: "01:48 → 01:54", narration: "Then came a bigger one. The Maglite C-cell and D-cell, built like a machine part, the same build as the 1984 Mini.",
      data: { image: "sample:flashlight", overline: "1999", title: "Maglite C-Cell / D-Cell", subtitle: "Built like a machine part", reveal: true, revealCue: "Maglite", chip: "Same build, 1984 Mini", chipCue: "same", bg: "dark" } },
    { name: "Parchment, right", refs: "10:24 · 10:36", narration: "The Maglite Mag-Tac was the one meant to compete.",
      data: { image: "sample:flashlight", title: "Maglite Mag-Tac", productSide: "right", bg: "parchment" } },
    { name: "Carimbo", refs: "02:42 · 12:27", narration: "Streamlight was one of them. Maglite sued.",
      data: { image: "sample:flashlight", overline: "Copied in court", title: "Streamlight Stinger", subtitle: "Streamlight was one of them.", stamp: { text: "Sued", cueWord: "sued" }, bg: "parchment" } },
  ],
  spec_callouts: [
    { name: "Labels à esquerda", refs: "02:00 · 12:12", narration: "A machined aluminum body, a head you twist to focus the beam, and a belt holster in the box.",
      data: { image: "sample:flashlight", name: "Mini Maglite", sub: "Twist to turn on", price: "$25", specs: [
        { label: "Machined aluminum body", sub: "Anodized, built to be dropped", anchor: { x: 0.6, y: 0.5 }, cueWord: "aluminum" },
        { label: "Twist-focus head", sub: "Flood to a tight spot", anchor: { x: 0.12, y: 0.5 }, cueWord: "head" },
        { label: "Belt holster", sub: "Rides on your belt", anchor: { x: 0.94, y: 0.5 }, cueWord: "holster" }], bg: "dark" } },
    { name: "Labels à direita + carimbo", refs: "14:12 · 14:27", narration: "The Buck 110 has brass bolsters and a lockback that holds the blade open. My keychain pick.",
      data: { image: "sample:knife", name: "Buck 110", sub: "Folding hunter", price: "$60", labelsSide: "right", specs: [
        { label: "Brass bolsters", anchor: { x: 0.47, y: 0.4 }, cueWord: "brass" },
        { label: "Lockback", sub: "Holds the blade open", anchor: { x: 0.9, y: 0.5 }, cueWord: "lockback" }],
        stamp: { text: "Keychain pick", cueWord: "keychain" }, bg: "dark" } },
  ],
  impact_bars: [
    { name: "Tarjas", refs: "02:30", narration: "Something that good gets copied.",
      data: { lines: [{ text: "Something" }, { text: "that good" }, { text: "gets copied.", gold: true }], bg: "dark" } },
    { name: "Riscado", refs: "07:18 → 07:21", narration: "The serious choice became a liability.",
      data: { lines: [{ text: "The serious choice", plain: true, strike: true }, { text: "became a liability", gold: true, cueWord: "became" }], label: "The trade-off", bg: "dark" } },
  ],
  counter: [
    { name: "Com produto", refs: "00:18 → 00:21", narration: "By the end of the nineties the California plant was making thirty-nine million lights a year.",
      data: { value: 39000000, suffix: "a year", caption: "lights made a year at the California plant", overline: "By the end of the nineties", image: "sample:flashlight", bg: "dark" } },
    { name: "Dinheiro, pergaminho", refs: "02:45 → 02:48 · 07:12", narration: "Kassnar and Brinkmann paid up too, three point one million dollars.",
      data: { value: 3100000, prefix: "$", caption: "Kassnar and Brinkmann paid up too", kicker: "Settled", bg: "parchment" } },
  ],
  versus: [
    { name: "Com vencedor", refs: "06:27 → 06:36", narration: "For the small jobs, the phone already in your pocket finds the keys and reads the breaker label. The Mini Mag needs its own batteries. The phone wins.",
      data: { title: "Phone vs Mini Mag", overline: "The small jobs",
        left: { name: "Phone flashlight", sub: "Already in your pocket", image: "sample:phone", bullets: ["Finds keys under a seat", "Reads a breaker label"] },
        right: { name: "Mini Maglite", sub: "AA, incandescent bulb", image: "sample:flashlight", bullets: ["Needs its own batteries", "A separate tool to carry"], bad: true },
        winner: "left", ribbon: "Phone wins", ribbonCue: "wins", bg: "dark" } },
  ],
  checklist_card: [
    { name: "Pergaminho", refs: "06:06 → 06:12", narration: "What changed? Pocket clips instead of holsters, tail switches you hit with a thumb, lithium cells, and low modes that run for days.",
      data: { overline: "LED-first designs", title: "What changed", subtitle: "Built around the LED from scratch", items: [
        { text: "Pocket clips", note: "instead of belt holsters", state: "check", cueWord: "clips" },
        { text: "Tail switches", note: "one with a thumb", state: "check", cueWord: "switches" },
        { text: "Lithium cells", state: "check", cueWord: "lithium" },
        { text: "Low modes", note: "runs for days", state: "check", cueWord: "low" }], bg: "parchment" } },
    { name: "Com produto + carimbo", refs: "09:00 → 09:09", narration: "The ten-year warranty covers defects for the original owner. Battery leakage? Not covered.",
      data: { overline: "Maglite warranty", title: "10-year warranty", subtitle: "From the first retail purchase", items: [
        { text: "Defects, original owner", note: "10 years", state: "check", cueWord: "defects" },
        { text: "Battery leakage", state: "cross", cueWord: "leakage" }],
        stamp: { text: "Not covered", cueWord: "not" }, image: "sample:flashlight" } },
  ],
  polaroids: [
    { name: "Madeira clara", refs: "02:12 · 07:48 → 07:54", narration: "A guy I know carried a Maglite in the cruiser, a Buck 110 on his belt, and later a Streamlight Stinger.",
      data: { label: "One cop's career", photos: [
        { image: "sample:flashlight", caption: "Maglite in the cruiser", cueWord: "maglite" },
        { image: "sample:knife", caption: "Buck 110, always on him", cueWord: "buck" },
        { image: "sample:flashlight", caption: "Streamlight Stinger", cueWord: "streamlight" }], bg: "wood-light" } },
    { name: "Madeira escura", refs: "10:00 → 10:06", narration: "The lineup today: the Mini Maglite Pro, the Pro Plus, the Mag and the Solitaire LED.",
      data: { photos: [
        { image: "sample:flashlight", caption: "Mini Maglite Pro" },
        { image: "sample:knife", caption: "Mini Maglite Pro Plus" },
        { image: "sample:phone", caption: "Mag" },
        { image: "sample:flashlight", caption: "Solitaire LED" }], bg: "wood-dark" } },
  ],
  timeline: [
    { name: "Patentes", refs: "04:06 → 04:12", narration: "The patent was granted in 1981. It expired in 1998, and by 2004 the Mini's own patent had ended too.",
      data: { title: "Running out", events: [
        { year: 1981, label: "Patent granted" },
        { year: 1998, label: "Patent expires", sub: "The original design protection ends" },
        { year: 2004, label: "Mini's patent ends", sub: "The Mini Maglite is now open" }], bg: "dark" } },
  ],
  kinetic_quote: [
    { name: "Outline · parchment", refs: "01:15 → 01:18", narration: "Everything else was built to outlast you.",
      data: { text: "Everything else was built to outlast you.", highlight: ["outlast you"], style: "outline-fill", label: "Mag Instrument", bg: "parchment" } },
    { name: "Outline · dark", refs: "00:12 → 00:15", narration: "At its peak it held around a quarter of the whole American market.",
      data: { text: "Around a quarter of the whole American market", highlight: ["a quarter"], style: "outline-fill", label: "Peak share", bg: "dark" } },
    { name: "Typewriter stacked", refs: "00:39 → 00:42", narration: "Never closed, never sold out, lose your pocket anyway?",
      data: { text: "Never closed, never sold out, lose your pocket anyway?", highlight: ["never sold out", "pocket anyway"], style: "typewriter", bg: "parchment" } },
  ],
};

type Result = { kind: "frame" | "clip"; dataUrl: string; ms: number; frames?: number; bytes?: number; atMs?: number };

export default function GraphicPreviewPage() {
  const [template, setTemplate] = useState("product_hero");
  const [presetIdx, setPresetIdx] = useState(0);
  const preset = PRESETS[template][presetIdx];
  const [json, setJson] = useState(JSON.stringify(PRESETS.product_hero[0].data, null, 2));
  const [narration, setNarration] = useState(PRESETS.product_hero[0].narration);
  const [durationSec, setDurationSec] = useState(6);
  const [atMs, setAtMs] = useState(3000);
  const [upload, setUpload] = useState<{ name: string; dataUrl: string } | null>(null);
  const [running, setRunning] = useState<"" | "frame" | "clip">("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  function applyPreset(t: string, i: number) {
    const p = PRESETS[t][i];
    setTemplate(t); setPresetIdx(i);
    setJson(JSON.stringify(p.data, null, 2)); setNarration(p.narration);
  }

  function onFile(f: File | undefined) {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setUpload({ name: f.name, dataUrl: String(r.result) });
    r.readAsDataURL(f);
  }

  async function render(mode: "frame" | "clip") {
    setError(""); setRunning(mode);
    try {
      let data: Record<string, unknown>;
      try { data = JSON.parse(json); } catch (e) { throw new Error(`JSON inválido: ${(e as Error).message}`); }
      if (upload && "image" in data) data = { ...data, image: upload.dataUrl }; // top-level image only
      const r = await fetch("/api/tools/graphic-preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, data, narration, durationSec, mode, atMs }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setResult(j);
    } catch (e) { setError((e as Error).message); } finally { setRunning(""); }
  }

  const busy = running !== "";
  const btn = (primary: boolean): React.CSSProperties => ({ flex: 1, border: 0, borderRadius: 9, padding: "11px 14px", background: busy ? "var(--surface-3)" : primary ? "var(--accent)" : "var(--surface-3)", color: primary ? "white" : "var(--fg)", fontWeight: 750, cursor: busy ? "default" : "pointer" });

  return <main style={{ width: "100%", maxWidth: 1280, margin: "0 auto", padding: "28px 30px 60px" }}>
    <div style={{ marginBottom: 20 }}>
      <h1 style={{ margin: 0, fontSize: 25 }}>Graphic preview</h1>
      <p style={{ color: "var(--fg-muted)", fontSize: 13.5 }}>Renderiza um template de motion graphics (HTML + Chromium headless, frame a frame) para conferir o visual. Local e gratuito: nenhum run é criado e nenhuma API é chamada. Os tempos das palavras são sintéticos (a narração é espalhada uniformemente pelo clipe).</p>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 0.8fr) minmax(0, 1.2fr)", gap: 18, alignItems: "start" }}>
      <section style={card}>
        <label style={label}>Template</label>
        <select value={template} onChange={(e) => applyPreset(e.target.value, 0)} style={input}>
          {Object.keys(PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <label style={{ ...label, marginTop: 12 }}>Exemplo</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {PRESETS[template].map((p, i) => <button key={p.name} onClick={() => applyPreset(template, i)} style={{ border: "1px solid var(--border-strong)", borderRadius: 7, padding: "6px 10px", fontSize: 12, background: i === presetIdx ? "var(--accent)" : "var(--bg-deep)", color: i === presetIdx ? "white" : "var(--fg)", cursor: "pointer" }}>{p.name}</button>)}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-faint)", marginTop: 6 }}>Referência: docs/reference/maglite, {preset.refs}</div>
        <label style={{ ...label, marginTop: 12 }}>data (JSON)</label>
        <textarea rows={12} value={json} onChange={(e) => setJson(e.target.value)} style={mono} spellCheck={false} />
        <label style={{ ...label, marginTop: 12 }}>Narração do beat (para cueWord e digitação)</label>
        <textarea rows={3} value={narration} onChange={(e) => setNarration(e.target.value)} style={{ ...input, resize: "vertical", lineHeight: 1.5 }} />
        <label style={{ ...label, marginTop: 12 }}>Imagem do produto (PNG transparente, opcional)</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="file" accept="image/png,image/webp,image/svg+xml" onChange={(e) => onFile(e.target.files?.[0])} style={{ fontSize: 12 }} />
          {upload && <button onClick={() => setUpload(null)} style={{ fontSize: 12, border: 0, background: "none", color: "var(--fg-muted)", cursor: "pointer" }}>remover</button>}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-faint)", marginTop: 4 }}>{upload ? `Usando ${upload.name} no campo image.` : "Sem upload: usa a lanterna de exemplo (sample:flashlight)."}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <div><label style={label}>Duração (s)</label><input type="number" min={1} max={30} step={0.5} value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))} style={input} /></div>
          <div><label style={label}>Frame em (ms)</label><input type="number" min={0} max={durationSec * 1000} step={100} value={atMs} onChange={(e) => setAtMs(Number(e.target.value))} style={input} /></div>
        </div>
        <input type="range" min={0} max={durationSec * 1000} step={100} value={atMs} onChange={(e) => setAtMs(Number(e.target.value))} style={{ width: "100%", marginTop: 10 }} />
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button onClick={() => render("frame")} disabled={busy} style={btn(false)}>{running === "frame" ? "Renderizando…" : "Frame"}</button>
          <button onClick={() => render("clip")} disabled={busy} style={btn(true)}>{running === "clip" ? "Renderizando clipe…" : `Clipe de ${durationSec}s`}</button>
        </div>
        {error && <div style={{ marginTop: 11, color: "#d85c5c", fontSize: 12, whiteSpace: "pre-wrap" }}>{error}</div>}
      </section>
      <section style={{ ...card, minHeight: 330 }}>
        <div style={{ fontWeight: 750, marginBottom: 14 }}>Resultado</div>
        {!result ? <div style={{ color: "var(--fg-faint)", fontSize: 12.5 }}>Renderize um frame ou um clipe.</div> : <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {result.kind === "frame"
            ? <img src={result.dataUrl} alt="frame" style={{ width: "100%", borderRadius: 9, border: "1px solid var(--border)" }} />
            : <video src={result.dataUrl} controls autoPlay loop muted style={{ width: "100%", borderRadius: 9, border: "1px solid var(--border)", background: "#000" }} />}
          <div style={{ fontSize: 11.5, color: "var(--fg-faint)" }}>
            {result.kind === "frame" ? `Frame em ${result.atMs} ms · ${result.ms} ms para renderizar` : `${result.frames} frames · ${(result.bytes! / 1e6).toFixed(2)} MB · ${(result.ms / 1000).toFixed(1)} s para renderizar`}
          </div>
        </div>}
      </section>
    </div>
  </main>;
}

"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface Channel {
  id: number;
  name: string;
}

interface Job {
  id: string;
  title: string;
  channel_kind: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  step: "script" | "thumbnail" | "video" | "finished";
  detail: string | null;
  run_id: string | null;
  created_at: string;
  files: { script: boolean; description: boolean; research: boolean; thumbnail: boolean; thumbnailPackage: boolean };
}

const STEPS: { key: Job["step"]; label: string }[] = [
  { key: "script", label: "Roteiro" },
  { key: "thumbnail", label: "Thumb" },
  { key: "video", label: "Voz + vídeo" },
];

const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Na fila",
  running: "Rodando",
  done: "Pronto",
  error: "Erro",
  cancelled: "Cancelado",
};

const STATUS_COLOR: Record<Job["status"], string> = {
  queued: "var(--muted, #888)",
  running: "#2f7de1",
  done: "#1f9d55",
  error: "#d64545",
  cancelled: "var(--muted, #888)",
};

function stepState(job: Job, idx: number): "done" | "active" | "todo" {
  const cur = job.step === "finished" ? 3 : STEPS.findIndex((s) => s.key === job.step);
  if (idx < cur || job.status === "done") return "done";
  if (idx === cur && job.status === "running") return "active";
  return "todo";
}

export default function FactoryPage() {
  const [titles, setTitles] = useState("");
  const [kind, setKind] = useState("a");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string>("");
  const [visualMode, setVisualMode] = useState<"ai" | "real" | "mix">("mix");
  const [realPercent, setRealPercent] = useState(50);
  const [voice, setVoice] = useState<"voicestudio" | "channel">("voicestudio");
  const [free, setFree] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [meta, setMeta] = useState({ active: 0, concurrency: 3 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    fetch("/api/factory", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.jobs)) {
          setJobs(d.jobs);
          setMeta({ active: d.active, concurrency: d.concurrency });
        }
      })
      .catch(() => {});

  useEffect(() => {
    fetch("/api/channels")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows) => {
        if (Array.isArray(rows)) setChannels(rows);
      })
      .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const count = titles.split("\n").filter((t) => t.trim().length >= 8).length;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/factory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          titles: titles.split("\n"),
          channelKind: kind,
          channelId: channelId ? Number(channelId) : null,
          visualMode,
          realPercent,
          avatarPercent: 0,
          voice,
          free,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setError(d.error || "Falha ao criar o lote.");
      else setTitles("");
      load();
    } finally {
      setBusy(false);
    }
  }

  const act = (id: string, action: string) =>
    fetch(`/api/factory/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).then(load);

  const file = (id: string, kind: string) => `/api/factory/${id}/file?kind=${kind}`;

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1>Fábrica de vídeos</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: 14 }}>
        Cole um título por linha. Cada um passa por roteiro + descrição → thumbnail → narração, assets e montagem.
        Rodam {meta.concurrency} ao mesmo tempo; os outros esperam na fila.
      </p>

      <div className="card" style={{ display: "grid", gap: 14, marginBottom: 24 }}>
        <div>
          <label className="label">Títulos (um por linha)</label>
          <textarea
            className="input"
            rows={6}
            value={titles}
            onChange={(e) => setTitles(e.target.value)}
            placeholder={"7 Things US Army Rangers Found Strange About Britain's Gurkhas\n7 Things ..."}
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
          <div>
            <label className="label">Formato do roteiro</label>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="a">a — Militar / forças especiais</option>
              <option value="b">b — Caminhoneiros</option>
              <option value="c">c — Aviação e espaço (Guerra Fria)</option>
            </select>
          </div>
          <div>
            <label className="label">Canal no Conveyer (voz, estilo)</label>
            <select className="input" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">— padrão das Settings —</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Voz</label>
            <select className="input" value={voice} onChange={(e) => setVoice(e.target.value as "voicestudio" | "channel")}>
              <option value="voicestudio">VoiceStudio (local, grátis)</option>
              <option value="channel">Voz do canal / Settings</option>
            </select>
          </div>
          <div>
            <label className="label">Custo</label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, paddingTop: 8 }}>
              <input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} />
              Custo zero (só b-roll real, nunca IA paga)
            </label>
          </div>
          {!free && (
          <div>
            <label className="label">Visuais</label>
            <select
              className="input"
              value={visualMode}
              onChange={(e) => setVisualMode(e.target.value as "ai" | "real" | "mix")}
            >
              <option value="mix">Mix (IA + b-roll real)</option>
              <option value="real">Só b-roll real</option>
              <option value="ai">Só IA</option>
            </select>
          </div>
          )}
          {!free && visualMode === "mix" && (
            <div>
              <label className="label">B-roll real: {realPercent}% · IA: {100 - realPercent}%</label>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={realPercent}
                onChange={(e) => setRealPercent(Number(e.target.value))}
                style={{ width: "100%" }}
              />
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button className="btn" disabled={busy || count === 0} onClick={submit}>
            {busy ? "Criando…" : `Produzir ${count || ""} vídeo${count === 1 ? "" : "s"}`}
          </button>
          {error && <span style={{ color: "#d64545", fontSize: 14 }}>{error}</span>}
        </div>
      </div>

      <h2 style={{ fontSize: 18, marginBottom: 10 }}>
        Lotes · {meta.active} rodando
      </h2>
      {jobs.length === 0 && <p className="muted">Nenhum vídeo ainda.</p>}
      <div style={{ display: "grid", gap: 12 }}>
        {jobs.map((j) => (
          <div key={j.id} className="card" style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
              {j.files.thumbnail ? (
                <a href={file(j.id, "thumbnail")} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={file(j.id, "thumbnail")}
                    alt=""
                    style={{ width: 192, aspectRatio: "16/9", objectFit: "cover", borderRadius: 6 }}
                  />
                </a>
              ) : (
                <div
                  style={{
                    width: 192,
                    aspectRatio: "16/9",
                    borderRadius: 6,
                    background: "rgba(127,127,127,.15)",
                  }}
                />
              )}
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{j.title}</div>
                <div style={{ fontSize: 13, color: STATUS_COLOR[j.status], marginBottom: 6 }}>
                  {STATUS_LABEL[j.status]}
                  {j.detail ? ` — ${j.detail}` : ""}
                </div>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  {STEPS.map((s, i) => {
                    const st = stepState(j, i);
                    return (
                      <span
                        key={s.key}
                        style={{
                          fontSize: 12,
                          padding: "2px 8px",
                          borderRadius: 999,
                          border: "1px solid rgba(127,127,127,.35)",
                          background:
                            st === "done" ? "rgba(31,157,85,.15)" : st === "active" ? "rgba(47,125,225,.18)" : "transparent",
                        }}
                      >
                        {st === "done" ? "✓ " : st === "active" ? "… " : ""}
                        {s.label}
                      </span>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                  {j.files.script && <a href={file(j.id, "script")} target="_blank" rel="noreferrer">Roteiro</a>}
                  {j.files.description && (
                    <a href={file(j.id, "description")} target="_blank" rel="noreferrer">Descrição</a>
                  )}
                  {j.files.research && (
                    <a href={file(j.id, "research")} target="_blank" rel="noreferrer">Fatos a checar</a>
                  )}
                  {j.files.thumbnailPackage && (
                    <a href={file(j.id, "thumbnailPackage")} target="_blank" rel="noreferrer">Prompts da thumb</a>
                  )}
                  {j.run_id && <Link href={`/runs/${j.run_id}`}>Vídeo e log</Link>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {(j.status === "running" || j.status === "queued") && (
                  <button className="btn-secondary" onClick={() => act(j.id, "cancel")}>Cancelar</button>
                )}
                {(j.status === "error" || j.status === "cancelled") && (
                  <button className="btn-secondary" onClick={() => act(j.id, "retry")}>Tentar de novo</button>
                )}
                {j.status !== "running" && (
                  <button className="btn-ghost" onClick={() => act(j.id, "delete")}>Remover</button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";

type Status = { connected: boolean; baseUrl?: string; gpu?: string; vramGb?: number; sparseAttention?: boolean; profile?: "full" | "lite";
  deadline?: number; live?: boolean | null; liveError?: string | null;
  job?: { state: "running" | "done" | "failed"; error?: string } | null };
type Scene = { runId: string; index: number; fingerprint: string; media: "image" | "video"; ready: boolean };
const card = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 };
const field = { width: "100%", background: "var(--bg-deep)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 8, padding: 10 };
const button = { padding: "12px 18px", borderRadius: 8, border: 0, background: "var(--accent)", color: "white", cursor: "pointer" };

/** Connects a Colab/Kaggle notebook (workers/ltx-notebook) as the GPU for LTX video scenes. */
export default function NotebookGpu({ scene, onGenerated }: { scene?: Scene; onGenerated: () => void }) {
  const [status, setStatus] = useState<Status>({ connected: false });
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [jobKey, setJobKey] = useState<string | null>(null);

  async function refresh(check = false) {
    try {
      const query = new URLSearchParams();
      if (check) query.set("check", "1");
      if (jobKey) query.set("job", jobKey);
      const response = await fetch(`/api/tools/ltx-notebook?${query}`, { cache: "no-store" });
      const data: Status = await response.json();
      setStatus(data);
      if (data.job && data.job.state !== "running" && jobKey) {
        setJobKey(null);
        setMessage(data.job.state === "done" ? "Clipe gerado no notebook e aplicado à cena. Use Resume run para continuar a montagem."
          : `O notebook falhou: ${data.job.error ?? "erro desconhecido"}. Veja a saída da célula do ComfyUI no notebook.`);
        onGenerated();
      }
    } catch { /* Keep the last known state; the next poll retries. */ }
  }
  useEffect(() => { void refresh(true); }, []);
  useEffect(() => {
    if (!jobKey) return;
    const timer = setInterval(() => { void refresh(); }, 4000);
    return () => clearInterval(timer);
  }, [jobKey]);

  async function post(body: Record<string, unknown>) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/tools/ltx-notebook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Falha ao falar com o notebook.");
      return data;
    } catch (e) { setMessage((e as Error).message); return null; } finally { setBusy(false); }
  }
  async function connect() {
    const data = await post({ action: "connect", url, token });
    if (data) { setToken(""); setMessage(`Conectado: ${data.gpu}.`); await refresh(); }
  }
  async function disconnect() { if (await post({ action: "disconnect" })) await refresh(); }
  async function generate() {
    if (!scene) return;
    const data = await post({ action: "generate", runId: scene.runId, index: scene.index, fingerprint: scene.fingerprint });
    if (data) { setJobKey(data.job); setMessage("Gerando no notebook… uma cena leva alguns minutos."); }
  }

  return <section style={{ ...card, marginBottom: 20 }}>
    <h2>GPU do Colab ou Kaggle</h2>
    <p>Rode <code>workers/ltx-notebook/conveyer_ltx_notebook.ipynb</code> no Colab ou Kaggle e cole aqui o endereço e o token da última célula.
      Com o notebook conectado, as cenas de vídeo LTX de um run são geradas nele automaticamente (uma por vez), sem pausar.
      Não há cobrança por hora nossa: o tempo de GPU é a cota da sua conta no Colab/Kaggle, e você encerra o notebook quando quiser.</p>
    {status.connected ? <>
      <p><b>Conectado</b> · {status.gpu} · {status.vramGb?.toFixed(0)} GB · {status.baseUrl}
        {status.profile === "lite" ? " · perfil leve: LTX-Video 2B a 832×480, ampliado para 1080p (qualidade menor)"
          : status.sparseAttention === false && " · sem sol-attn (2ª etapa densa, mais lenta)"}</p>
      {status.live === false && <p role="alert" style={{ color: "#d85c5c" }}>Notebook inacessível agora: {status.liveError}</p>}
      {status.live === true && <p>Notebook respondendo.</p>}
      <p>
        <button style={button} disabled={busy} onClick={() => refresh(true)}>Testar conexão</button>{" "}
        <button style={{ ...button, background: "var(--surface-2, #555)" }} disabled={busy || Boolean(jobKey)} onClick={disconnect}>Desconectar</button>
      </p>
      {scene?.media === "video" && <p>
        <button style={button} disabled={busy || Boolean(jobKey)} onClick={generate}>
          {jobKey ? "Gerando no notebook…" : scene.ready ? "Gerar de novo esta cena no notebook" : "Gerar esta cena no notebook"}
        </button>
      </p>}
    </> : <>
      <label htmlFor="nb-url">Endereço do túnel (https://….trycloudflare.com)</label>
      <input id="nb-url" style={{ ...field, margin: "6px 0 12px" }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://exemplo.trycloudflare.com" />
      <label htmlFor="nb-token">Token</label>
      <input id="nb-token" type="password" autoComplete="off" style={{ ...field, margin: "6px 0 12px" }} value={token} onChange={(e) => setToken(e.target.value)} />
      <button style={button} disabled={busy || !url.trim() || !token.trim()} onClick={connect}>{busy ? "Conectando…" : "Conectar notebook"}</button>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}

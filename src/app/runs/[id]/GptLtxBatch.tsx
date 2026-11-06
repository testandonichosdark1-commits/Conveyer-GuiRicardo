"use client";
import { useEffect, useState } from "react";
type State = { batch: { id: string }; configured: boolean; concurrency: number; videosPending: number; scenesReady: number; scenesTotal: number;
  jobs: { id: string; index: number; description: string; phase: string; imageUrl: string | null; error?: string; recoverable: boolean }[] };
export default function GptLtxBatch({ runId }: { runId: string }) {
  const [state, setState] = useState<State | null>(null), [busy, setBusy] = useState(false), [approved, setApproved] = useState(false), [error, setError] = useState("");
  const storage = `conveyer-gpt-batch:${runId}`;
  useEffect(() => { const id = localStorage.getItem(storage); if (id) fetch(`/api/tools/ltx-image-batch?id=${id}`).then(r => r.json()).then(s => { if (s.error) setError(s.error); else setState(s); }).catch(() => setError("Não foi possível carregar o lote.")); }, [storage]);
  useEffect(() => {
    if (!state || state.scenesReady === state.scenesTotal) return;
    const timer = setInterval(() => { fetch(`/api/tools/ltx-image-batch?id=${state.batch.id}`).then(r => r.json()).then(s => { if (s.error) setError(s.error); else setState(s); }).catch(() => {}); }, 3000);
    return () => clearInterval(timer);
  }, [state]);
  async function act(action: string, jobId?: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/tools/ltx-image-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, runId, id: state?.batch.id, jobId, confirmed: approved, approvedIds: state?.jobs.filter(j => j.phase === "prepared").map(j => j.id) }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      setState(result); setApproved(false); localStorage.setItem(storage, result.batch.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha no lote."); } finally { setBusy(false); }
  }
  const pending = state?.jobs.filter(j => j.phase === "prepared").length || 0;
  return <div className="card" style={{ marginBottom: 14 }}>
    <h2>Imagens GPT + vídeos LTX</h2>
    <p className="muted">Prepare as imagens deste roteiro. Após sua aprovação, até quatro serão geradas ao mesmo tempo. A GPU precisa de outra autorização e de um limite de gasto.</p>
    {!state && <button className="btn-secondary" disabled={busy} onClick={() => act("prepare")}>Preparar lote — sem gerar</button>}
    {state && <>
      <button className="btn-secondary" disabled={busy || state.jobs.some(j => ["reserved", "generating"].includes(j.phase))} onClick={() => act("prepare")}>Atualizar lote — sem gerar</button>
      <p>{state.scenesReady}/{state.scenesTotal} cenas prontas · {state.videosPending} vídeos LTX pendentes</p>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {state.jobs.map(job => <div key={job.id} style={{ border: "1px solid var(--border)", padding: 12, borderRadius: 8 }}>
          <strong>Cena {job.index + 1}</strong><p style={{ fontSize: 12 }}>{job.description}</p>
          {job.imageUrl && <img src={job.imageUrl} alt={`Cena ${job.index + 1}`} style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover" }} />}
          <p>{({ prepared: "Aguardando aprovação", reserved: "Na fila", generating: "Gerando", complete: "Imagem pronta", "needs-recovery": "Recuperação necessária" } as Record<string, string>)[job.phase]}</p>
          {job.error && <p className="faint">{job.error}</p>}
          {job.recoverable && <button className="btn-secondary" disabled={busy} onClick={() => act("recover", job.id)}>Recuperar — sem reenviar</button>}
          {job.phase === "complete" && <button className="btn-secondary" disabled={busy} onClick={() => act("apply", job.id)}>Aplicar imagem salva</button>}
        </div>)}
      </div>
      {pending > 0 && <div style={{ marginTop: 16 }}>
        <label><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} /> Autorizo gerar estas {pending} imagens usando a cota da minha conta GPT.</label>
        <div style={{ marginTop: 10 }}><button className="btn" disabled={busy || !approved || !state.configured} onClick={() => act("generate")}>Gerar {pending} imagens — até 4 em paralelo</button></div>
        {!state.configured && <p>Configure a conta exclusiva antes de gerar.</p>}
      </div>}
      {state.videosPending > 0 && <p><a href={`/tools/ltx-scene-test?runId=${encodeURIComponent(runId)}`}>Preparar vídeos LTX e revisar autorização da GPU</a></p>}
      {state.scenesReady === state.scenesTotal && <p>As cenas estão prontas. Use Resume run para continuar a montagem com os arquivos salvos.</p>}
    </>}
    {error && <p role="alert" style={{ color: "#f87171" }}>{error}</p>}
  </div>;
}

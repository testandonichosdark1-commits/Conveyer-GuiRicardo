"use client";
import { useEffect, useState } from "react";
type Target = { runId: string; index: number; fingerprint: string; prompt: string; imageDescription?: string };
type Job = { id: string; phase: string; prompt: string; description: string; imageUrl?: string; error?: string; threadId?: string };
export default function CodexSceneImage({ target, onImage, onBusy }: { target: Target; onImage: (file: File) => void; onBusy: (busy: boolean) => void }) {
  const [description, setDescription] = useState(target.imageDescription || target.prompt);
  const [job, setJob] = useState<Job | null>(null);
  const [configured, setConfigured] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const storageKey = `conveyer-codex-image:${target.runId}:${target.index}:${target.fingerprint}`;
  const generating = Boolean(job && ["reserved", "generating"].includes(job.phase));
  useEffect(() => {
    let active = true;
    void fetch("/api/tools/ltx-images", { cache: "no-store" }).then(r => r.json()).then(data => { if (active) setConfigured(data.configured); }).catch(() => {});
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && /^[a-f0-9]{64}$/.test(saved)) void fetch(`/api/tools/ltx-images?id=${saved}`, { cache: "no-store" }).then(async r => {
        if (!r.ok) return;
        const data = await r.json(); if (active) { setJob(data); setDescription(data.description); }
      });
    } catch {}
    return () => { active = false; };
  }, [storageKey]);
  useEffect(() => { onBusy(busy || generating); return () => onBusy(false); }, [busy, generating, onBusy]);
  useEffect(() => {
    if (!generating || !job) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/tools/ltx-images?id=${job.id}`, { cache: "no-store" });
        if (r.ok) { const data = await r.json(); if (active) setJob(data); }
      } catch { /* Polling never resubmits a prompt. */ }
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [generating, job?.id]);
  async function act(action: "prepare" | "generate" | "recover" | "apply") {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/tools/ltx-images", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(
        action === "prepare" ? { action, runId: target.runId, index: target.index, fingerprint: target.fingerprint, description }
          : { action, id: job?.id, confirmed }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error || "Não foi possível concluir esta etapa.");
      if (action === "apply") {
        const image = await fetch(job!.imageUrl!, { cache: "no-store" });
        if (!image.ok) throw new Error("Imagem salva, mas não foi possível carregar a prévia. Tente aplicar novamente, sem gerar.");
        onImage(new File([await image.blob()], "imagem-cena.png", { type: "image/png" }));
        setError("Imagem selecionada. Use Preparar sem cobrança para conferir o fluxo.");
      } else {
        setJob(data); setConfirmed(false);
        try { localStorage.setItem(storageKey, data.id); } catch {}
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const style = { padding: "10px 16px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-1)", color: "var(--fg)", cursor: "pointer" };
  return <section style={{ border: "1px solid var(--border)", padding: 16, borderRadius: 8, margin: "18px 0" }}>
    <h2>Imagem da cena pelo ChatGPT</h2>
    <p>Use a descrição do roteiro com o estilo amador aprovado. Preparar o prompt não gera imagens.</p>
    <label htmlFor="codex-description">O que esta imagem deve mostrar</label>
    <textarea id="codex-description" rows={4} maxLength={6000} value={description} disabled={busy || generating}
      onChange={e => { setDescription(e.target.value); setJob(null); setConfirmed(false); }}
      style={{ width: "100%", padding: 10, background: "var(--bg-deep)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 8 }} />
    {!target.imageDescription && <p>Esta cena foi preparada antes da integração. Confira a descrição e remova instruções de estilo antigas, se houver.</p>}
    <p><button style={style} disabled={!description.trim() || busy || generating} onClick={() => act("prepare")}>Preparar prompt — sem geração</button></p>
    {job && <>
      <details><summary>Ver prompt completo</summary><p style={{ whiteSpace: "pre-wrap" }}>{job.prompt}</p></details>
      {job.phase === "prepared" && <>
        <p>A geração usa os limites da sua assinatura ChatGPT. Uma imagem por autorização, sem repetição automática. Nenhuma GPU será iniciada.</p>
        {!configured && <p>A conta exclusiva do ChatGPT ainda não está configurada neste computador.</p>}
        <label><input type="checkbox" checked={confirmed} disabled={busy || !configured} onChange={e => setConfirmed(e.target.checked)} /> Autorizo gerar esta única imagem usando minha assinatura.</label>
        <p><button style={style} disabled={!confirmed || !configured || busy} onClick={() => act("generate")}>Gerar uma imagem</button></p>
      </>}
      {generating && <p role="status">Gerando a imagem. Atualizar a página não envia outro prompt.</p>}
      {job.phase === "needs-recovery" && <p role="status">{job.error}</p>}
      {job.threadId && job.phase !== "complete" && <p><button style={style} disabled={busy} onClick={() => act("recover")}>Recuperar resultado — sem gerar novamente</button></p>}
      {job.imageUrl && <>
        <img src={job.imageUrl} alt="Imagem gerada para conferir antes de animar" style={{ width: "100%", borderRadius: 8, marginTop: 12 }} />
        <p><button style={style} disabled={busy} onClick={() => act("apply")}>Usar esta imagem na cena — sem gerar</button>{" "}<a href={job.imageUrl} download="imagem-cena.png">Salvar imagem</a></p>
        <p>A animação no LTX exige autorização separada.</p>
      </>}
    </>}
    {error && <p role="status">{error}</p>}
  </section>;
}

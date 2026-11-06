"use client";

import { useEffect, useState } from "react";
import { LTX_PROFILE } from "@/lib/services/ltx/workflow";
import CodexSceneImage from "./CodexSceneImage";
import NotebookGpu from "./NotebookGpu";

type Prepared = { imageDataUrl: string; workflow: unknown; externalCalls: number; imageApplied?: boolean };
type QueuedScene = { runId: string; title: string; index: number; prompt: string; imageDescription?: string; fingerprint: string; media: "image" | "video"; durationSec: number; ready: boolean };
type Job = { id: string; phase: string; stoppedVerified: boolean; error?: string; videoUrl?: string; attached?: { runId: string }; target?: { runId: string } };
const card = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 };
const field = { width: "100%", background: "var(--bg-deep)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 8, padding: 10 };
const button = { padding: "12px 18px", borderRadius: 8, border: 0, background: "var(--accent)", color: "white", cursor: "pointer" };

export default function LtxSceneTestPage() {
  const [scenes, setScenes] = useState<QueuedScene[]>([]);
  const [sceneKey, setSceneKey] = useState("");
  const selectedScene = scenes.find((s) => `${s.runId}:${s.index}` === sceneKey);
  async function refreshScenes() {
    try { const r = await fetch("/api/tools/ltx-scenes", { cache: "no-store" }); if (r.ok) {
      const all: QueuedScene[] = (await r.json()).scenes;
      const runId = new URLSearchParams(window.location.search).get("runId");
      const next = runId ? all.filter(s => s.runId === runId && s.media === "video") : all;
      setScenes(next);
      if (runId && !sceneKey && next.length) { setSceneKey(`${next[0].runId}:${next[0].index}`); setPrompt(next[0].prompt); }
    } } catch {}
  }
  useEffect(() => { void refreshScenes(); }, []);
  const [image, setImage] = useState<File | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [prompt, setPrompt] = useState("Preserve the scene shown in the input image. The camera remains almost stationary. Natural subtle movement. No speech, no music.");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [error, setError] = useState("");
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    let active = true;
    try {
      const savedId = localStorage.getItem("conveyer-ltx-last-test-v1");
      if (savedId && /^[a-zA-Z0-9_-]{8,80}$/.test(savedId)) setJob({ id: savedId, phase: "waiting", stoppedVerified: false });
    } catch { /* Storage may be unavailable. */ }
    async function refresh() {
      try {
        const response = await fetch("/api/tools/ltx-scene-test", { cache: "no-store" });
        const data = await response.json();
        if (active) setApprovalId(data.ready ? data.approvalId : null);
      } catch { if (active) setApprovalId(null); }
    }
    void refresh(); const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!job || job.phase === "complete" || (job.phase === "failed" && job.stoppedVerified)) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/tools/ltx-scene-test?id=${encodeURIComponent(job.id)}`, { cache: "no-store" });
        if (response.ok) { const data = await response.json(); if (active) setJob(data); }
        else if (response.status === 404 && active) {
          setJob(null); setError("O teste salvo não foi encontrado nesta instalação.");
          try { localStorage.removeItem("conveyer-ltx-last-test-v1"); } catch {}
        }
      } catch { /* A network interruption must never resubmit a paid prompt. */ }
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [job]);

  async function submit(action: "prepare" | "generate") {
    if (!image) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      if (selectedScene) {
        form.append("runId", selectedScene.runId); form.append("index", String(selectedScene.index));
        form.append("fingerprint", selectedScene.fingerprint);
      }
      form.append("image", image); form.append("prompt", prompt); form.append("action", action);
      if (action === "generate") { form.append("confirmPaid", String(confirmed)); form.append("approvalId", approvalId ?? ""); }
      const response = await fetch("/api/tools/ltx-scene-test", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Não foi possível executar o teste.");
      if (action === "prepare") { setPrepared(data); void refreshScenes(); } else {
        setJob(data); setConfirmed(false);
        try { localStorage.setItem("conveyer-ltx-last-test-v1", data.id); } catch {}
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function useSavedImage() {
    if (!selectedScene) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/tools/ltx-scenes?input=1&runId=${encodeURIComponent(selectedScene.runId)}&index=${selectedScene.index}&fingerprint=${selectedScene.fingerprint}`);
      if (!response.ok) throw new Error("Aplique a imagem GPT à cena antes de continuar.");
      setImage(new File([await response.blob()], "imagem-gpt-salva.png", { type: "image/png" })); setPrepared(null); setConfirmed(false);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function applyClip() {
    if (!job) return;
    try {
      const response = await fetch("/api/tools/ltx-scenes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.id }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setJob({ ...job, attached: job.target }); void refreshScenes();
    } catch (e) { setError((e as Error).message); }
  }
  async function importVideo() {
    if (!selectedScene || !videoFile) return;
    setUploadBusy(true); setError(""); setUploadMessage("");
    try {
      const query = new URLSearchParams({
        runId: selectedScene.runId, index: String(selectedScene.index), fingerprint: selectedScene.fingerprint,
      });
      const response = await fetch(`/api/tools/ltx-scenes/import?${query}`, {
        method: "POST",
        headers: {
          "Content-Type": "video/mp4",
          "x-replace-existing": String(replaceConfirmed),
        },
        body: videoFile,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Não foi possível importar o vídeo.");
      setVideoFile(null); setReplaceConfirmed(false);
      setUploadMessage("Vídeo importado e associado à cena. Use Resume run para continuar a montagem.");
      await refreshScenes();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível importar o vídeo.");
    } finally {
      setUploadBusy(false);
    }
  }
  function downloadWorkflow() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(prepared?.workflow, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "workflow.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function stop() {
    if (!job) return;
    try {
      const form = new FormData(); form.append("action", "stop"); form.append("approvalId", job.id);
      const response = await fetch("/api/tools/ltx-scene-test", { method: "POST", body: form });
      if (!response.ok) throw new Error("Confira a GPU no Runpod e solicite a parada.");
      setError("Parada solicitada; aguardando confirmação do Runpod.");
    } catch (e) { setError((e as Error).message); }
  }
  const generating = Boolean(job && !["complete", "failed"].includes(job.phase));
  return <main style={{ maxWidth: 900, margin: "0 auto", padding: "30px 20px" }}>
    <h1>Cenas do Conveyer · LTX</h1>
    <p><a href="/tools/ltx-script">Começar com um roteiro ou trecho →</a></p>
    <p>Escolha uma imagem e descreva o movimento. Preparar é gratuito e acontece neste computador.</p>
    <section style={{ ...card, marginBottom: 20 }}>
      <h2>Escolha a cena do vídeo</h2>
      <p>Selecione LTX nas configurações do Conveyer. As cenas pendentes aparecem aqui quando o vídeo é preparado.</p>
      <label htmlFor="ltx-scene">Cena</label>
      <select id="ltx-scene" style={field} value={sceneKey} disabled={generating || imageBusy} onChange={(e) => {
        setSceneKey(e.target.value); setImage(null); setPrepared(null); setConfirmed(false);
        setVideoFile(null); setReplaceConfirmed(false); setUploadMessage(""); setError("");
        const next = scenes.find((s) => `${s.runId}:${s.index}` === e.target.value);
        if (next) setPrompt(next.prompt);
      }}>
        <option value="">Teste avulso — sem aplicar a um vídeo</option>
        {scenes.map((s) => <option key={`${s.runId}:${s.index}`} value={`${s.runId}:${s.index}`}>
          {s.title} · cena {s.index} · {s.media === "image" ? "imagem" : "vídeo"}{s.ready ? " · pronta" : " · pendente"}
        </option>)}
      </select>
      <p><button style={button} disabled={generating || imageBusy} onClick={refreshScenes}>Atualizar cenas</button></p>
      {selectedScene && <p>{selectedScene.runId.startsWith("script-") ? "Esta cena pertence ao roteiro salvo. Os clipes e a narração podem ser montados na página do roteiro." : "Esta cena será aplicada ao vídeo escolhido."} {selectedScene.media === "image"
        ? "Pede uma imagem: preparar salva a imagem localmente, sem GPU."
        : selectedScene.runId.startsWith("script-") ? "O LTX gera um clipe de 6 segundos." : "O LTX gera 6 segundos; a montagem ajusta o clipe à duração da cena."}</p>}
      {!scenes.length && <p>Nenhuma cena LTX na fila. Você pode continuar usando o teste avulso.</p>}
    </section>
    <NotebookGpu scene={selectedScene} onGenerated={refreshScenes} />
    <section style={{ ...card, marginBottom: 20 }}>
      <h2>Importar vídeo gerado no Colab ou Kaggle</h2>
      <p>Gere o MP4 no notebook, baixe-o para este computador e associe-o a uma cena de vídeo pendente. A importação não inicia GPU nem gera cobranças.</p>
      {!selectedScene && <p>Selecione primeiro uma cena de vídeo na lista acima.</p>}
      {selectedScene && <>
        <p><b>Destino:</b> cena {selectedScene.index} · {selectedScene.title}</p>
        <label htmlFor="ltx-import-video">Arquivo de vídeo MP4 (até 256 MB; duração máxima de 120 segundos)</label>
        <input id="ltx-import-video" type="file" accept="video/mp4,.mp4" disabled={uploadBusy || generating}
          onChange={e => { setVideoFile(e.target.files?.[0] ?? null); setError(""); setUploadMessage(""); }}
          style={{ display: "block", margin: "12px 0" }} />
        {videoFile && <p>Selecionado: {videoFile.name} ({(videoFile.size / (1024 * 1024)).toFixed(1)} MB)</p>}
        {selectedScene.ready && <label>
          <input type="checkbox" checked={replaceConfirmed} disabled={uploadBusy || generating}
            onChange={e => setReplaceConfirmed(e.target.checked)} />
          Confirmo substituir o clipe que já está associado a esta cena.
        </label>}
        <p><button style={button} disabled={!videoFile || uploadBusy || generating || (selectedScene.ready && !replaceConfirmed)}
          onClick={importVideo}>{uploadBusy ? "Validando e importando…" : "Importar MP4 para esta cena"}</button></p>
      </>}
      {uploadMessage && <p role="status">{uploadMessage}</p>}
    </section>
    {selectedScene && <CodexSceneImage key={`${selectedScene.runId}:${selectedScene.index}:${selectedScene.fingerprint}`} target={selectedScene} onBusy={setImageBusy}
      onImage={file => { setImage(file); setPrepared(null); setConfirmed(false); void refreshScenes(); }} />}
    <section style={card}>
      <p><b>{LTX_PROFILE.model}</b> · 6 segundos · 1080p · GPU validada: {LTX_PROFILE.gpu}</p>
      <p>{selectedScene?.runId.startsWith("script-") ? "A narração pode ser gerada e montada na página do roteiro. O original gerado com áudio será preservado." : "A narração do Conveyer continuará como áudio principal. O original com áudio será preservado."}</p>
      <label htmlFor="ltx-image">Imagem da cena (PNG, JPG ou WebP, até 10 MB)</label>
      <input id="ltx-image" type="file" accept="image/png,image/jpeg,image/webp" disabled={generating || imageBusy} onChange={(e) => { setImage(e.target.files?.[0] ?? null); setPrepared(null); setConfirmed(false); }} style={{ display: "block", margin: "12px 0 20px" }} />
      {selectedScene && <p><button style={button} disabled={busy || generating || imageBusy} onClick={useSavedImage}>Usar imagem GPT já salva — sem gerar</button></p>}
      {image && <p>Imagem selecionada: {image.name}</p>}
      <label htmlFor="ltx-prompt">O que deve acontecer na cena</label>
      <textarea id="ltx-prompt" rows={5} maxLength={6000} disabled={generating || imageBusy} value={prompt} onChange={(e) => { setPrompt(e.target.value); setPrepared(null); setConfirmed(false); }} style={{ ...field, marginTop: 8 }} />
      <button style={{ ...button, marginTop: 15 }} disabled={!image || !prompt.trim() || busy || generating || imageBusy} onClick={() => submit("prepare")}>{busy ? "Preparando…" : "Preparar sem cobrança"}</button>
      {error && <p role="alert" style={{ color: "#d85c5c" }}>{error}</p>}
    </section>
    {prepared && <section style={{ ...card, marginTop: 20 }}>
      <h2>{prepared.imageApplied ? "Imagem aplicada à cena" : "Imagem e fluxo preparados"}</h2>
      <p>Nenhuma chamada externa. Nenhuma GPU iniciada.</p>
      <img src={prepared.imageDataUrl} alt="Imagem que será enviada ao LTX" style={{ width: "100%", borderRadius: 8 }} />
      <p><button style={button} onClick={downloadWorkflow}>Baixar JSON</button>{" "}<a download="entrada.png" href={prepared.imageDataUrl}>Baixar imagem preparada</a></p>
    </section>}
    <section style={{ ...card, marginTop: 20 }}>
      <h2>Geração paga</h2>
      {selectedScene?.media === "image" && <p>Esta cena pede somente uma imagem. A geração de vídeo está bloqueada.</p>}
      <p>Uma geração por autorização. Limite de US$ 2; parada antecipada em até 65 minutos, dentro do teto de 90 minutos.</p>
      <p>O Mac precisa permanecer ligado e conectado enquanto a GPU estiver ativa.</p>
      {!approvalId && <p><b>Bloqueada:</b> primeiro precisamos autorizar a rodada e verificar a parada automática. Esta página não cria nem inicia GPUs.</p>}
      <label><input type="checkbox" checked={confirmed} disabled={!approvalId || generating} onChange={(e) => setConfirmed(e.target.checked)} /> Confirmo esta única geração paga, dentro do limite informado.</label>
      <p><button style={button} disabled={!approvalId || !prepared || !confirmed || busy || generating || imageBusy || Boolean(job) || selectedScene?.media === "image"} onClick={() => submit("generate")}>Gerar uma cena — pago</button></p>
      {job && <div aria-live="polite">
        <p>{job.phase === "complete" ? "Clipe salvo; parada da GPU confirmada." : job.phase === "failed" ? "Teste interrompido." : "Teste em andamento. Não feche o Mac."}</p>
        {job.error && <p role="alert">{job.error}</p>}
        {job.phase === "failed" && !job.stoppedVerified && <p><b>A parada ainda não foi confirmada. Confira o Runpod imediatamente.</b></p>}
        {!job.stoppedVerified && <button style={button} onClick={stop}>Solicitar parada agora</button>}
        {job.attached && <p>Clipe aplicado à cena. <a href={job.attached.runId.startsWith("script-") ? `/tools/ltx-script/${job.attached.runId}` : `/runs/${job.attached.runId}`}>{job.attached.runId.startsWith("script-") ? "Abrir roteiro e montar clipes" : "Abrir vídeo e retomar"}</a></p>}
        {job.phase === "complete" && job.stoppedVerified && job.target && !job.attached && <p>
          <button style={button} onClick={applyClip}>Aplicar clipe à cena — sem cobrança</button>
        </p>}
        {job.videoUrl && <><video controls src={job.videoUrl} style={{ width: "100%" }} /><p><a href={job.videoUrl} download="scene_1080p.mp4">Salvar clipe</a></p></>}
        {job.stoppedVerified && <button style={button} onClick={() => {
          setJob(null); setConfirmed(false); setPrepared(null); void refreshScenes();
          try { localStorage.removeItem("conveyer-ltx-last-test-v1"); } catch {}
        }}>Preparar outro teste</button>}
      </div>}
    </section>
  </main>;
}

"use client";
import { useState, useEffect } from "react";
type Scene = { narration: string; description: string; motion: string };
const field = { width:"100%",padding:10,borderRadius:8,color:"var(--fg)",background:"var(--bg)",border:"1px solid var(--border)" };
const button = { padding:"12px 18px",marginTop:12,borderRadius:8,background:"var(--accent)",color:"white",border:0,cursor:"pointer" };
export default function ScriptPage() {
  const [script,setScript] = useState(""); const [title,setTitle] = useState(""); const [scenes,setScenes] = useState<Scene[]>([]);
  const [busy,setBusy] = useState(false); const [error,setError] = useState(""); const [saved,setSaved] = useState("");
  const [drafts,setDrafts] = useState<{id:string;title:string}[]>([]);
  useEffect(()=>{void fetch("/api/tools/ltx-script").then(r=>r.json()).then(d=>setDrafts(d.drafts || [])).catch(()=>{});},[]);
  async function act(action: string) {
    setBusy(true);setError("");
    try {
      const r = await fetch("/api/tools/ltx-script",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,script,title,scenes})});
      const d = await r.json(); if (!r.ok) throw new Error(d.error);
      if (action === "preview") {setScenes(d.scenes);setSaved("");} else setSaved(d.id);
    } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  }
  function edit(i: number,key: keyof Scene,value: string) {setScenes(s => s.map((v,n)=>n===i?{...v,[key]:value}:v));}
  return <main style={{maxWidth:900,margin:"0 auto",padding:30}}>
    <h1>Roteiro → imagens GPT → vídeos LTX</h1>
    <p>Cole um roteiro ou um trecho. Preparar e salvar as cenas acontece neste computador, sem geração ou GPU.</p>
    <label>Título<input style={field} value={title} maxLength={160} disabled={busy || !!saved} onChange={e=>setTitle(e.target.value)}/></label>
    <label>Roteiro<textarea style={field} rows={10} value={script} maxLength={30000} disabled={busy || !!saved} onChange={e=>{setScript(e.target.value);setScenes([]);}}/></label>
    <button style={button} disabled={busy || !script.trim() || !!saved} onClick={()=>act("preview")}>Preparar cenas — sem geração</button>
    {!!scenes.length && <><h2>Revise as {scenes.length} cenas</h2><p>A divisão é local, por frases. A descrição começa com o trecho original: ajuste para uma ação visual concreta antes de salvar. Não há consulta a um modelo nesta etapa.</p>
      {scenes.map((s,i)=><section key={i} style={{border:"1px solid var(--border)",padding:16,marginBottom:16,borderRadius:10}}>
        <h3>Cena {i+1} · clipe de 6 segundos</h3><p>{s.narration}</p>
        <label>O que a imagem deve mostrar<textarea style={field} rows={3} value={s.description} maxLength={6000} disabled={busy || !!saved} onChange={e=>edit(i,"description",e.target.value)}/></label>
        <label>Movimento no vídeo<textarea style={field} rows={2} value={s.motion} maxLength={6000} disabled={busy || !!saved} onChange={e=>edit(i,"motion",e.target.value)}/></label>
      </section>)}
      {!saved && <button style={button} disabled={busy || scenes.some(s=>!s.description.trim() || !s.motion.trim())} onClick={()=>act("save")}>Salvar cenas para revisão e geração</button>}
    </>}
    {!!drafts.length && <section><h2>Roteiros salvos</h2>{drafts.map(d=><p key={d.id}><a href={`/tools/ltx-script/${d.id}`}>{d.title}</a></p>)}</section>}
    {error && <p role="alert">{error}</p>}
    {saved && <section><h2>Cenas salvas</h2><p>Nenhuma imagem ou vídeo foi gerado. Abra a lista e escolha uma cena deste título. Autorize uma imagem por vez; a animação exige autorização separada e GPU com parada verificada.</p>
      <a href="/tools/ltx-scene-test">Abrir cenas e gerar imagens GPT</a>
      <p><a href={`/tools/ltx-script/${saved}`}>Ver progresso e montar clipes prontos</a></p>
      <button style={button} onClick={()=>{setSaved("");setScenes([]);setScript("");setTitle("");}}>Preparar outro roteiro</button>
    </section>}
  </main>;
}

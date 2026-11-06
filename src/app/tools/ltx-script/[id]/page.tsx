"use client";
import { use, useEffect, useState } from "react";
type Audio = {fingerprint:string;voiceName:string;speed:number;state:string;durationSec?:number;credits?:number|null;error?:string;jobId?:string};
type Draft = {id:string;title:string;scenes:{index:number;narration:string;ready:boolean;audio:Audio|null;audioReady:boolean}[];ready:boolean;narrationReady:boolean;videoUrl:string|null;narratedUrl:string|null};
const button = "rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed";
const status: Record<string,string> = {prepared:"Preparada, aguardando autorização",submitting:"Envio iniciado",running:"Em geração",complete:"Pronta",unknown:"Resposta perdida — conferir resultado existente",failed:"Falhou — conferir histórico"};
export default function DraftPage({params}:{params:Promise<{id:string}>}) {
  const {id}=use(params);
  const [draft,setDraft]=useState<Draft|null>(null), [busy,setBusy]=useState(false), [error,setError]=useState("");
  const [approvals,setApprovals]=useState<Record<number,string>>({});
  async function load() {
    try {const r=await fetch(`/api/tools/ltx-script?id=${id}`,{cache:"no-store"}); const d=await r.json();if(!r.ok)throw new Error(d.error);setDraft(d);}catch(e){setError((e as Error).message);}
  }
  useEffect(()=>{void load();},[id]);
  async function action(action:string,extra:Record<string,unknown>={}) {
    setBusy(true);setError("");
    try {
      const r=await fetch("/api/tools/ltx-script",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,id,...extra})});
      const d=await r.json();if(!r.ok)throw new Error(d.error);
      if(action === "generate-narration") setApprovals({});
      await load();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <main className="mx-auto max-w-4xl space-y-5 p-8">
    <h1 className="text-2xl font-semibold">{draft?.title || "Roteiro salvo"}</h1>
    <p>Confira as cenas, prepare a narração no AI33 Pro e monte o vídeo neste computador. A geração de voz consome créditos e exige autorização por cena.</p>
    <button className={button} disabled={busy} onClick={()=>{setError("");void load();}}>Atualizar progresso</button>
    {draft && <>
      <p>{draft.scenes.filter(s=>s.ready).length} de {draft.scenes.length} clipes prontos · {draft.scenes.filter(s=>s.audioReady).length} narrações prontas.</p>
      {draft.scenes.map(s=><section key={s.index} className="space-y-3 rounded-lg border border-[var(--border)] p-4">
        <h2 className="font-semibold">Cena {s.index} · clipe {s.ready?"pronto":"pendente"}</h2>
        <p>{s.narration}</p>
        <button className={button} disabled={busy} onClick={()=>void action("prepare-narration",{index:s.index})}>Preparar narração — sem geração</button>
        {s.audio && <>
          <p>AI33 Pro · voz: {s.audio.voiceName} · velocidade: {s.audio.speed} · {s.narration.length} caracteres</p>
          <p>Narração: {status[s.audio.state] || s.audio.state}{s.audio.durationSec ? ` · ${s.audio.durationSec.toFixed(2)} segundos` : ""}</p>
          {s.audio.state === "prepared" && <>
            <p>Uma única solicitação para esta cena. O custo exato ainda não foi informado pelo fornecedor; confira sua tarifa antes de autorizar. Não haverá repetição automática.</p>
            <label className="flex items-start gap-2"><input type="checkbox" checked={approvals[s.index]===s.audio.fingerprint} onChange={e=>setApprovals({...approvals,[s.index]:e.target.checked?s.audio!.fingerprint:""})}/>Autorizo gerar somente esta narração no AI33 Pro, consumindo os créditos correspondentes.</label>
            <button className={button} disabled={busy || approvals[s.index]!==s.audio.fingerprint} onClick={()=>void action("generate-narration",{index:s.index,fingerprint:s.audio!.fingerprint,confirmed:true})}>Gerar uma narração no AI33 Pro</button>
          </>}
          {s.audio.state !== "prepared" && !s.audioReady && <button className={button} disabled={busy} onClick={()=>void action("recover-narration",{index:s.index})}>Consultar resultado existente — sem nova geração</button>}
          {s.audio.error && <p role="alert">{s.audio.error}</p>}
          {s.audioReady && <audio controls className="w-full" src={`/api/tools/ltx-script?id=${id}&audio=${s.index}`}/>}
          {s.audio.state !== "prepared" && <p>Créditos informados pelo AI33 Pro: {s.audio.credits ?? "ainda não informados; conferir saldo no fornecedor"}.</p>}
        </>}
      </section>)}
      {!draft.ready && <p>Conclua os clipes pendentes antes de montar. Nenhuma cena será ignorada.</p>}
      <p><a href="/tools/ltx-scene-test">Abrir geração de cenas</a></p>
      <div className="flex flex-wrap gap-3">
        <button className={button} disabled={busy || !draft.ready} onClick={()=>void action("assemble")}>{busy?"Processando…":"Montar sem narração — sem cobrança"}</button>
        <button className={button} disabled={busy || !draft.ready || !draft.narrationReady} onClick={()=>void action("assemble",{narrated:true})}>Montar com narração — sem cobrança</button>
      </div>
      <p>Na versão narrada, cada cena dura o tempo de sua fala. Se a fala ultrapassar o clipe, a imagem final fica parada até a próxima cena. A voz mantém sua velocidade.</p>
      {draft.narratedUrl && <section className="space-y-3"><h2 className="text-lg font-semibold">Vídeo com narração</h2><video controls className="w-full" src={draft.narratedUrl}/><a href={draft.narratedUrl} download="roteiro-narrado.mp4">Salvar vídeo com narração</a></section>}
      {draft.videoUrl && <section className="space-y-3"><h2 className="text-lg font-semibold">Montagem sem narração</h2><video controls className="w-full" src={draft.videoUrl}/><a href={draft.videoUrl} download="roteiro-clipes.mp4">Salvar montagem sem narração</a></section>}
    </>}
    {error && <p role="alert">{error}</p>}
  </main>;
}

import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { draftProgress, assembleDraft, assembledFile } from "@/lib/services/ltx/script-assembly";
import { listDrafts } from "@/lib/services/ltx/script-drafts";
import { splitScript, createDraft } from "@/lib/services/ltx/script-drafts";
import { prepareNarration, generateNarration, recoverNarration, narrationFile } from "@/lib/services/ltx/script-narration";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const url = new URL(req.url), id = url.searchParams.get("id");
    if(!id) return NextResponse.json({ drafts:await Promise.all((await listDrafts()).map(d=>draftProgress(d.id))) });
    if (url.searchParams.has("audio")) {
      const { file } = await narrationFile(id, Number(url.searchParams.get("audio")));
      return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream,{headers:{"Content-Type":"audio/wav","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    }
    if(url.searchParams.get("asset") === "1") {
      const file = await assembledFile(id, url.searchParams.get("narrated") === "1"), stat = await fs.stat(file);
      const range = req.headers.get("range");
      let start = 0, end = stat.size-1;
      if(range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if(!m || (!m[1] && !m[2])) return new Response(null,{status:416,headers:{"Content-Range":`bytes */${stat.size}`}});
        if(!m[1]) start=Math.max(0,stat.size-Number(m[2]));
        else { start=Number(m[1]);if(m[2]) end=Math.min(end,Number(m[2])); }
        if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end || start>=stat.size) return new Response(null,{status:416,headers:{"Content-Range":`bytes */${stat.size}`}});
      }
      const headers: Record<string,string> = {"Content-Type":"video/mp4","Accept-Ranges":"bytes","Content-Length":String(end-start+1),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
      if(range) headers["Content-Range"]=`bytes ${start}-${end}/${stat.size}`;
      return new Response(Readable.toWeb(createReadStream(file,{start,end})) as ReadableStream,{status:range?206:200,headers});
    }
    return NextResponse.json(await draftProgress(id));
  } catch { return NextResponse.json({error:"Roteiro ou montagem indisponível."},{status:404}); }
}
export async function POST(req: Request) {
  if (req.headers.get("Origin") !== new URL(req.url).origin) return NextResponse.json({ error: "Abra no Conveyer." }, { status:403 });
  try {
    const reader = req.body?.getReader(); if (!reader) throw new Error("Pedido vazio.");
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 100000) throw new Error("Pedido muito grande."); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const text = Buffer.concat(chunks).toString("utf8");
    const data = JSON.parse(text);
    if (data.action === "assemble") return NextResponse.json(await assembleDraft(data.id, data.narrated === true));
    if (data.action === "prepare-narration") return NextResponse.json(await prepareNarration(data.id, data.index));
    if (data.action === "generate-narration") return NextResponse.json(await generateNarration(data.id, data.index, data.fingerprint, data.confirmed === true));
    if (data.action === "recover-narration") return NextResponse.json(await recoverNarration(data.id, data.index));
    if (data.action === "preview") return NextResponse.json({ scenes: splitScript(data.script) });
    if (data.action === "save") return NextResponse.json(await createDraft(data.title,data.scenes));
    throw new Error("Ação inválida.");
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Não foi possível preparar o roteiro." }, { status:400 }); }
}

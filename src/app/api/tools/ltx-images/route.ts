import path from "node:path";
import sharp from "sharp";
import { NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/data-dir";
import { resolveLtxTarget } from "@/lib/services/ltx/targets";
import { saveLtxImage } from "@/lib/services/ltx/pipeline";
import { prepareImageJob, readImageJob, reserveImageJob, executeImageJob, recoverImageJob, imageJobBytes } from "@/lib/services/codex-image-jobs";
import { codexImageConfigured, codexImageProfile, connectImageDriver } from "@/lib/services/codex-image-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const root = path.join(DATA_DIR, "codex-images", "jobs");
function publicJob(job: Awaited<ReturnType<typeof readImageJob>>) {
  return { ...job, imageUrl: job.phase === "complete" ? `/api/tools/ltx-images?id=${job.id}&asset=1` : null };
}
export async function GET(req: Request) {
  const url = new URL(req.url), id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ configured: await codexImageConfigured(), model: codexImageProfile().model });
  try {
    const job = await readImageJob(root, id);
    if (url.searchParams.get("asset") === "1") return new Response(new Uint8Array(await imageJobBytes(root, id)), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    return NextResponse.json(publicJob(job));
  } catch { return NextResponse.json({ error: "Imagem não encontrada ou ainda indisponível." }, { status: 404 }); }
}
async function body(req: Request) {
  const reader = req.body?.getReader(); if (!reader) throw new Error("Pedido inválido.");
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 32_000) throw new Error("Pedido muito grande."); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function POST(req: Request) {
  if (req.headers.get("Origin") !== new URL(req.url).origin) return NextResponse.json({ error: "Abra no Conveyer." }, { status: 403 });
  try {
    const data = await body(req);
    if (data.action === "prepare") {
      const target = await resolveLtxTarget(data.runId, data.index, data.fingerprint);
      const job = await prepareImageJob(root, { runId: target.runId, index: target.request.index, fingerprint: target.request.fingerprint }, data.description, codexImageProfile().model);
      return NextResponse.json(publicJob(job));
    }
    const job = await readImageJob(root, data.id);
    const target = await resolveLtxTarget(job.target.runId, job.target.index, job.target.fingerprint);
    if (data.action === "apply") {
      const png = await sharp(await imageJobBytes(root, job.id), { limitInputPixels: 40_000_000 }).resize(1920, 1080, { fit: "cover" }).png().toBuffer();
      await saveLtxImage(target.runDir, target.request.index, target.request.fingerprint, png);
      return NextResponse.json({ applied: true, media: target.request.media });
    }
    if (data.action === "recover") {
      const saved = await recoverImageJob(root, job.id, codexImageProfile().accountHome, connectImageDriver);
      return NextResponse.json(publicJob(saved));
    }
    if (data.action !== "generate") throw new Error("Ação inválida.");
    if (!(await codexImageConfigured())) throw new Error("Configure a conta exclusiva do ChatGPT antes de gerar.");
    const reserved = await reserveImageJob(root, job.id, data.confirmed);
    // Reserve before returning; no retry path can submit another turn for this job.
    void executeImageJob(root, job.id, codexImageProfile().accountHome, connectImageDriver).catch(() => {});
    return NextResponse.json(publicJob(reserved), { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Não foi possível preparar esta imagem." }, { status: 409 });
  }
}

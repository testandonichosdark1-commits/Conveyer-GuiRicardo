import path from "node:path";
import sharp from "sharp";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { DATA_DIR } from "@/lib/data-dir";
import { getRunDir } from "@/lib/run-paths";
import { listLtxScenes, saveLtxImage } from "@/lib/services/ltx/pipeline";
import { resolveLtxTarget } from "@/lib/services/ltx/targets";
import { prepareImageJob, readImageJob, executeImageJob, recoverImageJob, imageJobBytes, type ImageJob } from "@/lib/services/codex-image-jobs";
import { prepareImageBatch, readImageBatch, reserveImageBatch, type ImageBatch } from "@/lib/services/codex-image-batch";
import { codexImageConfigured, codexImageProfile, connectImageDriver } from "@/lib/services/codex-image-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const jobsRoot = path.join(DATA_DIR, "codex-images", "jobs");
const batchesRoot = path.join(DATA_DIR, "codex-images", "batches");
async function validate(job: ImageJob) {
  const target = await resolveLtxTarget(job.target.runId, job.target.index, job.target.fingerprint);
  if ((target.request.imageDescription || target.request.prompt).trim() !== job.description.trim()) throw new Error("A descrição da cena mudou. Prepare novamente sem reenviar o lote anterior.");
}
async function apply(job: ImageJob) {
  const target = await resolveLtxTarget(job.target.runId, job.target.index, job.target.fingerprint);
  const png = await sharp(await imageJobBytes(jobsRoot, job.id), { limitInputPixels: 40_000_000 }).resize(1920, 1080, { fit: "cover" }).png().toBuffer();
  await saveLtxImage(target.runDir, target.request.index, target.request.fingerprint, png);
}
async function state(batch: ImageBatch) {
  const jobs = await Promise.all(batch.jobs.map(id => readImageJob(jobsRoot, id)));
  await Promise.all(jobs.map(validate));
  const scenes = await listLtxScenes(getRunDir(batch.runId));
  return { batch, configured: await codexImageConfigured(), concurrency: 4,
    jobs: jobs.map(job => ({ id: job.id, index: job.target.index, description: job.description, phase: job.phase, error: job.error,
      recoverable: Boolean(job.threadId) && ["generating", "needs-recovery"].includes(job.phase),
      imageUrl: job.phase === "complete" ? `/api/tools/ltx-images?id=${job.id}&asset=1` : null })),
    videosPending: scenes.filter(s => s.media === "video" && !s.ready).length,
    scenesReady: scenes.filter(s => s.ready).length, scenesTotal: scenes.length };
}
export async function GET(req: Request) {
  try { return NextResponse.json(await state(await readImageBatch(batchesRoot, new URL(req.url).searchParams.get("id") || ""))); }
  catch { return NextResponse.json({ error: "Lote indisponível ou cenas alteradas. Prepare novamente." }, { status: 409 }); }
}
export async function POST(req: Request) {
  if (req.headers.get("Origin") !== new URL(req.url).origin) return NextResponse.json({ error: "Abra no Conveyer." }, { status: 403 });
  try {
    const text = await req.text(); if (text.length > 100_000) throw new Error("Pedido muito grande.");
    const data = JSON.parse(text);
    if (data.action === "prepare") {
      if (typeof data.runId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(data.runId)) throw new Error("Vídeo inválido.");
      const run = db.prepare("SELECT config_json FROM runs WHERE id = ? AND deleted_at IS NULL").get(data.runId) as { config_json: string } | undefined;
      if (!run || JSON.parse(run.config_json || "{}").aiProvider !== "ltx") throw new Error("Este vídeo não selecionou GPT + LTX.");
      const scenes = (await listLtxScenes(getRunDir(data.runId))).filter(s => !s.ready);
      if (!scenes.length) throw new Error("Nenhuma cena pendente.");
      const jobs = [];
      for (const scene of scenes) jobs.push(await prepareImageJob(jobsRoot, { runId: data.runId, index: scene.index, fingerprint: scene.fingerprint }, scene.imageDescription || scene.prompt, codexImageProfile().model));
      return NextResponse.json(await state(await prepareImageBatch(batchesRoot, data.runId, jobs.map(j => j.id))));
    }
    const batch = await readImageBatch(batchesRoot, data.id);
    if (data.action === "generate") {
      if (!(await codexImageConfigured())) throw new Error("Configure a conta GPT exclusiva antes de autorizar.");
      const reserved = await reserveImageBatch(jobsRoot, batch, data.approvedIds, data.confirmed, validate);
      // Jobs queue in the shared pool: max four active processes across all batches.
      for (const job of reserved) void (async () => {
        await executeImageJob(jobsRoot, job.id, codexImageProfile().accountHome, connectImageDriver);
        const saved = await readImageJob(jobsRoot, job.id);
        if (saved.phase === "complete") await apply(saved);
      })().catch(() => {});
      return NextResponse.json(await state(batch), { status: 202 });
    }
    if (!["apply", "recover"].includes(data.action) || !batch.jobs.includes(data.jobId)) throw new Error("Imagem inválida.");
    const job = data.action === "recover" ? await recoverImageJob(jobsRoot, data.jobId, codexImageProfile().accountHome, connectImageDriver) : await readImageJob(jobsRoot, data.jobId);
    await apply(job);
    return NextResponse.json(await state(batch));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Falha no lote." }, { status: 409 }); }
}

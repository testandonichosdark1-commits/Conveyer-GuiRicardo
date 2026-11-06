import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "../../data-dir";
import { prepareImageJob, readImageJob, reserveImageJob, executeImageJob, recoverImageJob, imageJobBytes } from "../codex-image-jobs";
import { codexImageConfigured, codexImageProfile, connectImageDriver } from "../codex-image-runtime";
import { saveLtxImage } from "./pipeline";

const jobsRoot = path.join(DATA_DIR, "codex-images", "jobs");

/**
 * Drives one GPT/Codex still through prepare -> reserve -> execute -> save, inline, with
 * no human approval step — unlike the GPU/video half of this same "ltx" provider (which
 * keeps its budget-capped manual authorization, see visual-source.ts), a still only
 * spends the operator's Codex plan quota, and the operator asked for that to just happen
 * in the background, following the planner's own prompt.
 *
 * Reuses the exact job/pool machinery the manual batch UI (GptLtxBatch, /api/tools/ltx-
 * image-batch) already drives — same deterministic job id, same one-use reservation, same
 * 4-process pool — so a beat picked up again after a crash finds (and recovers) the SAME
 * job instead of starting a fresh one.
 */
export async function generateLtxImageAutomatically(
  runDir: string,
  runId: string,
  index: number,
  fingerprint: string,
  description: string
): Promise<void> {
  if (!(await codexImageConfigured())) {
    throw new Error("Conta GPT exclusiva não configurada — configure em Settings antes de gerar imagens.");
  }
  const model = codexImageProfile().model;
  let job = await prepareImageJob(jobsRoot, { runId, index, fingerprint }, description, model);

  if (job.phase === "prepared") {
    job = await reserveImageJob(jobsRoot, job.id, true);
  }
  if (job.phase === "reserved") {
    await executeImageJob(jobsRoot, job.id, codexImageProfile().accountHome, connectImageDriver);
    job = await readImageJob(jobsRoot, job.id);
  } else if (job.phase === "generating" || job.phase === "needs-recovery") {
    // A previous attempt (this run or an earlier process) may have actually finished —
    // check before giving up, same as the manual "Recuperar" button, but automatic.
    try {
      job = await recoverImageJob(jobsRoot, job.id, codexImageProfile().accountHome, connectImageDriver);
    } catch {
      job = await readImageJob(jobsRoot, job.id);
    }
  }
  if (job.phase !== "complete") {
    throw new Error(job.error || "Geração de imagem GPT não foi concluída.");
  }
  const png = await sharp(await imageJobBytes(jobsRoot, job.id), { limitInputPixels: 40_000_000 })
    .resize(1920, 1080, { fit: "cover" })
    .png()
    .toBuffer();
  await saveLtxImage(runDir, index, fingerprint, png);
}

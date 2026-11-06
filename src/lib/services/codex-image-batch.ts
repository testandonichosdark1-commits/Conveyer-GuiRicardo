import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readImageJob, reserveImageJob, type ImageJob } from "./codex-image-jobs";
export type ImageBatch = { id: string; runId: string; jobs: string[] };
export function batchId(runId: string, jobs: string[]) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(runId) || !jobs.length || jobs.length > 500 || jobs.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(jobs).size !== jobs.length) throw new Error("Lote inválido.");
  return createHash("sha256").update(JSON.stringify({ runId, jobs })).digest("hex");
}
export async function prepareImageBatch(root: string, runId: string, jobs: string[]): Promise<ImageBatch> {
  const batch = { id: batchId(runId, jobs), runId, jobs };
  await fs.mkdir(root, { recursive: true });
  try { await fs.writeFile(path.join(root, `${batch.id}.json`), JSON.stringify(batch), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return batch;
}
export async function readImageBatch(root: string, id: string): Promise<ImageBatch> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Lote inválido.");
  const batch = JSON.parse(await fs.readFile(path.join(root, `${id}.json`), "utf8"));
  if (batch.id !== id || batchId(batch.runId, batch.jobs) !== id) throw new Error("Lote mudou.");
  return batch;
}
/** Validate the exact set approved before claiming any job. Claims remain consumed on failure. */
export async function reserveImageBatch(root: string, batch: ImageBatch, approvedIds: unknown, confirmed: unknown, validate: (job: ImageJob) => Promise<void>) {
  if (confirmed !== true || !Array.isArray(approvedIds)) throw new Error("Autorize explicitamente as imagens listadas.");
  const jobs = await Promise.all(batch.jobs.map(id => readImageJob(root, id)));
  await Promise.all(jobs.map(validate));
  const pending = jobs.filter(job => job.phase === "prepared");
  if (!pending.length || JSON.stringify(pending.map(j => j.id)) !== JSON.stringify(approvedIds)) throw new Error("O lote mudou ou já foi autorizado. Atualize sem reenviar.");
  // Exclusive batch claim prevents competing clicks from partly reserving the same batch.
  const claim = await fs.open(path.join(root, `batch-${batch.id}.claim`), "wx", 0o600).catch(() => { throw new Error("Este lote já foi autorizado."); });
  await claim.close();
  const reserved: ImageJob[] = [];
  for (const job of pending) reserved.push(await reserveImageJob(root, job.id, true));
  return reserved;
}

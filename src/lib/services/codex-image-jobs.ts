import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { saveCodexImage } from "./codex-images";

export const AMATEUR_IMAGE_STYLE = "Amateur smartphone photo of the situation described in the narration. Everyday setting with believable signs of use, casual framing, ordinary light and a mostly in-focus background. People, if needed, doing the task without posing or looking at the camera. No advertising look, cinematic lighting, artificial blur, added text or watermarks. Horizontal 16:9.";
export type ImageTarget = { runId: string; index: number; fingerprint: string };
export type ImageJob = {
  id: string; target: ImageTarget; description: string; prompt: string; model: string;
  phase: "prepared" | "reserved" | "generating" | "complete" | "needs-recovery";
  threadId?: string; sha256?: string; width?: number; height?: number; error?: string;
};
export function imageJobDir(root: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Imagem inválida.");
  return path.join(root, id);
}
async function writeJob(root: string, job: ImageJob) {
  const file = path.join(imageJobDir(root, job.id), "job.json"), temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(job), { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
export async function readImageJob(root: string, id: string): Promise<ImageJob> {
  const job = JSON.parse(await fs.readFile(path.join(imageJobDir(root, id), "job.json"), "utf8"));
  const { target, description, model } = job;
  if (job.id !== id || imageJobId(target, description, model) !== id || job.prompt !== imagePrompt(description)) throw new Error("Registro de imagem inválido.");
  return job;
}
export function imagePrompt(description: string) {
  if (typeof description !== "string" || !description.trim() || description.length > 6000) throw new Error("Descreva a imagem em até 6.000 caracteres.");
  return `${description.trim()}\n\n${AMATEUR_IMAGE_STYLE}`;
}
function imageJobId(target: ImageTarget, description: string, model: string) {
  if (!target || !/^[a-zA-Z0-9_-]{8,80}$/.test(target.runId) || !Number.isSafeInteger(target.index) || target.index < 0 || target.index > 99999 || !/^[a-f0-9]{64}$/.test(target.fingerprint) || !model?.trim()) throw new Error("Cena inválida.");
  return createHash("sha256").update(JSON.stringify({ target: { runId: target.runId, index: target.index, fingerprint: target.fingerprint }, prompt: imagePrompt(description), model })).digest("hex");
}
/** Local preparation only. Stable IDs ensure refreshes reuse the same approval/result. */
export async function prepareImageJob(root: string, target: ImageTarget, description: string, model: string) {
  const id = imageJobId(target, description, model), dir = imageJobDir(root, id);
  await fs.mkdir(dir, { recursive: true });
  const job: ImageJob = { id, target, description, prompt: imagePrompt(description), model, phase: "prepared" };
  try {
    // Exclusive immutable creation: never reset an existing attempt to prepared.
    await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(job), { flag: "wx", mode: 0o600 });
    return job;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readImageJob(root, id);
  }
}
/** Durable one-use approval, across clicks, server processes and restarts. */
export async function reserveImageJob(root: string, id: string, confirmed: boolean) {
  if (confirmed !== true) throw new Error("Autorize explicitamente esta única imagem.");
  const job = await readImageJob(root, id);
  if (job.phase !== "prepared") throw new Error("Esta autorização já foi usada. Recupere o resultado existente.");
  const lock = await fs.open(path.join(imageJobDir(root, id), "consumed.lock"), "wx", 0o600)
    .catch(() => { throw new Error("Esta autorização já foi usada. Não haverá novo envio."); });
  await lock.close(); job.phase = "reserved"; await writeJob(root, job);
  return job;
}
export type ImageDriver = {
  generate(prompt: string, recordThread: (id: string) => Promise<void>): Promise<{ threadId: string; image: { savedPath?: string | null } }>;
  recover(threadId: string): Promise<{ savedPath?: string | null } | null>;
  close(): Promise<void>;
};
async function acceptImage(root: string, accountHome: string, job: ImageJob, image: { savedPath?: string | null }) {
  const saved = await saveCodexImage(accountHome, image, path.join(imageJobDir(root, job.id), "image.png"));
  Object.assign(job, { phase: "complete", sha256: saved.sha256, width: saved.width, height: saved.height });
  delete job.error; await writeJob(root, job); return job;
}
/** Called only after reservation. Driver creation never happens for local preparation. */
export async function executeImageJob(root: string, id: string, accountHome: string, connect: (model: string) => Promise<ImageDriver>) {
  const job = await readImageJob(root, id);
  if (job.phase !== "reserved") throw new Error("Imagem não reservada.");
  const execution = await fs.open(path.join(imageJobDir(root, id), "execution.lock"), "wx", 0o600);
  await execution.close();
  let driver: ImageDriver | undefined;
  try {
    driver = await connect(job.model);
    const result = await driver.generate(job.prompt, async threadId => {
      job.threadId = threadId; job.phase = "generating"; await writeJob(root, job);
    });
    job.threadId = result.threadId;
    await acceptImage(root, accountHome, job, result.image);
  } catch {
    job.phase = "needs-recovery";
    job.error = "A tentativa terminou sem imagem salva. Recupere o resultado antes de autorizar outra imagem.";
    await writeJob(root, job);
  } finally { if (driver) await driver.close(); }
}
/** Recovery is read-only remotely: it can never call generate. */
export async function recoverImageJob(root: string, id: string, accountHome: string, connect: (model: string) => Promise<ImageDriver>) {
  const job = await readImageJob(root, id);
  if (job.phase === "complete") return job;
  if (!job.threadId || !["generating", "needs-recovery"].includes(job.phase)) throw new Error("Ainda não há conversa recuperável.");
  const driver = await connect(job.model);
  try {
    const image = await driver.recover(job.threadId);
    if (!image) throw new Error("Nenhuma imagem concluída foi encontrada. Nenhum prompt foi reenviado.");
    return await acceptImage(root, accountHome, job, image);
  } finally { await driver.close(); }
}
export async function imageJobBytes(root: string, id: string) {
  const job = await readImageJob(root, id);
  if (job.phase !== "complete" || !job.sha256) throw new Error("Imagem ainda não está pronta.");
  const bytes = await fs.readFile(path.join(imageJobDir(root, id), "image.png"));
  if (createHash("sha256").update(bytes).digest("hex") !== job.sha256) throw new Error("O arquivo da imagem mudou.");
  return bytes;
}

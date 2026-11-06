import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ManualGenerationPendingError } from "../manual-pending";

export class LtxGenerationPendingError extends ManualGenerationPendingError {
  constructor(index: number) { super(index); this.name = "LtxGenerationPendingError"; }
}
export type LtxSceneRequest = {
  index: number; prompt: string; media: "image" | "video"; durationSec: number;
  resolution: string; fingerprint: string; imageDescription?: string;
};
export function ltxSceneDir(runDir: string, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 99999) throw new Error("Cena inválida.");
  return path.join(runDir, "ltx", `beat_${String(index).padStart(4, "0")}`);
}
export function ltxSceneRequest(input: Omit<LtxSceneRequest, "fingerprint">): LtxSceneRequest {
  if (!input.prompt.trim() || input.prompt.length > 6000 || !["image", "video"].includes(input.media) ||
      !Number.isFinite(input.durationSec) || input.durationSec <= 0 ||
      (input.imageDescription !== undefined && (typeof input.imageDescription !== "string" || input.imageDescription.length > 6000))) throw new Error("Cena LTX inválida.");
  ltxSceneDir("", input.index);
  // Descriptive metadata must not invalidate clips prepared before image integration.
  const { imageDescription: _description, ...identity } = input;
  return { ...input, fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex") };
}
async function atomicJson(file: string, data: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 }); await fs.rename(temp, file);
}
export async function readLtxSceneRequest(runDir: string, index: number): Promise<LtxSceneRequest> {
  const r = JSON.parse(await fs.readFile(path.join(ltxSceneDir(runDir, index), "request.json"), "utf8"));
  const { fingerprint, ...input } = r;
  if (r.index !== index || ltxSceneRequest(input).fingerprint !== fingerprint) throw new Error("Cena LTX inválida.");
  return r;
}
export async function readyLtxScene(runDir: string, request: LtxSceneRequest): Promise<string | null> {
  const dir = ltxSceneDir(runDir, request.index);
  try {
    const result = JSON.parse(await fs.readFile(path.join(dir, "result.json"), "utf8"));
    if (result.fingerprint !== request.fingerprint || result.media !== request.media ||
        (request.media === "video" && !result.stoppedVerified &&
         result.source !== "notebook-upload" && result.source !== "notebook-remote")) return null;
    const file = path.join(dir, request.media === "video" ? "clip.mp4" : "image.png");
    if (!(await fs.stat(file)).isFile() || (await fs.stat(file)).size < 1000) return null;
    return file;
  } catch { return null; }
}
/** Pipeline staging has no transport/API/GPU access. Missing scenes pause before assembly. */
export async function acquireLtxScene(runDir: string, input: Omit<LtxSceneRequest, "fingerprint">): Promise<string> {
  const request = ltxSceneRequest(input), dir = ltxSceneDir(runDir, input.index);
  await fs.mkdir(dir, { recursive: true });
  await atomicJson(path.join(dir, "request.json"), request);
  const ready = await readyLtxScene(runDir, request);
  if (ready) return ready;
  throw new LtxGenerationPendingError(input.index);
}
export async function saveLtxImage(runDir: string, index: number, fingerprint: string, image: Uint8Array) {
  const r = await readLtxSceneRequest(runDir, index);
  if (r.fingerprint !== fingerprint || image.byteLength < 1000) throw new Error("A cena mudou. Prepare novamente.");
  const dir = ltxSceneDir(runDir, index);
  const temp = path.join(dir, `input.${randomUUID()}.tmp`);
  await fs.writeFile(temp, image, { mode: 0o600 }); await fs.rename(temp, path.join(dir, "input.png"));
  await atomicJson(path.join(dir, "input.json"), { fingerprint });
  if (r.media === "image") {
    await fs.writeFile(path.join(dir, "image.png"), image, { mode: 0o600 });
    await atomicJson(path.join(dir, "result.json"), { fingerprint, media: "image" });
  }
}
async function attachClipFile(runDir: string, index: number, fingerprint: string, sourcePath: string,
  provenance: Record<string, unknown>) {
  const request = await readLtxSceneRequest(runDir, index);
  if (request.media !== "video" || request.fingerprint !== fingerprint) throw new Error("A cena mudou. O clipe original foi preservado.");
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile() || stat.size < 1000) throw new Error("Clipe inválido.");
  const dir = ltxSceneDir(runDir, index);
  const temp = path.join(dir, `clip.${randomUUID()}.tmp`);
  try {
    await fs.copyFile(sourcePath, temp);
    await fs.rename(temp, path.join(dir, "clip.mp4"));
    await atomicJson(path.join(dir, "result.json"), { fingerprint, media: "video", ...provenance });
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
/** Only a completed, stopped job can supply a beat; never accept paths from the browser. */
export async function attachLtxClip(runDir: string, index: number, fingerprint: string, jobDir: string) {
  const journal = JSON.parse(await fs.readFile(path.join(jobDir, "attempt.json"), "utf8"));
  if (journal.phase !== "complete" || journal.stoppedVerified !== true) throw new Error("A geração e a parada precisam estar confirmadas.");
  await attachClipFile(runDir, index, fingerprint, path.join(jobDir, "scene_1080p.mp4"), {
    stoppedVerified: true, jobId: path.basename(jobDir), originalPath: path.join(jobDir, "original.mp4"),
  });
}
/** A Colab/Kaggle notebook job: completed journal required, but there is no billed GPU of ours to stop. */
export async function attachNotebookLtxClip(runDir: string, index: number, fingerprint: string, jobDir: string) {
  const journal = JSON.parse(await fs.readFile(path.join(jobDir, "attempt.json"), "utf8"));
  if (journal.phase !== "complete") throw new Error("A geração no notebook não foi concluída.");
  await attachClipFile(runDir, index, fingerprint, path.join(jobDir, "scene_1080p.mp4"), {
    source: "notebook-remote", jobId: path.basename(jobDir), originalPath: path.join(jobDir, "original.mp4"),
  });
}
/** The start frame saved for this exact scene (GPT/Codex or a manual upload), or null. */
export async function readLtxInputImage(runDir: string, index: number, fingerprint: string): Promise<Buffer | null> {
  const dir = ltxSceneDir(runDir, index);
  try {
    const saved = JSON.parse(await fs.readFile(path.join(dir, "input.json"), "utf8"));
    if (saved.fingerprint !== fingerprint) return null;
    const png = await fs.readFile(path.join(dir, "input.png"));
    return png.byteLength >= 1000 ? png : null;
  } catch { return null; }
}
/** Attach a locally generated/imported clip without claiming an external GPU stop check. */
export async function attachImportedLtxClip(runDir: string, index: number, fingerprint: string, sourcePath: string) {
  await attachClipFile(runDir, index, fingerprint, sourcePath, { source: "notebook-upload" });
}
export async function listLtxScenes(runDir: string) {
  let dirs: string[];
  try { dirs = await fs.readdir(path.join(runDir, "ltx")); } catch { return []; }
  const scenes = [];
  for (const name of dirs.sort()) {
    const match = /^beat_(\d{4,5})$/.exec(name); if (!match) continue;
    try {
      const request = await readLtxSceneRequest(runDir, Number(match[1]));
      scenes.push({ ...request, ready: Boolean(await readyLtxScene(runDir, request)) });
    } catch { /* Ignore incomplete files while a pipeline is preparing. */ }
  }
  return scenes;
}

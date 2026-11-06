import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../../data-dir";
import { acquireLtxScene, LtxGenerationPendingError } from "./pipeline";
export type ScriptScene = { narration: string; description: string; motion: string };
export function splitScript(script: string): ScriptScene[] {
  if (typeof script !== "string" || !script.trim() || script.length > 30000) throw new Error("Cole um roteiro de até 30 mil caracteres.");
  const sentences = script.trim().split(/(?<=[.!?])\s+|\n\s*\n/u).filter(Boolean);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length > 2000) throw new Error("Divida os parágrafos longos em frases menores.");
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last].length + sentence.length < 450) chunks[last] += " " + sentence;
    else chunks.push(sentence);
  }
  if (chunks.length > 100) throw new Error("Use um trecho menor: máximo de 100 cenas.");
  return chunks.map(narration => ({ narration, description: narration, motion: "Preserve the scene shown in the input image. Natural subtle movement. Subtle handheld, micro-shakes only." }));
}
export const draftRoot = path.join(DATA_DIR, "ltx-script-drafts");
export function draftDir(id: string) {
  if (!/^script-[a-f0-9-]{36}$/.test(id)) throw new Error("Roteiro inválido.");
  return path.join(draftRoot, id);
}
export async function readDraft(id: string) {
  const d = JSON.parse(await fs.readFile(path.join(draftDir(id), "draft.json"), "utf8"));
  if (d.id !== id || typeof d.title !== "string") throw new Error("Roteiro inválido.");
  return d as { id: string; title: string; scenes: ScriptScene[] };
}
export async function createDraft(title: string, scenes: ScriptScene[]) {
  if (!Array.isArray(scenes) || !scenes.length || scenes.length > 100 || scenes.some(s => !s || [s.narration,s.description,s.motion].some(v => typeof v !== "string" || !v.trim() || v.length > 6000))) throw new Error("Revise o texto, a imagem e o movimento de cada cena.");
  const id = `script-${randomUUID()}`, dir = draftDir(id);
  await fs.mkdir(dir, { recursive: true });
  for (const [i,s] of scenes.entries()) {
    try { await acquireLtxScene(dir, { index: i+1, prompt: s.motion, imageDescription: s.description, media: "video", durationSec: 6, resolution: "1920x1080" }); }
    catch (e) { if (!(e instanceof LtxGenerationPendingError)) throw e; }
  }
  const draft = { id, title: typeof title === "string" ? title.trim().slice(0,160) || "Roteiro GPT + LTX" : "Roteiro GPT + LTX", scenes };
  // Publish only after all local scenes exist. Never starts the studio pipeline.
  await fs.writeFile(path.join(dir,"draft.json"), JSON.stringify(draft), { mode: 0o600 });
  return draft;
}
export async function listDrafts() {
  let names: string[]; try { names = await fs.readdir(draftRoot); } catch { return []; }
  const drafts = [];
  for (const name of names) { try { drafts.push(await readDraft(name)); } catch { /* incomplete drafts remain invisible */ } }
  return drafts;
}

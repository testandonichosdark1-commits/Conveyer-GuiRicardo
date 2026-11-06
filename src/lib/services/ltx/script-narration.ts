import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSetting } from "../../settings";
import { resolveFfmpeg, resolveFfprobe } from "../../ffmpeg-bin";
import { pickTaskId, readTaskState } from "../ai33-response";
import { AI33_DEFAULT_BASE } from "../ai33-voices";
import { draftDir, readDraft } from "./script-drafts";

const run = promisify(execFile);
export type Narration = {
  index: number; fingerprint: string; text: string; base: string; voiceId: string;
  voiceName: string; speed: number; credits?: number | null;
  state: "prepared" | "submitting" | "running" | "complete" | "unknown" | "failed";
  jobId?: string; durationSec?: number; sha256?: string; error?: string;
};
async function location(id: string, index: number) {
  const draft = await readDraft(id);
  if (!Number.isInteger(index) || index < 1 || index > draft.scenes.length) throw new Error("Cena inválida.");
  const dir = path.join(draftDir(id), "narration");
  await fs.mkdir(dir, { recursive: true });
  return { dir, file: path.join(dir, `scene-${index}.json`), text: draft.scenes[index - 1].narration };
}
async function save(file: string, row: Narration) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(row), { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function readNarration(id: string, index: number): Promise<Narration | null> {
  const { file, text } = await location(id, index);
  try {
    const row = JSON.parse(await fs.readFile(file, "utf8")) as Narration;
    if (row.index !== index || row.text !== text) throw new Error("Narração inválida.");
    return row;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
function config() {
  const base = (getSetting("AI33_BASE_URL") || AI33_DEFAULT_BASE).replace(/\/+$/, ""), url = new URL(base);
  if (!['api.openspeaker.ai', 'api.ai33.pro'].includes(url.hostname) || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/")
    throw new Error("Confira o endereço oficial da API do AI33 Pro nas configurações.");
  if (!getSetting("AI33_API_KEY")) throw new Error("Configure a chave do AI33 Pro nas configurações.");
  const voiceId = getSetting("AI33_VOICE_ID");
  if (!voiceId) throw new Error("Selecione uma voz do AI33 Pro nas configurações.");
  const raw = Number(getSetting("TTS_SPEED") || "1");
  const speed = Number.isFinite(raw) ? Math.max(0.5, Math.min(1.5, raw)) : 1;
  return { base, voiceId, speed };
}
function fingerprint(text: string, base: string, voiceId: string, speed: number) {
  return createHash("sha256").update(JSON.stringify({ text, base, voiceId, speed })).digest("hex");
}
async function call(base: string, endpoint: string, init?: RequestInit) {
  let response: Response;
  try { response = await fetch(`${base}${endpoint}`, { ...init, headers: { "xi-api-key": getSetting("AI33_API_KEY"), ...init?.headers }, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
  catch { throw new Error("A consulta ao AI33 Pro perdeu a resposta. Confira o resultado existente; não será feita outra geração automaticamente."); }
  if (!response.ok) throw new Error(`AI33 Pro respondeu HTTP ${response.status}.`);
  return response;
}
export async function prepareNarration(id: string, index: number) {
  const { file, text } = await location(id, index), c = config();
  const fp = fingerprint(text, c.base, c.voiceId, c.speed);
  const old = await readNarration(id, index);
  if (old) {
    if (old.fingerprint !== fp) throw new Error("A voz mudou. Preserve este roteiro e crie outro para testar a nova voz.");
    return old;
  }
  const row: Narration = { index, text, ...c, voiceName: c.voiceId, fingerprint: fp, state: "prepared", credits: null };
  // An exclusive initial write prevents concurrent preparation from replacing a running job.
  await fs.writeFile(file, JSON.stringify(row), { mode: 0o600, flag: "wx" }).catch(async e => {
    if (e.code !== "EEXIST") throw e;
  });
  return (await readNarration(id, index))!;
}
export async function generateNarration(id: string, index: number, approvedFingerprint: string, confirmed: boolean) {
  const { file } = await location(id, index), row = await readNarration(id, index), c = config();
  if (confirmed !== true || !row || row.fingerprint !== approvedFingerprint || row.base !== c.base || row.voiceId !== c.voiceId || row.speed !== c.speed)
    throw new Error("Prepare a narração e confirme esta voz e este texto antes de gerar.");
  if (row.state !== "prepared") return row;
  // Permanent claim BEFORE the only create request. A lost response never triggers a retry.
  const claim = `${file}.consumed`;
  try { await fs.writeFile(claim, approvedFingerprint, { flag: "wx", mode: 0o600 }); }
  catch { throw new Error("A autorização desta cena já foi usada. Recupere o resultado sem gerar novamente."); }
  row.state = "submitting"; await save(file, row);
  try {
    const result: unknown = await (await call(row.base, "/v3/text-to-speech", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_id: row.voiceId, text: row.text, speed: row.speed }),
    })).json();
    await fs.writeFile(`${file}.response.json`, JSON.stringify(result), { mode: 0o600 });
    const jobId = pickTaskId(result);
    if (!jobId) throw new Error("O AI33 Pro não retornou o identificador. Confira o histórico antes de repetir.");
    row.jobId = jobId; row.credits = readTaskState(result).credits; row.state = "running";
  } catch (e) { row.state = "unknown"; row.error = (e as Error).message; }
  await save(file, row); return row;
}
export async function recoverNarration(id: string, index: number) {
  const { file, dir } = await location(id, index), row = await readNarration(id, index);
  if (!row || row.state === "prepared" || row.state === "complete" || row.state === "failed") return row;
  if (!row.jobId) {
    // Rescue a crash after receiving the response but before publishing the job id.
    try {
      const result = JSON.parse(await fs.readFile(`${file}.response.json`, "utf8"));
      row.jobId = pickTaskId(result) || undefined;
      if (row.jobId) { row.state = "running"; delete row.error; await save(file, row); }
    } catch {}
    if (!row.jobId) throw new Error("O envio ficou sem identificador. Confira o histórico do AI33 Pro; não será feita outra geração automaticamente.");
  }
  // Revalidate the persisted host before attaching the current credential.
  if (row.base !== config().base) throw new Error("O endereço da API mudou. Confira o job existente antes de recuperar.");
  const state = readTaskState(await (await call(row.base, `/v1/task/${encodeURIComponent(row.jobId)}`)).json());
  if (state.credits !== null) row.credits = Math.max(row.credits || 0, state.credits);
  if (state.phase === "failed") { row.state = "failed"; row.error = "A geração falhou no AI33 Pro. Confira o histórico; nenhuma repetição será feita."; await save(file, row); return row; }
  if (state.phase !== "done") { await save(file, row); return row; }
  if (!state.audioUrl) throw new Error("O resultado ainda não contém o endereço do áudio. Recupere novamente sem gerar.");
  const temp = path.join(dir, `${randomUUID()}.source`), out = path.join(dir, `${randomUUID()}.wav`);
  try {
    const audioUrl = new URL(state.audioUrl);
    if (audioUrl.protocol !== "https:" || audioUrl.username || audioUrl.password || audioUrl.port || !audioUrl.hostname.includes(".") || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(audioUrl.hostname)) throw new Error("Endereço do áudio recusado.");
    // No credential is forwarded to the provider's download host, and no redirects.
    const response = await fetch(audioUrl, { redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!response.ok || /^(text\/|application\/(json|xml))/.test(response.headers.get("content-type") || "")) throw new Error("Não foi possível baixar o áudio já gerado. Use recuperar, sem repetir a geração.");
    // Bound the local download even if Content-Length is absent.
    const reader = response.body?.getReader(); if (!reader) throw new Error("Áudio vazio.");
    const handle = await fs.open(temp, "wx", 0o600); let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 80 * 1024 * 1024) throw new Error("Áudio maior que 80 MB."); await handle.write(part.value); } }
    finally { await handle.close(); await reader.cancel().catch(() => {}); }
    await run(resolveFfmpeg(), ["-nostdin", "-y", "-i", temp, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const probe = JSON.parse((await run(resolveFfprobe(), ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", out])).stdout);
    const durationSec = Number(probe.format?.duration);
    if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600 || !probe.streams?.some((s: {codec_type:string}) => s.codec_type === "audio")) throw new Error("Áudio inválido ou maior que dez minutos por cena.");
    row.sha256 = createHash("sha256").update(await fs.readFile(out)).digest("hex");
    await fs.rename(out, path.join(dir, `scene-${index}.wav`));
    row.durationSec = durationSec; row.state = "complete"; delete row.error;
    await save(file, row); return row;
  } finally { await fs.rm(temp, { force: true }); await fs.rm(out, { force: true }); }
}
export async function narrationFile(id: string, index: number) {
  const { dir } = await location(id, index), row = await readNarration(id, index);
  if (!row || row.state !== "complete" || !row.sha256 || !row.durationSec) throw new Error(`A narração da cena ${index} ainda não está pronta.`);
  const file = path.join(dir, `scene-${index}.wav`);
  if (createHash("sha256").update(await fs.readFile(file)).digest("hex") !== row.sha256) throw new Error("O áudio foi alterado. Recupere o arquivo original.");
  return { file, durationSec: row.durationSec };
}

/**
 * Video Factory queue — runs up to FACTORY_CONCURRENCY jobs at once, each through
 * script → thumbnail → video.
 *
 * Process-wide state lives on globalThis so a Next.js hot reload does not start a
 * second queue next to the first. On the first call after a server start, jobs
 * left "running" by the previous process are put back in the queue: every step
 * checks its own output files first, so the restart resumes, never repeats.
 */
import fs from "node:fs";
import db from "../db";
import { runClaude } from "./claude-cli";
import {
  type FactoryJob,
  getJob,
  jobFiles,
  jobOptions,
  jobsWithStatus,
  updateJob,
} from "./jobs";
import { generateThumbnailWithChatGpt, readChatGptThumbnailSpec } from "./thumbnail-chatgpt";

const CHANNEL_NAMES: Record<string, string> = {
  a: "a (military / special forces, Foxhole Files style)",
  b: "b (truckers: USA vs Europe/UK/Australia)",
  c: "c (Cold War military aviation and space engineering)",
};

interface QueueState {
  active: Map<string, AbortController>;
  recovered: boolean;
  pumping: boolean;
}
const g = globalThis as unknown as { __facelessFactoryQueue?: QueueState };
const state: QueueState = (g.__facelessFactoryQueue ??= { active: new Map(), recovered: false, pumping: false });

function concurrency(): number {
  const n = Number(process.env.FACTORY_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 10) : 3;
}

function minutes(envKey: string, fallback: number): number {
  const n = Number(process.env[envKey]);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60_000;
}

class Cancelled extends Error {}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new Cancelled("cancelled");
}

/* ── Step 1: script + description ─────────────────────────────────────────── */

async function stepScript(job: FactoryJob, signal: AbortSignal) {
  const files = jobFiles(job);
  if (files.script && files.description) return;
  updateJob(job.id, { step: "script", detail: "Pesquisando e escrevendo o roteiro (15–40 min)…" });
  await runClaude({
    cwd: job.folder,
    logName: "roteiro",
    timeoutMs: minutes("FACTORY_SCRIPT_TIMEOUT_MIN", 90),
    signal,
    prompt: [
      `Use the roteiro-7-things skill to write ONE script (single-title mode, not batch mode).`,
      `TITLE: ${job.title}`,
      `CHANNEL: ${CHANNEL_NAMES[job.channel_kind] ?? job.channel_kind}`,
      `Run every step of the skill yourself, including the research file and the YouTube description.`,
      `Save all files in the current working directory: <slug>.txt, <slug>_pesquisa.md and <slug>_descricao.txt.`,
      `This is an unattended run: never ask questions, decide and continue.`,
    ].join("\n"),
  });
  const after = jobFiles(job);
  if (!after.script) throw new Error("the script skill finished without writing the script file");
  if (!after.description) throw new Error("the script skill finished without writing the description file");
}

/* ── Step 2: thumbnail ────────────────────────────────────────────────────── */

async function stepThumbnail(job: FactoryJob, signal: AbortSignal) {
  let files = jobFiles(job);
  if (files.thumbnail) return;
  const specPath = `${job.folder}/thumbnail.json`;
  const hasFullPrompt = (() => {
    try {
      return typeof JSON.parse(fs.readFileSync(specPath, "utf8")).fullPrompt === "string";
    } catch {
      return false;
    }
  })();
  if (!hasFullPrompt) {
    updateJob(job.id, { step: "thumbnail", detail: "Escrevendo a cena, o texto e a seta da thumbnail…" });
    await runClaude({
      cwd: job.folder,
      logName: "thumbnail",
      timeoutMs: minutes("FACTORY_THUMB_TIMEOUT_MIN", 20),
      signal,
      prompt: [
        `Use the foxhole-thumbnail-generator skill for this video.`,
        `TITLE: ${job.title}`,
        `CHANNEL: ${job.channel_kind}`,
        `SCRIPT FILE: ${files.script}`,
        `Save the package next to the script as the skill says. Then ALSO write thumbnail.json in the current`,
        `directory with exactly these keys, taken from the ★ recommended option of your package:`,
        `{"fullPrompt": "<the complete all-in-one prompt of section 4: scene, observer, BOTH questions with their colours and layout, and the red arrow>",`,
        ` "yellow": "<question 1>", "white": "<question 2>"}`,
        `The image is generated in ONE step from fullPrompt, text and arrow included, so it must be complete on its own.`,
        `This is an unattended run: never ask questions.`,
      ].join("\n"),
    });
    files = jobFiles(job);
  }
  checkAbort(signal);
  const spec = readChatGptThumbnailSpec(specPath);
  updateJob(job.id, { step: "thumbnail", detail: "Gerando a thumbnail no ChatGPT…" });
  await generateThumbnailWithChatGpt(spec, `${job.folder}/thumbnail.jpg`);
}

/* ── Step 3: voice + assets + video (the existing studio pipeline) ────────── */

const runStatus = db.prepare("SELECT status FROM runs WHERE id = ?");
const lastRunError = db.prepare(
  "SELECT message FROM run_logs WHERE run_id = ? AND level = 'error' ORDER BY rowid DESC LIMIT 1"
);

function studioUrl(): string {
  const base = process.env.FACTORY_STUDIO_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  return `${base}/api/studio`;
}

async function stepVideo(job: FactoryJob, signal: AbortSignal) {
  let runId = job.run_id;
  if (!runId) {
    const files = jobFiles(job);
    const script = fs.readFileSync(files.script!, "utf8").trim();
    const opts = jobOptions(job);
    updateJob(job.id, { step: "video", detail: "Enviando o roteiro para a narração e montagem…" });
    const resp = await fetch(studioUrl(), {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: job.title,
        script,
        channelId: opts.channelId,
        visualMode: opts.free ? "real" : opts.visualMode,
        realPercent: !opts.free && opts.visualMode === "mix" ? opts.realPercent : undefined,
        ...(opts.free ? { realFallback: "strict" } : {}),
        avatarPercent: opts.avatarPercent,
        ...(opts.voice === "voicestudio" ? { voiceProvider: "voicestudio" } : {}),
      }),
    });
    const body = (await resp.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!resp.ok || !body.id) throw new Error(`the studio refused the video: ${body.error ?? resp.status}`);
    runId = body.id;
    updateJob(job.id, { run_id: runId });
  }
  updateJob(job.id, { step: "video", detail: "Narrando, buscando assets e montando o vídeo…" });
  // The studio pipeline runs on its own; follow its status until it ends.
  for (;;) {
    checkAbort(signal);
    const row = runStatus.get(runId) as { status: string } | undefined;
    if (!row) throw new Error("the studio run disappeared");
    if (row.status === "done") return;
    if (row.status === "error" || row.status === "cancelled") {
      // Surface the run's own reason (e.g. "ai33 … Not enough credits") instead of a generic line.
      const last = lastRunError.get(runId) as { message: string } | undefined;
      const why = last ? ` Motivo: ${last.message.slice(0, 300)}` : "";
      throw new Error(
        row.status === "error"
          ? `O run do vídeo falhou.${why} Corrija, retome o run na página dele e clique em Tentar de novo.`
          : `O run do vídeo foi parado ou pausado.${why} Retome-o na página do run e clique em Tentar de novo.`
      );
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/* ── Orchestration ────────────────────────────────────────────────────────── */

async function runJob(id: string, ctrl: AbortController) {
  let thumbWarning: string | null = null;
  try {
    updateJob(id, { status: "running" });
    let job = getJob(id)!;
    await stepScript(job, ctrl.signal);
    checkAbort(ctrl.signal);
    job = getJob(id)!;
    // A thumbnail problem (ChatGPT unavailable, a refused prompt) must not hold back the
    // video: it is reported on the card and "Tentar de novo" redoes only the thumbnail.
    try {
      await stepThumbnail(job, ctrl.signal);
    } catch (e) {
      if (ctrl.signal.aborted || e instanceof Cancelled) throw e;
      thumbWarning = (e as Error).message;
    }
    checkAbort(ctrl.signal);
    job = getJob(id)!;
    await stepVideo(job, ctrl.signal);
    if (thumbWarning) {
      updateJob(id, {
        status: "error",
        step: "finished",
        detail: `Vídeo pronto, mas a thumbnail falhou: ${thumbWarning.slice(0, 500)}`,
      });
    } else {
      updateJob(id, { status: "done", step: "finished", detail: "Pronto." });
    }
  } catch (e) {
    if (ctrl.signal.aborted || e instanceof Cancelled) {
      updateJob(id, { status: "cancelled", detail: "Cancelado." });
    } else {
      const thumb = thumbWarning ? ` (Thumbnail também falhou: ${thumbWarning.slice(0, 200)})` : "";
      updateJob(id, { status: "error", detail: `${(e as Error).message}${thumb}`.slice(0, 1000) });
    }
  } finally {
    state.active.delete(id);
    pump();
  }
}

/** Start queued jobs while there are free slots. Safe to call any time. */
export function pump(): void {
  if (!state.recovered) {
    state.recovered = true;
    for (const j of jobsWithStatus("running")) {
      if (!state.active.has(j.id)) updateJob(j.id, { status: "queued", detail: "Retomando após reinício…" });
    }
  }
  if (state.pumping) return;
  state.pumping = true;
  try {
    const free = concurrency() - state.active.size;
    if (free <= 0) return;
    for (const j of jobsWithStatus("queued").slice(0, free)) {
      const ctrl = new AbortController();
      state.active.set(j.id, ctrl);
      void runJob(j.id, ctrl);
    }
  } finally {
    state.pumping = false;
  }
}

export function cancelJob(id: string): void {
  const ctrl = state.active.get(id);
  if (ctrl) ctrl.abort();
  else {
    const job = getJob(id);
    if (job && job.status === "queued") updateJob(id, { status: "cancelled", detail: "Cancelado." });
  }
}

export function retryJob(id: string): void {
  const job = getJob(id);
  if (!job || state.active.has(id)) return;
  if (job.status === "error" || job.status === "cancelled") {
    updateJob(id, { status: "queued", detail: "Na fila." });
    pump();
  }
}

export function activeCount(): number {
  return state.active.size;
}

export function factoryConcurrency(): number {
  return concurrency();
}

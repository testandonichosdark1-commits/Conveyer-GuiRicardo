import fs from "node:fs/promises";
import path from "node:path";
import { buildLtxWorkflow, type LtxGraph } from "./workflow";
import { isNotebookSession, validateNotebookSession, type LtxNotebookSession } from "./notebook-session";

export type LtxSession = {
  approvalId: string;
  podId: string;
  podName: string;
  /** Private SSH tunnel; ComfyUI never needs a public port. */
  comfyUrl: string;
  startedAt: number;
  deadline: number;
  budgetUsd: number;
  approvedGpuRate?: number;
  guardianPid: number;
};

export type LtxJournal = {
  phase: "reserved" | "submitted" | "downloaded" | "complete" | "failed";
  promptId?: string;
  stoppedVerified: boolean;
  error?: string;
};

export type LtxTransport<S = LtxSession> = {
  assertGuardian(session: S): Promise<void>;
  request<T>(route: string, init?: RequestInit): Promise<T>;
  download(route: string, outputPath: string): Promise<void>;
  stopAndVerify(session: S): Promise<boolean>;
  finalize(rawPath: string, finalPath: string): Promise<void>;
  wait(ms: number): Promise<void>;
  now(): number;
};

/** Lease comes from the separate, explicitly approved GPU controller, never the browser. */
export function validateLtxSession(session: LtxSession, now: number) {
  const url = new URL(session.comfyUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("O ComfyUI deve usar um túnel privado local.");
  }
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(session.approvalId) || !/^[a-z0-9]{8,40}$/.test(session.podId) ||
      !/^conveyer-ltx-[a-zA-Z0-9-]+$/.test(session.podName) || !Number.isSafeInteger(session.guardianPid) || session.guardianPid < 2 ||
      !Number.isFinite(session.startedAt) || !Number.isFinite(session.deadline) ||
      session.deadline <= now || session.startedAt > now ||
      session.deadline - session.startedAt > 65 * 60_000 ||
      session.budgetUsd !== 2) {
    throw new Error("A autorização ou o prazo de segurança da GPU é inválido.");
  }
}

/** Runpod lease or Colab/Kaggle notebook — each validated by its own rules. */
export function validateAnyLtxSession(session: LtxSession | LtxNotebookSession, now: number) {
  if (isNotebookSession(session)) validateNotebookSession(session, now);
  else validateLtxSession(session, now);
}

type HistoryEntry = { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string,
  { images?: Array<{ filename: string; subfolder: string; type: string }> }> };

export function ltxOutputRoute(history: Record<string, HistoryEntry>, promptId: string): string | null {
  const result = history[promptId];
  if (!result) return null;
  if (result.status?.status_str === "error") throw new Error("O ComfyUI informou falha na geração.");
  if (!result.status?.completed) return null;
  // Read only the SaveVideo node, never arbitrary outputs or remote URLs.
  const file = result.outputs?.save?.images?.find((item) => item.filename.endsWith(".mp4"));
  if (!file || file.type !== "output" || !/^[a-zA-Z0-9_.-]+\.mp4$/.test(file.filename) ||
      file.filename.includes("..") || !/^[a-zA-Z0-9_/-]*$/.test(file.subfolder) ||
      file.subfolder.startsWith("/") || file.subfolder.split("/").includes("..")) {
    throw new Error("Saída de vídeo ausente ou inválida.");
  }
  return `/view?${new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: "output" })}`;
}

/** One approved session, one durable reservation, one POST /prompt. Never retry unknown delivery. */
export async function animateLtxScene<S extends LtxSession | LtxNotebookSession>(input: {
  session: S; prompt: string; imagePng: Uint8Array; outputDir: string;
  /** A notebook passes its own graph (lite profile, or no sol-attn); Runpod keeps the validated one. */
  graph?: LtxGraph;
}, transport: LtxTransport<S>): Promise<{ rawPath: string; finalPath: string }> {
  validateAnyLtxSession(input.session, transport.now());
  const graph: LtxGraph = input.graph ?? buildLtxWorkflow(input.prompt);
  await transport.assertGuardian(input.session);
  await fs.mkdir(input.outputDir, { recursive: true });
  // This exclusive file is consumed even if upload/submission response is lost.
  const journalPath = path.join(input.outputDir, "attempt.json");
  const journal: LtxJournal = { phase: "reserved", stoppedVerified: false };
  const reservation = await fs.open(journalPath, "wx", 0o600);
  try { await reservation.writeFile(JSON.stringify(journal)); await reservation.sync(); } finally { await reservation.close(); }
  const persist = async () => {
    const temp = journalPath + ".tmp";
    await fs.writeFile(temp, JSON.stringify(journal), { mode: 0o600 });
    await fs.rename(temp, journalPath);
  };
  const assertTime = () => {
    if (transport.now() >= input.session.deadline) throw new Error("Prazo de segurança atingido.");
  };
  let failure: unknown;
  const rawPath = path.join(input.outputDir, "original.mp4");
  const finalPath = path.join(input.outputDir, "scene_1080p.mp4");
  try {
    assertTime();
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(input.imagePng)], { type: "image/png" }), "entrada.png");
    form.append("overwrite", "true");
    const upload = await transport.request<{ name: string }>("/upload/image", { method: "POST", body: form });
    if (upload.name !== "entrada.png") throw new Error("O servidor não confirmou a imagem enviada.");
    const queue = await transport.request<{ queue_running: unknown[]; queue_pending: unknown[] }>("/queue");
    if (queue.queue_running.length || queue.queue_pending.length) throw new Error("A GPU já possui uma geração na fila.");
    assertTime();
    await transport.assertGuardian(input.session);
    const submitted = await transport.request<{ prompt_id?: string }>("/prompt", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: input.session.approvalId }),
    });
    if (!submitted.prompt_id || !/^[a-zA-Z0-9_-]{1,100}$/.test(submitted.prompt_id)) throw new Error("Envio sem confirmação. Não será repetido.");
    journal.promptId = submitted.prompt_id; journal.phase = "submitted"; await persist();
    const generationDeadline = Math.min(input.session.deadline, transport.now() + 30 * 60_000);
    let outputRoute: string | null = null;
    while (!outputRoute) {
      assertTime();
      if (transport.now() >= generationDeadline) throw new Error("A geração excedeu 30 minutos.");
      const history = await transport.request<Record<string, HistoryEntry>>(`/history/${submitted.prompt_id}`);
      outputRoute = ltxOutputRoute(history, submitted.prompt_id);
      if (!outputRoute) await transport.wait(5000);
    }
    assertTime();
    await transport.download(outputRoute, rawPath);
    journal.phase = "downloaded"; await persist();
  } catch (error) {
    failure = error;
    journal.phase = "failed";
    // Do not persist raw provider exceptions (may contain credentials or request bodies).
    journal.error = "A geração falhou; envio automático não será repetido.";
  } finally {
    try { journal.stoppedVerified = await transport.stopAndVerify(input.session); }
    catch { journal.stoppedVerified = false; }
    await persist();
  }
  if (!journal.stoppedVerified) throw new Error("Parada da GPU ainda não confirmada. Verifique o Runpod imediatamente.");
  // The cause stays in memory only (never in the journal), for a caller's own log line.
  if (failure) throw new Error(journal.error, { cause: failure });
  // CPU-only crop and mute after the GPU has been confirmed stopped.
  try { await transport.finalize(rawPath, finalPath); }
  catch {
    journal.phase = "failed"; journal.error = "GPU parada; falha ao preparar o clipe localmente.";
    await persist(); throw new Error(journal.error);
  }
  journal.phase = "complete"; await persist();
  return { rawPath, finalPath };
}

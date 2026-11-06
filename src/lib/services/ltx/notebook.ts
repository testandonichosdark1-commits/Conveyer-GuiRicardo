import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { animateLtxScene, type LtxTransport } from "./scene";
import { buildLtxLiteWorkflow, buildLtxWorkflow } from "./workflow";
import { LTX_SESSION_DIR, finalizeLtxClip, writeLtxDownload } from "./session";
import { attachNotebookLtxClip, ltxSceneDir, readLtxInputImage, readLtxSceneRequest } from "./pipeline";
import {
  NOTEBOOK_SESSION_HOURS, normalizeNotebookUrl, validateNotebookSession, type LtxNotebookSession,
} from "./notebook-session";

/**
 * Colab/Kaggle GPU for LTX clips. The notebook (workers/ltx-notebook) runs ComfyUI on its
 * own loopback, a token-checking proxy in front of it, and a Cloudflare quick tunnel. The
 * operator pastes the tunnel URL + token here once; the pipeline then sends the same
 * validated graph the Runpod path sends, through the same animateLtxScene.
 */
export const NOTEBOOK_SESSION_FILE = path.join(LTX_SESSION_DIR, "notebook.json");

type Fetch = typeof fetch;
export type NotebookHealth = {
  ok: boolean; comfy: boolean; modelsReady: boolean; gpu: string; vramGb: number; sparseAttention: boolean;
  missingModels: string[]; profile: "full" | "lite";
};

async function notebookFetch(baseUrl: string, token: string, route: string, init: RequestInit = {},
  timeoutMs = 20_000, fetchImpl: Fetch = fetch) {
  if (!route.startsWith("/") || route.startsWith("//")) throw new Error("Rota do notebook inválida.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetchImpl(new URL(route, baseUrl), {
    ...init, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
  });
  if (response.status === 401) throw new Error("O notebook recusou o token. Copie o token mostrado na última célula.");
  if (!response.ok) throw new Error(`Notebook HTTP ${response.status}`);
  return response;
}

export async function probeNotebook(baseUrl: string, token: string, fetchImpl: Fetch = fetch): Promise<NotebookHealth> {
  let raw: Record<string, unknown>;
  try {
    raw = await (await notebookFetch(baseUrl, token, "/conveyer/health", {}, 15_000, fetchImpl)).json();
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("O notebook") || message.startsWith("Notebook HTTP")) throw error;
    throw new Error("Não foi possível alcançar o notebook. Confira se a célula do túnel continua rodando.");
  }
  return {
    ok: raw.ok === true, comfy: raw.comfy === true, modelsReady: raw.models_ready === true,
    gpu: typeof raw.gpu === "string" ? raw.gpu.slice(0, 120) : "GPU desconhecida",
    vramGb: typeof raw.vram_gb === "number" && Number.isFinite(raw.vram_gb) ? raw.vram_gb : 0,
    sparseAttention: raw.sparse_attention === true,
    profile: raw.profile === "lite" ? "lite" : "full",
    missingModels: Array.isArray(raw.missing_models) ? raw.missing_models.filter((m): m is string => typeof m === "string").slice(0, 10) : [],
  };
}

function assertUsable(health: NotebookHealth) {
  if (!health.comfy) throw new Error("O ComfyUI do notebook ainda não respondeu. Aguarde a célula de inicialização.");
  if (!health.modelsReady) {
    throw new Error(`O notebook ainda não tem todos os modelos LTX${health.missingModels.length ? ` (faltam: ${health.missingModels.join(", ")})` : ""}.`);
  }
}

export async function connectLtxNotebook(url: string, token: string, fetchImpl: Fetch = fetch): Promise<LtxNotebookSession> {
  const baseUrl = normalizeNotebookUrl(url);
  const cleanToken = token.trim();
  if (!/^[A-Za-z0-9_-]{24,200}$/.test(cleanToken)) throw new Error("Cole o token completo mostrado pelo notebook.");
  const health = await probeNotebook(baseUrl, cleanToken, fetchImpl);
  assertUsable(health);
  const now = Date.now();
  const session: LtxNotebookSession = {
    kind: "notebook", approvalId: `nb-${randomBytes(12).toString("base64url")}`, baseUrl, token: cleanToken,
    connectedAt: now, deadline: now + NOTEBOOK_SESSION_HOURS * 3600_000,
    gpu: health.gpu, vramGb: health.vramGb, sparseAttention: health.sparseAttention, profile: health.profile,
  };
  validateNotebookSession(session, now);
  await fs.mkdir(LTX_SESSION_DIR, { recursive: true });
  const temp = `${NOTEBOOK_SESSION_FILE}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(session), { mode: 0o600 });
  await fs.rename(temp, NOTEBOOK_SESSION_FILE);
  return session;
}

export async function readLtxNotebookSession(): Promise<LtxNotebookSession | null> {
  try {
    const session = JSON.parse(await fs.readFile(NOTEBOOK_SESSION_FILE, "utf8")) as LtxNotebookSession;
    validateNotebookSession(session, Date.now());
    return session;
  } catch { return null; }
}

export async function disconnectLtxNotebook() {
  await fs.rm(NOTEBOOK_SESSION_FILE, { force: true });
}

export function notebookTransport(session: LtxNotebookSession, fetchImpl: Fetch = fetch): LtxTransport<LtxNotebookSession> {
  const request = (route: string, init: RequestInit = {}, timeout = 30_000) => {
    validateNotebookSession(session, Date.now());
    return notebookFetch(session.baseUrl, session.token, route, init,
      Math.max(1, Math.min(timeout, session.deadline - Date.now())), fetchImpl);
  };
  return {
    now: Date.now,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async assertGuardian(lease) { assertUsable(await probeNotebook(lease.baseUrl, lease.token, fetchImpl)); },
    async request<T>(route: string, init?: RequestInit): Promise<T> {
      return await (await request(route, init)).json() as T;
    },
    async download(route, outputPath) { await writeLtxDownload(await request(route, {}, 300_000), outputPath); },
    // Nothing of ours is billed per hour: the runtime is the operator's Colab/Kaggle quota
    // and they end it themselves. "Stopped" here only means "no GPU left running on our bill".
    async stopAndVerify() { return true; },
    finalize: (rawPath, finalPath) => finalizeLtxClip(rawPath, finalPath, session.profile ?? "full"),
  };
}

// One ComfyUI, one queue: concurrent beats wait their turn instead of tripping the
// "queue already busy" refusal in animateLtxScene. Survives hot reload like flow-browser.
const shared = globalThis as typeof globalThis & { __conveyerLtxNotebookQueue?: Promise<unknown> };
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = shared.__conveyerLtxNotebookQueue ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  shared.__conveyerLtxNotebookQueue = next.catch(() => {});
  return next;
}

/**
 * Animates one pending video scene on the connected notebook and attaches the clip.
 * Needs the scene's start frame (input.png) already saved; every call is a new attempt
 * directory, so a Resume after a failure tries again rather than reusing a broken one.
 */
export async function generateLtxClipViaNotebook(runDir: string, index: number, fingerprint: string,
  options: { session?: LtxNotebookSession; transport?: LtxTransport<LtxNotebookSession> } = {}) {
  return enqueue(async () => {
    const session = options.session ?? await readLtxNotebookSession();
    if (!session) throw new Error("Nenhum notebook Colab/Kaggle conectado.");
    const request = await readLtxSceneRequest(runDir, index);
    if (request.media !== "video" || request.fingerprint !== fingerprint) throw new Error("A cena mudou.");
    const imagePng = await readLtxInputImage(runDir, index, fingerprint);
    if (!imagePng) throw new Error("A cena ainda não tem imagem inicial.");
    const outputDir = path.join(ltxSceneDir(runDir, index), "notebook", `${Date.now()}-${randomUUID().slice(0, 8)}`);
    const graph = session.profile === "lite" ? buildLtxLiteWorkflow(request.prompt)
      : buildLtxWorkflow(request.prompt, undefined, undefined, { sparseAttention: session.sparseAttention });
    await animateLtxScene({ session, prompt: request.prompt, imagePng, outputDir, graph },
      options.transport ?? notebookTransport(session));
    await attachNotebookLtxClip(runDir, index, fingerprint, outputDir);
    return outputDir;
  });
}

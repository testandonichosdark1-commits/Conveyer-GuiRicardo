/**
 * A Colab/Kaggle notebook running ComfyUI behind workers/ltx-notebook/conveyer_proxy.py,
 * reached through a public HTTPS tunnel. Pure types/validation only (no IO), so scene.ts
 * can accept it next to the Runpod lease without importing settings or the filesystem.
 *
 * Unlike a Runpod lease, nothing here is billed per hour by us: the notebook runtime is
 * the operator's own Colab/Kaggle quota, started and stopped by them. So there is no
 * guardian and no stop step — the proxy's bearer token is the access control.
 */
export type LtxNotebookSession = {
  kind: "notebook";
  /** Used as the ComfyUI client_id and as the attempt directory name. */
  approvalId: string;
  /** Public tunnel origin, e.g. https://foo-bar.trycloudflare.com — never a path. */
  baseUrl: string;
  /** Bearer token printed by the notebook; never sent to the browser. */
  token: string;
  connectedAt: number;
  /** Colab ends a runtime after at most ~12-24 h; past that the session is stale anyway. */
  deadline: number;
  gpu: string;
  vramGb: number;
  /** The notebook has the BlockSparseAttention (sol-attn) node used on the Runpod profile. */
  sparseAttention: boolean;
  /** "full" = the 22B graph (>= 40 GB GPUs); "lite" = LTX-Video 2B for a 16 GB T4. Absent = full. */
  profile?: "full" | "lite";
};

export const NOTEBOOK_SESSION_HOURS = 12;
/** Tunnel hosts the notebook can produce. Anything else is refused before any request. */
const TUNNEL_HOST_SUFFIXES = [".trycloudflare.com", ".ngrok-free.app", ".ngrok.app", ".ngrok.io"];

export function normalizeNotebookUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Cole o endereço https mostrado pelo notebook."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      !TUNNEL_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix) && url.hostname.length > suffix.length)) {
    throw new Error("Use o endereço https do túnel (trycloudflare.com ou ngrok) mostrado pelo notebook, sem caminho.");
  }
  return `${url.protocol}//${url.hostname}/`;
}

export function isNotebookSession(session: unknown): session is LtxNotebookSession {
  return Boolean(session && typeof session === "object" && (session as { kind?: unknown }).kind === "notebook");
}

export function validateNotebookSession(session: LtxNotebookSession, now: number) {
  if (normalizeNotebookUrl(session.baseUrl) !== session.baseUrl) throw new Error("Endereço do notebook inválido.");
  if (!/^nb-[a-zA-Z0-9_-]{8,60}$/.test(session.approvalId) || !/^[A-Za-z0-9_-]{24,200}$/.test(session.token) ||
      !Number.isFinite(session.connectedAt) || !Number.isFinite(session.deadline) ||
      session.connectedAt > now + 1000 || session.deadline <= now ||
      session.deadline - session.connectedAt > NOTEBOOK_SESSION_HOURS * 3600_000 ||
      (session.profile !== undefined && session.profile !== "full" && session.profile !== "lite")) {
    throw new Error("A conexão com o notebook expirou. Conecte novamente.");
  }
}

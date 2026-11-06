import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR } from "../../data-dir";
import { getSetting } from "../../settings";
import { resolveFfmpeg } from "../../ffmpeg-bin";
import { validateLtxSession, type LtxSession, type LtxTransport } from "./scene";

const execFileAsync = promisify(execFile);
export const LTX_SESSION_DIR = path.join(DATA_DIR, "ltx-session");
export const LTX_TEST_DIR = path.join(DATA_DIR, "ltx-tests");

export async function requestLtxStop(approvalId: string): Promise<boolean> {
  try {
    const session = JSON.parse(await fs.readFile(path.join(LTX_SESSION_DIR, "session.json"), "utf8")) as LtxSession;
    if (session.approvalId !== approvalId) return false;
    await fs.writeFile(path.join(LTX_SESSION_DIR, "STOP_NOW"), "stop", { mode: 0o600 });
    return true;
  } catch { return false; }
}

export async function guardianVerifiedStop(approvalId: string): Promise<boolean> {
  try {
    const session = JSON.parse(await fs.readFile(path.join(LTX_SESSION_DIR, "session.json"), "utf8")) as LtxSession;
    const armed = JSON.parse(await fs.readFile(path.join(LTX_SESSION_DIR, "armed.json"), "utf8"));
    return session.approvalId === approvalId && armed.approvalId === approvalId &&
      armed.podId === session.podId && armed.state === "stopped";
  } catch { return false; }
}

export async function readLtxSession(): Promise<LtxSession | null> {
  try {
    const session = JSON.parse(await fs.readFile(path.join(LTX_SESSION_DIR, "session.json"), "utf8")) as LtxSession;
    validateLtxSession(session, Date.now());
    await assertLocalGuardian(session);
    return session;
  } catch { return null; }
}

async function assertLocalGuardian(session: LtxSession) {
  process.kill(session.guardianPid, 0);
  const armed = JSON.parse(await fs.readFile(path.join(LTX_SESSION_DIR, "armed.json"), "utf8")) as {
    approvalId: string; podId: string; pid: number; deadline: number; observedAt: number; state: string;
  };
  if (armed.approvalId !== session.approvalId || armed.podId !== session.podId ||
      armed.pid !== session.guardianPid || armed.deadline !== session.deadline ||
      armed.state !== "armed" || Date.now() - armed.observedAt > 30_000 || armed.observedAt > Date.now() + 1000 ||
      await fs.stat(path.join(LTX_SESSION_DIR, "STOP_NOW")).then(() => true, () => false)) {
    throw new Error("A parada automática independente não está confirmada.");
  }
}

async function runpodRead(session: LtxSession) {
  const key = getSetting("RUNPOD_API_KEY").trim();
  if (!key) throw new Error("RUNPOD_API_KEY não configurado.");
  const response = await fetch(`https://api.runpod.io/v2/pods/${session.podId}`, {
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "Conveyer-LTX/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Consulta Runpod HTTP ${response.status}`);
  const pod = await response.json() as { name: string; status: string; cost: number };
  if (pod.name !== session.podName) throw new Error("A GPU não pertence a esta autorização.");
  return pod;
}

/** Streams one generated clip to a new file, capped so a bad response can't fill the disk. */
export async function writeLtxDownload(response: Response, outputPath: string) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Vídeo vazio.");
  const output = await fs.open(outputPath, "wx", 0o600);
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 128 * 1024 * 1024) throw new Error("Vídeo maior que o limite de uma cena.");
      await output.writeFile(value);
    }
    if (total < 1000) throw new Error("Vídeo incompleto.");
  } finally { await reader.cancel().catch(() => {}); await output.close(); }
}

/**
 * CPU-only, audio dropped for the narration. Full profile: crop the 1920x1088 output to
 * 1080p. Lite (832x480): scale to cover 1920x1080, then center-crop — never stretch.
 */
export async function finalizeLtxClip(rawPath: string, finalPath: string, profile: "full" | "lite" = "full") {
  const filter = profile === "lite"
    ? "scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,setsar=1"
    : "crop=1920:1080:0:4";
  await execFileAsync(resolveFfmpeg(), ["-nostdin", "-i", rawPath, "-map", "0:v:0",
    "-vf", filter, "-an", "-c:v", "libx264", "-crf", "18",
    "-preset", "fast", "-movflags", "+faststart", finalPath], { timeout: 120_000, maxBuffer: 1024 * 1024 });
}

export function ltxTransport(session: LtxSession): LtxTransport {
  const request = async (route: string, init: RequestInit = {}, timeout = 20_000) => {
    validateLtxSession(session, Date.now());
    if (!route.startsWith("/") || route.startsWith("//")) throw new Error("Rota local inválida.");
    const response = await fetch(new URL(route, session.comfyUrl), {
      ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, session.deadline - Date.now()))), redirect: "error",
    });
    if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
    return response;
  };
  return {
    now: Date.now,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async assertGuardian(lease) {
      await assertLocalGuardian(lease);
      const pod = await runpodRead(lease);
      if (pod.status !== "RUNNING" || !Number.isFinite(pod.cost) || pod.cost <= 0 || pod.cost > Math.min(lease.approvedGpuRate ?? 0.72, 0.99)) {
        throw new Error("GPU indisponível ou preço acima da cotação autorizada.");
      }
    },
    async request<T>(route: string, init?: RequestInit): Promise<T> {
      return await (await request(route, init)).json() as T;
    },
    async download(route, outputPath) {
      await writeLtxDownload(await request(route, {}, 120_000), outputPath);
    },
    async stopAndVerify(lease) {
      // Signal first: the separate guardian keeps stopping even if this server exits.
      await fs.writeFile(path.join(LTX_SESSION_DIR, "STOP_NOW"), "stop", { mode: 0o600 });
      const pod = await runpodRead(lease);
      if (["EXITED", "TERMINATED"].includes(pod.status)) return true;
      const key = getSetting("RUNPOD_API_KEY").trim();
      await fetch(`https://rest.runpod.io/v1/pods/${lease.podId}/stop`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "User-Agent": "Conveyer-LTX/1.0" },
        signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      for (let attempt = 0; attempt < 6; attempt++) {
        const observed = await runpodRead(lease);
        if (["EXITED", "TERMINATED"].includes(observed.status)) return true;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return false;
    },
    finalize: (rawPath, finalPath) => finalizeLtxClip(rawPath, finalPath),
  };
}

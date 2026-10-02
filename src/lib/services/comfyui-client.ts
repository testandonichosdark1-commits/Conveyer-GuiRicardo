import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { checkCancelled } from "../cancellation";

/**
 * Thin HTTP client for a local ComfyUI instance (COMFYUI_URL, default
 * http://127.0.0.1:8188), shared by every provider that runs a workflow on the
 * operator's own GPU (ltx-video.ts for b-roll, infinitetalk.ts for avatar). ComfyUI
 * itself is NOT managed by this app (unlike wigolo) — it's expected to already be
 * running; this module only talks to it over HTTP and never spawns/kills it.
 *
 * The operator's GPU has 8GB VRAM. LTX-Video and InfiniteTalk can never run at the
 * SAME TIME regardless of VISUAL_CONCURRENCY/AVATAR_CONCURRENCY (those still bound
 * non-GPU work like real-footage search in parallel) — `enqueueComfy()` is the single
 * process-wide serialization point both providers go through, same promise-chain lock
 * pattern as flow-browser.ts's enqueue().
 */

export class LocalGpuError extends Error {
  constructor(message: string, public readonly code: "config" | "not_running" | "oom" | "node_missing" | "capture" | "timeout") {
    super(message);
    this.name = "LocalGpuError";
  }
}

interface ComfyUIState {
  queue: Promise<void>;
}
declare global {
  // eslint-disable-next-line no-var
  var __facelessComfyUIState: ComfyUIState | undefined;
}
const state: ComfyUIState = globalThis.__facelessComfyUIState ?? { queue: Promise.resolve() };
globalThis.__facelessComfyUIState = state;

/** Serializes EVERY ComfyUI workflow run process-wide — the one thing standing between
 *  "several beats queued concurrently" (visual-source.ts/studio-pipeline.ts both use
 *  pLimit) and two generations fighting over the same 8GB of VRAM. */
export async function enqueueComfy<T>(task: () => Promise<T>): Promise<T> {
  const previous = state.queue.catch(() => undefined);
  let release!: () => void;
  state.queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function baseUrl(): string {
  const configured = getSetting("COMFYUI_URL").trim();
  return (configured || "http://127.0.0.1:8188").replace(/\/+$/, "");
}

function timeoutMs(): number {
  const n = Number(getSetting("COMFYUI_TIMEOUT_SEC"));
  return Number.isFinite(n) && n > 0 ? Math.max(30, Math.min(3600, Math.round(n))) * 1000 : 600_000;
}

/** Read-only health check. Never throws — callers decide what "not healthy" means. */
export async function comfyuiHealthy(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${baseUrl()}/system_stats`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: "ComfyUI is reachable." };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

function assertConfigured(): void {
  if (!getSetting("COMFYUI_URL").trim() && baseUrl() !== "http://127.0.0.1:8188") {
    throw new LocalGpuError("COMFYUI_URL is empty.", "config");
  }
}

/** Uploads a local file (reference image or audio) into ComfyUI's input/ directory via
 *  its own upload endpoint, returning the filename ComfyUI assigned — the name a
 *  LoadImage/LoadAudio node in the workflow JSON must reference. */
export async function uploadComfyInput(filePath: string, kind: "image" | "audio"): Promise<string> {
  assertConfigured();
  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  // ComfyUI's /upload/image endpoint accepts any file type despite the name (audio
  // included) — there is no separate /upload/audio endpoint as of this writing.
  form.append("image", new Blob([new Uint8Array(bytes)]), path.basename(filePath));
  form.append("overwrite", "true");
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new LocalGpuError(`Could not reach ComfyUI at ${baseUrl()} to upload a${kind === "image" ? "n" : ""} ${kind}: ${(e as Error).message}`, "not_running");
  }
  if (!res.ok) throw new LocalGpuError(`ComfyUI rejected the ${kind} upload (HTTP ${res.status}).`, "capture");
  const json = (await res.json()) as { name?: string };
  if (!json.name) throw new LocalGpuError(`ComfyUI's upload response had no filename for the ${kind}.`, "capture");
  return json.name;
}

interface ComfyHistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
  outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[]; audio?: { filename: string; subfolder: string; type: string }[]; gifs?: { filename: string; subfolder: string; type: string }[] }>;
}

const OOM_RE = /CUDA out of memory|out of memory|CUDA error/i;

/** Queues a workflow (POST /prompt), then polls GET /history/{id} until it completes,
 *  fails, or the deadline passes. Polling (not the /ws websocket) on purpose: a plain
 *  GET has no socket state to reconnect across a Next.js dev-server hot-reload, and the
 *  prompt_id stays valid across one regardless. Returns the raw history entry's outputs
 *  so each provider (ltx-video.ts, infinitetalk.ts) picks its own node's output key. */
export async function runComfyWorkflow(
  runId: string,
  workflow: Record<string, unknown>,
  opts: { label: string }
): Promise<ComfyHistoryEntry["outputs"]> {
  assertConfigured();
  return enqueueComfy(async () => {
    let queueRes: Response;
    try {
      queueRes = await fetch(`${baseUrl()}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new LocalGpuError(`Could not reach ComfyUI at ${baseUrl()} (${opts.label}): ${(e as Error).message}`, "not_running");
    }
    if (!queueRes.ok) {
      const body = await queueRes.text().catch(() => "");
      if (/Cannot execute because a node is missing|Node type not found/i.test(body)) {
        throw new LocalGpuError(`ComfyUI is missing a custom node required for ${opts.label}: ${body.slice(0, 300)}`, "node_missing");
      }
      throw new LocalGpuError(`ComfyUI rejected the ${opts.label} workflow (HTTP ${queueRes.status}): ${body.slice(0, 300)}`, "capture");
    }
    const queued = (await queueRes.json()) as { prompt_id?: string; error?: unknown };
    if (!queued.prompt_id) throw new LocalGpuError(`ComfyUI accepted ${opts.label} but returned no prompt_id.`, "capture");

    const deadline = Date.now() + timeoutMs();
    while (Date.now() < deadline) {
      if (runId) checkCancelled(runId);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const histRes = await fetch(`${baseUrl()}/history/${queued.prompt_id}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (!histRes || !histRes.ok) continue;
      const hist = (await histRes.json()) as Record<string, ComfyHistoryEntry>;
      const entry = hist[queued.prompt_id];
      if (!entry) continue;
      const messages = entry.status?.messages ?? [];
      const errorMsg = messages.find(([type]) => type === "execution_error")?.[1];
      if (errorMsg) {
        const text = JSON.stringify(errorMsg);
        if (OOM_RE.test(text)) throw new LocalGpuError(`ComfyUI ran out of GPU memory during ${opts.label}. Try a lower resolution/shorter clip.`, "oom");
        throw new LocalGpuError(`ComfyUI failed on ${opts.label}: ${text.slice(0, 400)}`, "capture");
      }
      if (entry.status?.completed || entry.outputs) return entry.outputs;
    }
    throw new LocalGpuError(`${opts.label} did not finish within ${Math.round(timeoutMs() / 1000)}s.`, "timeout");
  });
}

/** Downloads one ComfyUI output file (GET /view) to a local path. */
export async function downloadComfyOutput(filename: string, subfolder: string, type: string, outPath: string): Promise<void> {
  const qs = new URLSearchParams({ filename, subfolder: subfolder || "", type: type || "output" });
  const res = await fetch(`${baseUrl()}/view?${qs.toString()}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new LocalGpuError(`ComfyUI returned HTTP ${res.status} fetching output "${filename}".`, "capture");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new LocalGpuError(`ComfyUI output "${filename}" is suspiciously small (${buf.length} bytes).`, "capture");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
}

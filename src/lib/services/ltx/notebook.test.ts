import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { root } = vi.hoisted(() => ({ root: `/tmp/conveyer-ltx-notebook-test-${process.pid}` }));
vi.mock("../../data-dir", () => ({ DATA_DIR: root }));
vi.mock("../../settings", () => ({ getSetting: () => "" }));
vi.mock("../../ffmpeg-bin", () => ({ resolveFfmpeg: () => "ffmpeg" }));
const probe = (file: string) => execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height",
  "-of", "csv=p=0", file]).toString().trim();
import { connectLtxNotebook, disconnectLtxNotebook, generateLtxClipViaNotebook, notebookTransport, readLtxNotebookSession } from "./notebook";
import { normalizeNotebookUrl, type LtxNotebookSession } from "./notebook-session";
import { acquireLtxScene, readyLtxScene, ltxSceneRequest, saveLtxImage, LtxGenerationPendingError } from "./pipeline";
import { buildLtxLiteWorkflow, buildLtxWorkflow } from "./workflow";
import { finalizeLtxClip } from "./session";
import { execFileSync } from "node:child_process";
import type { LtxTransport } from "./scene";

const token = "tok_abcdefghijklmnopqrstuvwxyz012345";
const healthy = { ok: true, comfy: true, models_ready: true, gpu: "NVIDIA A100-SXM4-80GB", vram_gb: 79.2, sparse_attention: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true }); });
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });

describe("notebook URL", () => {
  it("accepts only a tunnel origin over https", () => {
    expect(normalizeNotebookUrl(" https://calm-river-12.trycloudflare.com ")).toBe("https://calm-river-12.trycloudflare.com/");
    expect(normalizeNotebookUrl("https://ab12.ngrok-free.app/")).toBe("https://ab12.ngrok-free.app/");
    for (const bad of ["http://x.trycloudflare.com", "https://trycloudflare.com", "https://evil.com",
      "https://x.trycloudflare.com/view", "https://u:p@x.trycloudflare.com", "https://x.trycloudflare.com.evil.com",
      "https://127.0.0.1:8188", "not a url"]) {
      expect(() => normalizeNotebookUrl(bad), bad).toThrow();
    }
  });
});

describe("connect", () => {
  it("probes health with the bearer token and stores the session without exposing it elsewhere", async () => {
    const fetchMock = vi.fn(async () => json(healthy));
    const session = await connectLtxNotebook("https://calm-river-12.trycloudflare.com", token, fetchMock as typeof fetch);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://calm-river-12.trycloudflare.com/conveyer/health");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(init.redirect).toBe("error");
    expect(session).toMatchObject({ kind: "notebook", gpu: healthy.gpu, sparseAttention: false });
    expect(await readLtxNotebookSession()).toEqual(session);
    await disconnectLtxNotebook();
    expect(await readLtxNotebookSession()).toBeNull();
  });
  it("refuses a wrong token, a notebook still downloading models, and a malformed token", async () => {
    await expect(connectLtxNotebook("https://a1.trycloudflare.com", token, (async () => json({}, 401)) as unknown as typeof fetch))
      .rejects.toThrow(/token/);
    await expect(connectLtxNotebook("https://a1.trycloudflare.com", token,
      (async () => json({ ...healthy, models_ready: false, missing_models: ["vae/x.safetensors"] })) as unknown as typeof fetch))
      .rejects.toThrow(/vae\/x\.safetensors/);
    await expect(connectLtxNotebook("https://a1.trycloudflare.com", "short", vi.fn() as unknown as typeof fetch)).rejects.toThrow(/token/);
    expect(await readLtxNotebookSession()).toBeNull();
  });
});

describe("transport", () => {
  it("only talks to the tunnel origin with the token, and has no GPU of ours to stop", async () => {
    const fetchMock = vi.fn(async () => json({ queue_running: [], queue_pending: [] }));
    const now = Date.now();
    const session: LtxNotebookSession = { kind: "notebook", approvalId: "nb-abcdefghijkl", baseUrl: "https://a1.trycloudflare.com/",
      token, connectedAt: now, deadline: now + 3600_000, gpu: "A100", vramGb: 80, sparseAttention: true };
    const transport = notebookTransport(session, fetchMock as typeof fetch);
    await transport.request("/queue");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://a1.trycloudflare.com/queue");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${token}`);
    await expect(transport.request("//evil.com/x")).rejects.toThrow();
    expect(await transport.stopAndVerify(session)).toBe(true);
  });
});

describe("graph", () => {
  it("drops only the sol-attn node when the notebook lacks it", () => {
    const dense = buildLtxWorkflow("Forest.", undefined, undefined, { sparseAttention: false });
    expect(dense.sol).toBeUndefined();
    expect(dense.g2.inputs.model).toEqual(["m", 0]);
    expect(Object.values(dense).some((node) => JSON.stringify(node.inputs).includes('"sol"'))).toBe(false);
    expect(buildLtxWorkflow("Forest.").g2.inputs.model).toEqual(["sol", 0]);
  });
});

describe("generateLtxClipViaNotebook", () => {
  it("animates the saved start frame and attaches the clip so the scene becomes ready", async () => {
    const runDir = path.join(root, "run");
    const input = { index: 3, prompt: "Calm lake.", media: "video" as const, durationSec: 6, resolution: "1920x1080" };
    await expect(acquireLtxScene(runDir, input)).rejects.toBeInstanceOf(LtxGenerationPendingError);
    const { fingerprint } = ltxSceneRequest(input);
    await saveLtxImage(runDir, 3, fingerprint, Buffer.alloc(2000, 1));
    const now = Date.now();
    const session: LtxNotebookSession = { kind: "notebook", approvalId: "nb-abcdefghijkl", baseUrl: "https://a1.trycloudflare.com/",
      token, connectedAt: now, deadline: now + 3600_000, gpu: "A100", vramGb: 80, sparseAttention: false };
    const submitted: unknown[] = [];
    const transport: LtxTransport<LtxNotebookSession> = {
      now: Date.now, wait: async () => {}, assertGuardian: async () => {}, stopAndVerify: async () => true,
      request: (async (route: string, init?: RequestInit) => {
        if (route === "/upload/image") return { name: "entrada.png" };
        if (route === "/queue") return { queue_running: [], queue_pending: [] };
        if (route === "/prompt") { submitted.push(JSON.parse(String(init?.body))); return { prompt_id: "p1" }; }
        return { p1: { status: { completed: true }, outputs: { save: { images: [{ filename: "ltx_clipe_00001_.mp4", subfolder: "", type: "output" }] } } } };
      }) as LtxTransport["request"],
      download: async (_route, out) => { await fs.writeFile(out, Buffer.alloc(4000, 2)); },
      finalize: async (_raw, out) => { await fs.writeFile(out, Buffer.alloc(3000, 3)); },
    };
    await generateLtxClipViaNotebook(runDir, 3, fingerprint, { session, transport });
    expect(submitted).toHaveLength(1);
    expect((submitted[0] as { prompt: Record<string, unknown> }).prompt.sol).toBeUndefined();
    const ready = await readyLtxScene(runDir, ltxSceneRequest(input));
    expect(ready && (await fs.stat(ready)).size).toBe(3000);
  });
  it("refuses a scene with no start frame before any request", async () => {
    const runDir = path.join(root, "run2");
    const input = { index: 1, prompt: "Calm lake.", media: "video" as const, durationSec: 6, resolution: "1920x1080" };
    await acquireLtxScene(runDir, input).catch(() => {});
    const request = vi.fn();
    const now = Date.now();
    await expect(generateLtxClipViaNotebook(runDir, 1, ltxSceneRequest(input).fingerprint, {
      session: { kind: "notebook", approvalId: "nb-abcdefghijkl", baseUrl: "https://a1.trycloudflare.com/", token,
        connectedAt: now, deadline: now + 3600_000, gpu: "A100", vramGb: 80, sparseAttention: true },
      transport: { request } as unknown as LtxTransport<LtxNotebookSession>,
    })).rejects.toThrow(/imagem inicial/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("lite profile (16 GB T4)", () => {
  it("is recorded from the notebook's health and routes generation to the 2B graph", async () => {
    const session = await connectLtxNotebook("https://t4.trycloudflare.com", token,
      (async () => json({ ...healthy, gpu: "Tesla T4", vram_gb: 15, profile: "lite" })) as unknown as typeof fetch);
    expect(session.profile).toBe("lite");
    const runDir = path.join(root, "run-lite");
    const input = { index: 4, prompt: "Calm lake.", media: "video" as const, durationSec: 6, resolution: "1920x1080" };
    await acquireLtxScene(runDir, input).catch(() => {});
    const { fingerprint } = ltxSceneRequest(input);
    await saveLtxImage(runDir, 4, fingerprint, Buffer.alloc(2000, 1));
    let graph: Record<string, { class_type: string }> = {};
    const transport: LtxTransport<LtxNotebookSession> = {
      now: Date.now, wait: async () => {}, assertGuardian: async () => {}, stopAndVerify: async () => true,
      request: (async (route: string, init?: RequestInit) => {
        if (route === "/upload/image") return { name: "entrada.png" };
        if (route === "/queue") return { queue_running: [], queue_pending: [] };
        if (route === "/prompt") { graph = JSON.parse(String(init?.body)).prompt; return { prompt_id: "p1" }; }
        return { p1: { status: { completed: true }, outputs: { save: { images: [{ filename: "ltx_clipe_00001_.mp4", subfolder: "", type: "output" }] } } } };
      }) as LtxTransport["request"],
      download: async (_route, out) => { await fs.writeFile(out, Buffer.alloc(4000, 2)); },
      finalize: async (_raw, out) => { await fs.writeFile(out, Buffer.alloc(3000, 3)); },
    };
    await generateLtxClipViaNotebook(runDir, 4, fingerprint, { session, transport });
    expect(graph.ckpt.class_type).toBe("CheckpointLoaderSimple");
    expect(JSON.stringify(graph)).not.toContain("ltx-2.5");
  });
  it("keeps the graph shape that pinned ComfyUI 0.37.1 accepted (832x480, 121 frames, mp4 SaveVideo)", () => {
    const graph = buildLtxLiteWorkflow("Forest.");
    expect(graph.i2v.inputs).toMatchObject({ width: 832, height: 480, length: 121 });
    expect(graph.save.class_type).toBe("SaveVideo");
    expect(String(graph.pos.inputs.text)).toContain("Forest.");
  });
  it("finalize scales 832x480 to cover 1080p without stretching, and drops audio", async () => {
    const raw = path.join(root, "raw.mp4"), out = path.join(root, "final.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=832x480:rate=24", "-f", "lavfi",
      "-i", "sine=frequency=440", "-t", "1", "-pix_fmt", "yuv420p", "-shortest", raw]);
    await finalizeLtxClip(raw, out, "lite");
    expect(probe(out)).toBe("video,1920,1080");
  });
});

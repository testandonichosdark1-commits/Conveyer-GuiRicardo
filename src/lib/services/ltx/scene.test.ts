import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { animateLtxScene, ltxOutputRoute, validateLtxSession, type LtxSession, type LtxTransport } from "./scene";
import { buildLtxWorkflow, ltxPreparation } from "./workflow";

const now = 1_800_000_000_000;
const session: LtxSession = { approvalId: "approval-test-01", podId: "testpod123456", podName: "conveyer-ltx-test-01",
  comfyUrl: "http://127.0.0.1:18188/", startedAt: now, deadline: now + 65 * 60_000, budgetUsd: 2, guardianPid: 100 };
const history = { "prompt-01": { status: { completed: true, status_str: "success" },
  outputs: { save: { images: [{ filename: "ltx_clipe_00001_.mp4", subfolder: "", type: "output" }] } } } };
let dir: string;
let transport: LtxTransport;
let clock: number;
const imagePng = new Uint8Array([137, 80, 78, 71]);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "conveyer-ltx-unit-")); clock = now;
  transport = {
    assertGuardian: vi.fn(async () => {}), now: () => clock,
    wait: vi.fn(async (ms) => { clock += ms; }),
    request: vi.fn(async (route) => {
      if (route === "/upload/image") return { name: "entrada.png" };
      if (route === "/queue") return { queue_running: [], queue_pending: [] };
      if (route === "/prompt") return { prompt_id: "prompt-01" };
      return history;
    }) as LtxTransport["request"],
    download: vi.fn(async (_route, destination) => { await fs.writeFile(destination, "fake-video"); }),
    stopAndVerify: vi.fn(async () => true),
    finalize: vi.fn(async (_raw, destination) => { await fs.writeFile(destination, "fake-muted-video"); }),
  };
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const run = () => animateLtxScene({ session, prompt: "Keep the forest still.", imagePng, outputDir: dir }, transport);

describe("LTX one-scene integration without external calls", () => {
  it("preserves the validated two-stage graph and audio output", () => {
    const preparation = ltxPreparation("Forest.");
    expect(preparation.externalCalls).toBe(0);
    const graph = preparation.workflow;
    expect(graph.lat.inputs.length).toBe(145);
    expect(graph.alat.inputs.frames_number).toBe(145);
    expect(graph.g1.inputs.model).toEqual(["m", 0]);
    expect(graph.g2.inputs.model).toEqual(["sol", 0]);
    expect(graph.cv.inputs.audio).toEqual(["audio_dec", 0]);
    expect(graph.audio_dec.inputs.samples).toEqual(["sep2", 1]);
    expect(graph.m.inputs.unet_name).toContain("nvfp4");
    expect(preparation.models.files).toHaveLength(5);
    expect(preparation.models.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(graph.pos.inputs.text).toBe("Forest. Subtle handheld, micro-shakes only.");
    expect(buildLtxWorkflow("Other.").pos.inputs.text).not.toBe(graph.pos.inputs.text);
  });
  it.each([
    { deadline: now }, { budgetUsd: 3 }, { budgetUsd: 0.5 }, { deadline: now + 66 * 60_000 },
    { startedAt: now + 1 }, { guardianPid: 0 }, { podName: "existing-production" },
    { comfyUrl: "https://public.example/" }, { comfyUrl: "http://127.0.0.1:8188/private" },
  ])("rejects unsafe session before any transport call: %j", async (change) => {
    await expect(animateLtxScene({ session: { ...session, ...change }, prompt: "Forest.", imagePng, outputDir: dir }, transport)).rejects.toThrow();
    expect(transport.request).not.toHaveBeenCalled();
  });
  it("refuses a missing independent guardian before submission", async () => {
    vi.mocked(transport.assertGuardian).mockRejectedValue(new Error("guardian absent"));
    await expect(run()).rejects.toThrow("guardian absent");
    expect(transport.request).not.toHaveBeenCalled();
  });
  it("uploads the image and prompt once, stops before local finalization, saves both files", async () => {
    const result = await run();
    const calls = vi.mocked(transport.request).mock.calls;
    expect(calls.filter(([route]) => route === "/prompt")).toHaveLength(1);
    const form = calls[0][1]?.body as FormData;
    expect((form.get("image") as File).name).toBe("entrada.png");
    const submitted = JSON.parse(String(calls.find(([route]) => route === "/prompt")?.[1]?.body));
    expect(submitted.prompt.pos.inputs.text).toContain("Keep the forest still.");
    expect(vi.mocked(transport.stopAndVerify).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(transport.finalize).mock.invocationCallOrder[0]);
    expect(await fs.readFile(result.rawPath, "utf8")).toBe("fake-video");
    expect(await fs.readFile(result.finalPath, "utf8")).toBe("fake-muted-video");
    expect(JSON.parse(await fs.readFile(path.join(dir, "attempt.json"), "utf8"))).toMatchObject({ phase: "complete", stoppedVerified: true });
  });
  it("does not repeat a consumed approval, including concurrent attempts", async () => {
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(vi.mocked(transport.request).mock.calls.filter(([route]) => route === "/prompt")).toHaveLength(1);
  });
  it("never retries a lost submission response and still requests stop", async () => {
    const base = transport.request;
    transport.request = vi.fn(async (route, init) => {
      if (route === "/prompt") throw new Error("lost response; secret-should-never-be-persisted");
      return base(route, init);
    }) as LtxTransport["request"];
    await expect(run()).rejects.toThrow("não será repetido");
    expect(vi.mocked(transport.request).mock.calls.filter(([route]) => route === "/prompt")).toHaveLength(1);
    expect(transport.stopAndVerify).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(dir, "attempt.json"), "utf8")).not.toContain("secret-should");
    await expect(run()).rejects.toThrow();
    expect(vi.mocked(transport.request).mock.calls.filter(([route]) => route === "/prompt")).toHaveLength(1);
  });
  it("rejects another queued job, without submitting", async () => {
    const base = transport.request;
    transport.request = vi.fn(async (route, init) => route === "/queue" ? { queue_running: [1], queue_pending: [] } : base(route, init)) as LtxTransport["request"];
    await expect(run()).rejects.toThrow();
    expect(vi.mocked(transport.request).mock.calls.some(([route]) => route === "/prompt")).toBe(false);
    expect(transport.stopAndVerify).toHaveBeenCalledOnce();
  });
  it("does not claim success or finalize if GPU stop is unconfirmed", async () => {
    vi.mocked(transport.stopAndVerify).mockResolvedValue(false);
    await expect(run()).rejects.toThrow("Parada da GPU ainda não confirmada");
    expect(transport.finalize).not.toHaveBeenCalled();
  });
  it("stops a generation when its bounded polling expires", async () => {
    const base = transport.request;
    transport.request = vi.fn(async (route, init) => route.startsWith("/history/") ? {} : base(route, init)) as LtxTransport["request"];
    await expect(run()).rejects.toThrow();
    expect(transport.stopAndVerify).toHaveBeenCalledOnce();
    expect(transport.finalize).not.toHaveBeenCalled();
  });
  it("refuses corrupt/traversing output paths and records failed Comfy jobs", () => {
    for (const filename of ["../secret.mp4", "https://evil/video.mp4", "video..mp4"]) {
      expect(() => ltxOutputRoute({ p: { status: { completed: true }, outputs: { save: { images: [{ filename, subfolder: "", type: "output" }] } } } }, "p")).toThrow();
    }
    expect(() => ltxOutputRoute({ p: { status: { status_str: "error" } } }, "p")).toThrow();
    expect(ltxOutputRoute(history, "prompt-01")).toBe("/view?filename=ltx_clipe_00001_.mp4&subfolder=&type=output");
  });
  it("rejects malformed image names and empty prompts", () => {
    expect(() => buildLtxWorkflow("", "entrada.png")).toThrow();
    expect(() => buildLtxWorkflow("Forest", "../image.png")).toThrow();
    expect(() => validateLtxSession({ ...session, comfyUrl: "http://user:password@localhost:8188/" }, now)).toThrow();
  });
});

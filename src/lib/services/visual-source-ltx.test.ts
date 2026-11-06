import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
const { root, settings, still, autoImage, notebook } = vi.hoisted(() => ({ root: `/tmp/ltx-visual-${process.pid}`,
  settings: {} as Record<string, string>, still: vi.fn(), autoImage: vi.fn(),
  notebook: { session: null as unknown, generate: vi.fn() } }));
vi.mock("../settings", () => ({ getSetting: (key: string) => settings[key] || "" }));
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("../run-paths", () => ({ DATA_DIR: root, getRunDir: () => root }));
vi.mock("../db", () => ({ default: { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) } }));
vi.mock("./still-animator", () => ({ animateStill: still }));
// Images now generate automatically (no manual batch/approval) via this module — stubbed
// here so these tests stay about visual-source's ROUTING, not Codex itself (that's
// auto-image.test.ts's job).
vi.mock("./ltx/auto-image", () => ({ generateLtxImageAutomatically: autoImage }));
// The real module reads <DATA_DIR>/ltx-session/notebook.json — never the operator's own here.
vi.mock("./ltx/notebook", () => ({ readLtxNotebookSession: async () => notebook.session,
  generateLtxClipViaNotebook: notebook.generate }));
import { acquireVisual } from "./visual-source";
import { attachLtxClip, attachImportedLtxClip, LtxGenerationPendingError, readLtxSceneRequest, saveLtxImage } from "./ltx/pipeline";
import type { Beat } from "./studio-plan";
const beat = { index: 2, startMs: 0, endMs: 6000, source: "ai", layout: "broll",
  text: "Quiet forest", visualQuery: "forest path", aiMedia: "video" } as Beat;
let network: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root);
  Object.assign(settings, { AI_PROVIDER: "ltx", KIE_AI_MEDIA: "video", AI_REGEN_ATTEMPTS: "8", HIGGSFIELD_ENABLED: "1", MAGNIFIC_ENABLED: "1" });
  network = vi.fn(() => { throw new Error("No external calls permitted"); }); vi.stubGlobal("fetch", network); still.mockReset();
  autoImage.mockReset(); notebook.session = null; notebook.generate.mockReset();
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });
it("routes a missing LTX beat into the pause instead of retries or another paid provider", async () => {
  await expect(acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set())).rejects.toBeInstanceOf(LtxGenerationPendingError);
  expect(network).not.toHaveBeenCalled(); expect(still).not.toHaveBeenCalled();
});
it("reuses an applied clip through the actual visual-source path without generation", async () => {
  await acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set()).catch(() => {});
  const r = await readLtxSceneRequest(root, 2), job = path.join(root, "approved-job"); await fs.mkdir(job);
  await fs.writeFile(path.join(job, "attempt.json"), JSON.stringify({ phase: "complete", stoppedVerified: true }));
  await fs.writeFile(path.join(job, "scene_1080p.mp4"), Buffer.alloc(2000, 45));
  await attachLtxClip(root, 2, r.fingerprint, job);
  expect(await acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set())).toMatchObject({ kind: "ai", provider: "ltx:video" });
  expect((await fs.stat(path.join(root, "out.mp4"))).size).toBe(2000); expect(network).not.toHaveBeenCalled();
});
it("hard image-only mode honors the operator even when the planner requests video", async () => {
  settings.KIE_AI_MEDIA = "image";
  await acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set()).catch(() => {});
  const r = await readLtxSceneRequest(root, 2); expect(r.media).toBe("image");
  await saveLtxImage(root, 2, r.fingerprint, Buffer.alloc(2000));
  expect(await acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set())).toMatchObject({ provider: "ltx:image" });
  expect(still).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled();
});

it("a local image rendering failure is an ordinary beat failure, not a pause — unlike video, images need no human in the loop", async () => {
  settings.KIE_AI_MEDIA = "image";
  await acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set()).catch(() => {});
  const r = await readLtxSceneRequest(root, 2); await saveLtxImage(root, 2, r.fingerprint, Buffer.alloc(2000));
  still.mockRejectedValueOnce(new Error("Local encode failed"));
  const rejection = acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set());
  await expect(rejection).rejects.not.toBeInstanceOf(LtxGenerationPendingError);
  await expect(rejection).rejects.toThrow("Local encode failed");
  expect(network).not.toHaveBeenCalled();
});

it("a missing image is generated automatically — no manual batch, no approval, follows the planner's own prompt", async () => {
  settings.KIE_AI_MEDIA = "image";
  autoImage.mockImplementation(async (runDir: string, _runId: string, index: number, fingerprint: string) => {
    await saveLtxImage(runDir, index, fingerprint, Buffer.alloc(2000));
  });
  const result = await acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set());
  expect(result).toMatchObject({ kind: "ai", provider: "ltx:image" });
  expect(autoImage).toHaveBeenCalledOnce();
  const [, runId, index, , description] = autoImage.mock.calls[0];
  expect(runId).toBe("ltx-test-run"); expect(index).toBe(2);
  expect(typeof description).toBe("string"); expect(description.length).toBeGreaterThan(0);
  expect(still).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled();
});

it("a failed automatic image generation is an ordinary beat failure (neighbour-reuse eligible), never a run-wide pause", async () => {
  settings.KIE_AI_MEDIA = "image";
  autoImage.mockRejectedValue(new Error("usage limit exceeded"));
  const rejection = acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set());
  await expect(rejection).rejects.not.toBeInstanceOf(LtxGenerationPendingError);
  await expect(rejection).rejects.toThrow("usage limit exceeded");
  expect(still).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});

it("a video beat never touches automatic image generation", async () => {
  await acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set()).catch(() => {});
  expect(autoImage).not.toHaveBeenCalled();
});

describe("Colab/Kaggle notebook connected", () => {
  beforeEach(() => { notebook.session = { kind: "notebook", gpu: "NVIDIA A100-SXM4-80GB" }; });
  it("generates the start frame, then the clip on the notebook, without pausing the run", async () => {
    autoImage.mockImplementation(async (runDir: string, _runId: string, index: number, fingerprint: string) => {
      await saveLtxImage(runDir, index, fingerprint, Buffer.alloc(2000));
    });
    notebook.generate.mockImplementation(async (runDir: string, index: number, fingerprint: string) => {
      const clip = path.join(root, "nb-clip.mp4"); await fs.writeFile(clip, Buffer.alloc(3000, 7));
      await attachImportedLtxClip(runDir, index, fingerprint, clip);
    });
    const result = await acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set());
    expect(result).toMatchObject({ kind: "ai", provider: "ltx:notebook" });
    expect(autoImage).toHaveBeenCalledOnce(); expect(notebook.generate).toHaveBeenCalledOnce();
    expect((await fs.stat(path.join(root, "out.mp4"))).size).toBe(3000); expect(network).not.toHaveBeenCalled();
  });
  it("reuses an existing start frame instead of generating another", async () => {
    const connected = notebook.session; notebook.session = null;
    await acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set()).catch(() => {});
    notebook.session = connected;
    const r = await readLtxSceneRequest(root, 2); await saveLtxImage(root, 2, r.fingerprint, Buffer.alloc(2000));
    notebook.generate.mockImplementation(async (runDir: string, index: number, fingerprint: string) => {
      const clip = path.join(root, "nb-clip.mp4"); await fs.writeFile(clip, Buffer.alloc(3000, 7));
      await attachImportedLtxClip(runDir, index, fingerprint, clip);
    });
    await acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set());
    expect(autoImage).not.toHaveBeenCalled();
  });
  it("a notebook failure pauses the scene (resumable), never reuses a neighbour", async () => {
    autoImage.mockImplementation(async (runDir: string, _runId: string, index: number, fingerprint: string) => {
      await saveLtxImage(runDir, index, fingerprint, Buffer.alloc(2000));
    });
    notebook.generate.mockRejectedValue(new Error("ComfyUI HTTP 500"));
    await expect(acquireVisual("ltx-test-run", beat, path.join(root, "out.mp4"), new Set())).rejects.toBeInstanceOf(LtxGenerationPendingError);
  });
});

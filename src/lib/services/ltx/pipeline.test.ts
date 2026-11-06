import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { acquireLtxScene, attachImportedLtxClip, attachLtxClip, ltxSceneDir, listLtxScenes, readLtxSceneRequest,
  readyLtxScene, saveLtxImage, LtxGenerationPendingError } from "./pipeline";
import { ManualGenerationPendingError } from "../manual-pending";
const root = `/tmp/ltx-pipeline-${process.pid}`;
const input = { index: 3, prompt: "Forest. Subtle handheld, micro-shakes only.", media: "video" as const,
  durationSec: 6, resolution: "1920x1080" };
beforeEach(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root); });
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });
async function pending(data = input) {
  await expect(acquireLtxScene(root, data)).rejects.toBeInstanceOf(LtxGenerationPendingError);
  return readLtxSceneRequest(root, data.index);
}
async function job(stopped = true, phase = "complete") {
  const dir = path.join(root, "job-approved"); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "attempt.json"), JSON.stringify({ stoppedVerified: stopped, phase }));
  await fs.writeFile(path.join(dir, "scene_1080p.mp4"), Buffer.alloc(2000, 42)); return dir;
}
it("missing scenes stage locally and use the pipeline pause, without any network", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const request = await pending();
  expect(new LtxGenerationPendingError(3)).toBeInstanceOf(ManualGenerationPendingError);
  expect((await listLtxScenes(root))[0]).toMatchObject({ ...request, ready: false });
  expect(fetch).not.toHaveBeenCalled();
});
it("a stopped successful clip is applied and reused on Resume without another generation", async () => {
  const r = await pending(); const dir = await job();
  await attachLtxClip(root, 3, r.fingerprint, dir);
  expect(await acquireLtxScene(root, input)).toBe(path.join(ltxSceneDir(root, 3), "clip.mp4"));
  expect((await listLtxScenes(root))[0].ready).toBe(true);
});
it("imports a validated notebook clip without claiming a RunPod stop verification", async () => {
  const r = await pending();
  const source = path.join(root, "notebook.mp4");
  await fs.writeFile(source, Buffer.alloc(2000, 24));
  await attachImportedLtxClip(root, 3, r.fingerprint, source);
  expect(await acquireLtxScene(root, input)).toBe(path.join(ltxSceneDir(root, 3), "clip.mp4"));
  expect(JSON.parse(await fs.readFile(path.join(ltxSceneDir(root, 3), "result.json"), "utf8")))
    .toMatchObject({ fingerprint: r.fingerprint, media: "video", source: "notebook-upload" });
  expect((await listLtxScenes(root))[0].ready).toBe(true);
});
it.each([[false, "complete"], [true, "submitted"], [true, "failed"]])("refuses unverified stop or incomplete job (%s %s)", async (stop, phase) => {
  const r = await pending(); await expect(attachLtxClip(root, 3, r.fingerprint, await job(stop, phase))).rejects.toThrow("confirmadas");
  expect(await readyLtxScene(root, r)).toBeNull();
});
it("changing a prompt invalidates the old clip and refuses applying a stale target", async () => {
  const r = await pending(), dir = await job(); await attachLtxClip(root, 3, r.fingerprint, dir);
  const changed = await pending({ ...input, prompt: "Different scene" });
  await expect(attachLtxClip(root, 3, r.fingerprint, dir)).rejects.toThrow("mudou");
  expect(await readyLtxScene(root, changed)).toBeNull();
});
it("image-only preparation supplies a still and cannot accept a paid video", async () => {
  await expect(acquireLtxScene(root, { ...input, media: "image" })).rejects.toBeInstanceOf(LtxGenerationPendingError);
  const r = await readLtxSceneRequest(root, 3);
  await saveLtxImage(root, 3, r.fingerprint, Buffer.alloc(2000));
  expect(await readyLtxScene(root, r)).toBe(path.join(ltxSceneDir(root, 3), "image.png"));
  await expect(attachLtxClip(root, 3, r.fingerprint, await job())).rejects.toThrow("mudou");
});
it("video preparation saves the initial frame but keeps the scene pending", async () => {
  const r = await pending(); await saveLtxImage(root, 3, r.fingerprint, Buffer.alloc(2000));
  expect(await readyLtxScene(root, r)).toBeNull();
});
it("applying a finished job again is a local recovery and leaves other scenes pending", async () => {
  const r = await pending(); await pending({ ...input, index: 4 }); const dir = await job();
  await attachLtxClip(root, 3, r.fingerprint, dir); await attachLtxClip(root, 3, r.fingerprint, dir);
  expect((await listLtxScenes(root)).map(s => s.ready)).toEqual([true, false]);
});
it.each([-1, 1.5, 100000, NaN])("rejects unsafe scene index %s", (index) => {
  expect(() => ltxSceneDir(root, index)).toThrow("inválida");
});

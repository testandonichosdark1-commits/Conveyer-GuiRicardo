import { beforeEach, afterEach, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { prepareImageJob, readImageJob, reserveImageJob, executeImageJob, recoverImageJob, imageJobBytes, imageJobDir, type ImageDriver } from "./codex-image-jobs";
import { acquireLtxScene, readLtxSceneRequest, saveLtxImage, readyLtxScene, ltxSceneRequest } from "./ltx/pipeline";
let root: string, jobs: string, home: string, imagePath: string;
const target = { runId: "run-test-123", index: 2, fingerprint: "a".repeat(64) };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-image-jobs-")); jobs = path.join(root, "jobs"); home = path.join(root, "account");
  imagePath = path.join(home, "generated_images", "thread1", "image.png");
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await sharp({ create: { width: 512, height: 288, channels: 3, background: "blue" } }).png().toFile(imagePath);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function driver() {
  const d: ImageDriver = { generate: vi.fn(async (_prompt, record) => { await record("thread1"); return { threadId: "thread1", image: { savedPath: imagePath } }; }), recover: vi.fn(async () => ({ savedPath: imagePath })), close: vi.fn(async () => {}) };
  return { d, connect: vi.fn(async () => d) };
}
it("preparation is local and keeps the stable result across reloads", async () => {
  const job = await prepareImageJob(jobs, target, "Carry a used chair to the curb.", "controller");
  expect(job.prompt).toContain("Amateur smartphone");
  expect(job.prompt.length).toBeLessThan(600);
  expect((await prepareImageJob(jobs, target, job.description, job.model)).id).toBe(job.id);
  const { d, connect } = driver(); await reserveImageJob(jobs, job.id, true);
  await executeImageJob(jobs, job.id, home, connect);
  const reloaded = await prepareImageJob(jobs, target, job.description, job.model);
  expect(reloaded.phase).toBe("complete"); expect(d.generate).toHaveBeenCalledTimes(1);
  expect((await imageJobBytes(jobs, job.id)).length).toBeGreaterThan(0);
});
it("rejects missing approval, duplicate clicks and duplicate executions", async () => {
  const job = await prepareImageJob(jobs, target, "Chair.", "controller");
  await expect(reserveImageJob(jobs, job.id, false)).rejects.toThrow("explicitamente");
  const reservations = await Promise.allSettled([reserveImageJob(jobs, job.id, true), reserveImageJob(jobs, job.id, true)]);
  expect(reservations.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const { d, connect } = driver(); await executeImageJob(jobs, job.id, home, connect);
  await expect(executeImageJob(jobs, job.id, home, connect)).rejects.toThrow();
  await expect(reserveImageJob(jobs, job.id, true)).rejects.toThrow("já foi usada");
  expect(d.generate).toHaveBeenCalledTimes(1);
});
it("never reconnects or regenerates on image validation failure; recovers the original thread", async () => {
  const job = await prepareImageJob(jobs, target, "Chair.", "controller");
  const { d, connect } = driver();
  await sharp({ create: { width: 512, height: 512, channels: 3, background: "blue" } }).png().toFile(imagePath);
  await reserveImageJob(jobs, job.id, true); await executeImageJob(jobs, job.id, home, connect);
  expect(await readImageJob(jobs, job.id)).toMatchObject({ phase: "needs-recovery", threadId: "thread1" });
  expect(d.generate).toHaveBeenCalledTimes(1); expect(d.close).toHaveBeenCalledTimes(1);
  await sharp({ create: { width: 512, height: 288, channels: 3, background: "blue" } }).png().toFile(imagePath);
  expect((await recoverImageJob(jobs, job.id, home, connect)).phase).toBe("complete");
  expect(d.generate).toHaveBeenCalledTimes(1); expect(d.recover).toHaveBeenCalledWith("thread1");
});
it("preserves consumed authorization when connection fails before a prompt", async () => {
  const job = await prepareImageJob(jobs, target, "Chair.", "controller");
  await reserveImageJob(jobs, job.id, true);
  await executeImageJob(jobs, job.id, home, async () => { throw Error("offline"); });
  expect((await readImageJob(jobs, job.id)).phase).toBe("needs-recovery");
  await expect(reserveImageJob(jobs, job.id, true)).rejects.toThrow("usada");
});
it("binds approval to prompt, scene and model; rejects path traversal and changed bytes", async () => {
  const job = await prepareImageJob(jobs, target, "Chair.", "controller");
  expect((await prepareImageJob(jobs, { ...target, index: 3 }, "Chair.", "controller")).id).not.toBe(job.id);
  expect((await prepareImageJob(jobs, target, "Other.", "controller")).id).not.toBe(job.id);
  expect((await prepareImageJob(jobs, target, "Chair.", "other-model")).id).not.toBe(job.id);
  expect(() => imageJobDir(jobs, "../outside")).toThrow();
  const { connect } = driver(); await reserveImageJob(jobs, job.id, true); await executeImageJob(jobs, job.id, home, connect);
  await fs.writeFile(path.join(imageJobDir(jobs, job.id), "image.png"), "changed");
  await expect(imageJobBytes(jobs, job.id)).rejects.toThrow("mudou");
});
it("feeds a generated image into a still scene; Resume reuses it without another turn", async () => {
  const runDir = path.join(root, "run");
  const scene = { index: 2, prompt: "Chair.", imageDescription: "Used chair at the curb.", media: "image" as const, durationSec: 6, resolution: "1920x1080" };
  await expect(acquireLtxScene(runDir, scene)).rejects.toThrow();
  const request = await readLtxSceneRequest(runDir, 2);
  const job = await prepareImageJob(jobs, { ...target, fingerprint: request.fingerprint }, scene.imageDescription, "controller");
  const { d, connect } = driver(); await reserveImageJob(jobs, job.id, true); await executeImageJob(jobs, job.id, home, connect);
  const normalized = await sharp(await imageJobBytes(jobs, job.id)).resize(1920, 1080).png().toBuffer();
  await saveLtxImage(runDir, 2, request.fingerprint, normalized);
  expect(await readyLtxScene(runDir, request)).not.toBeNull();
  expect(await acquireLtxScene(runDir, scene)).toContain("image.png");
  expect(d.generate).toHaveBeenCalledTimes(1);
});
it("image-description metadata preserves previously saved scene identities", () => {
  const old = { index: 2, prompt: "Chair.", media: "video" as const, durationSec: 6, resolution: "1920x1080" };
  expect(ltxSceneRequest({ ...old, imageDescription: "Chair detail." }).fingerprint).toBe(ltxSceneRequest(old).fingerprint);
});

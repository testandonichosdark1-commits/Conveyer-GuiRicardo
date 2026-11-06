import { beforeEach, afterEach, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ImageDriver } from "../codex-image-jobs";

const { dataRoot, configured, profile, connect } = vi.hoisted(() => ({
  dataRoot: `/tmp/ltx-auto-image-${process.pid}`,
  configured: vi.fn(async () => true),
  profile: vi.fn(() => ({ accountHome: "/fake/account", model: "gpt-6-luna" })),
  connect: vi.fn(),
}));
// auto-image.ts resolves its own jobsRoot from DATA_DIR, same as the manual-batch route —
// isolate it from the real user data directory, same reason every other test mocks this.
vi.mock("../../data-dir", () => ({ DATA_DIR: dataRoot }));
vi.mock("../codex-image-runtime", () => ({
  codexImageConfigured: configured,
  codexImageProfile: profile,
  connectImageDriver: connect,
}));

import { prepareImageJob, reserveImageJob, executeImageJob, readImageJob, imageJobDir } from "../codex-image-jobs";
import { acquireLtxScene, ltxSceneRequest, readLtxSceneRequest, readyLtxScene } from "./pipeline";
import { generateLtxImageAutomatically } from "./auto-image";

const jobsRoot = path.join(dataRoot, "codex-images", "jobs");
const sceneRequest = { index: 4, prompt: "A used chair sitting at the curb, documentary style.",
  imageDescription: "A used chair at the curb.", media: "image" as const, durationSec: 6, resolution: "1920x1080" };
const fingerprint = ltxSceneRequest(sceneRequest).fingerprint;
let root: string, imagePath: string;
// generateLtxImageAutomatically's real precondition (enforced by saveLtxImage, which it
// calls internally): request.json for this beat must already exist — in production that
// is written by acquireLtxScene's own pending throw, right before visual-source.ts calls
// this function. Mirrored in beforeEach so every test starts from that same precondition.
const target = { runId: "run-auto-123", index: sceneRequest.index, fingerprint };

let accountHome: string;
beforeEach(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true });
  root = path.join(dataRoot, "run-dir");
  await fs.mkdir(root, { recursive: true });
  accountHome = path.join(dataRoot, "account");
  // Mirrors saveCodexImage's own contract (codex-images.ts): the result must resolve
  // inside <accountHome>/generated_images, so the fake image has to actually live there.
  imagePath = path.join(accountHome, "generated_images", "thread1", "image.png");
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await sharp({ create: { width: 512, height: 288, channels: 3, background: "blue" } }).png().toFile(imagePath);
  await acquireLtxScene(root, sceneRequest).catch(() => {}); // persists request.json, as acquireAi would
  configured.mockReset().mockResolvedValue(true);
  profile.mockReset().mockReturnValue({ accountHome, model: "gpt-6-luna" });
  connect.mockReset();
});
afterEach(async () => { await fs.rm(dataRoot, { recursive: true, force: true }); });

function driver() {
  const d: ImageDriver = {
    generate: vi.fn(async (_prompt, record) => { await record("thread1"); return { threadId: "thread1", image: { savedPath: imagePath } }; }),
    recover: vi.fn(async () => ({ savedPath: imagePath })),
    close: vi.fn(async () => {}),
  };
  return { d, connect: vi.fn(async () => d) };
}

it("refuses up front when the exclusive Codex account isn't configured — never reaches the pool", async () => {
  configured.mockResolvedValue(false);
  await expect(generateLtxImageAutomatically(root, target.runId, target.index, target.fingerprint, "A used chair at the curb."))
    .rejects.toThrow("não configurada");
  expect(connect).not.toHaveBeenCalled();
});

it("prepares, reserves and executes a fresh job end to end, with no approval anywhere in the path", async () => {
  const { d, connect: conn } = driver();
  connect.mockImplementation(conn);
  await generateLtxImageAutomatically(root, target.runId, target.index, target.fingerprint, "A used chair at the curb.");
  expect(d.generate).toHaveBeenCalledTimes(1);
  const request = await readLtxSceneRequest(root, target.index);
  expect(request.fingerprint).toBe(target.fingerprint);
  expect(await readyLtxScene(root, request)).not.toBeNull();
});

it("a job left RESERVED by a crashed earlier attempt is executed, never re-reserved", async () => {
  const { d, connect: conn } = driver();
  connect.mockImplementation(conn);
  const job = await prepareImageJob(jobsRoot, target, "A used chair at the curb.", "gpt-6-luna");
  await reserveImageJob(jobsRoot, job.id, true); // simulates: a previous process reserved it and died before executing
  await generateLtxImageAutomatically(root, target.runId, target.index, target.fingerprint, "A used chair at the curb.");
  expect(d.generate).toHaveBeenCalledTimes(1);
  expect((await readImageJob(jobsRoot, job.id)).phase).toBe("complete");
});

it("a job left GENERATING by a crashed earlier attempt is recovered, never resubmitted", async () => {
  const { d, connect: conn } = driver();
  connect.mockImplementation(conn);
  const job = await prepareImageJob(jobsRoot, target, "A used chair at the curb.", "gpt-6-luna");
  await reserveImageJob(jobsRoot, job.id, true);
  // Force the stored state to "generating" with a real threadId, as if a previous process
  // died right after Codex accepted the turn but before the result was read back.
  const jobFile = path.join(imageJobDir(jobsRoot, job.id), "job.json");
  const stuck = { ...JSON.parse(await fs.readFile(jobFile, "utf8")), phase: "generating", threadId: "thread1" };
  await fs.writeFile(jobFile, JSON.stringify(stuck));
  await generateLtxImageAutomatically(root, target.runId, target.index, target.fingerprint, "A used chair at the curb.");
  expect(d.generate).not.toHaveBeenCalled(); // never resubmitted the prompt
  expect(d.recover).toHaveBeenCalledWith("thread1"); // only recovered the existing thread
  expect((await readImageJob(jobsRoot, job.id)).phase).toBe("complete");
});

it("surfaces the job's own failure message when generation never produces a usable image", async () => {
  const d: ImageDriver = {
    generate: vi.fn(async () => { throw new Error("thread lost"); }),
    recover: vi.fn(async () => { throw new Error("nothing to recover"); }),
    close: vi.fn(async () => {}),
  };
  connect.mockResolvedValue(d);
  await expect(generateLtxImageAutomatically(root, target.runId, target.index, target.fingerprint, "A used chair at the curb."))
    .rejects.toThrow();
  // The job itself never reached "complete" — nothing was written to disk under its id.
  expect((await readImageJob(jobsRoot, (await prepareImageJob(jobsRoot, target, "A used chair at the curb.", "gpt-6-luna")).id)).phase)
    .not.toBe("complete");
});

import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareImageJob, readImageJob } from "./codex-image-jobs";
import { prepareImageBatch, reserveImageBatch } from "./codex-image-batch";
it("requires exact explicit batch consent and prevents repeated reservations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-batch-test-"));
  try {
    const jobs = await Promise.all([0, 1, 2, 3, 4].map(index => prepareImageJob(root, { runId: "run-fixture", index, fingerprint: "a".repeat(64) }, `Scene ${index}`, "fake-controller")));
    const batch = await prepareImageBatch(path.join(root, "batches"), "run-fixture", jobs.map(j => j.id));
    await expect(reserveImageBatch(root, batch, batch.jobs, false, async () => {})).rejects.toThrow("explicitamente");
    await expect(reserveImageBatch(root, batch, batch.jobs.slice(1), true, async () => {})).rejects.toThrow("mudou");
    await expect(reserveImageBatch(root, batch, batch.jobs, true, async () => { throw new Error("Cena mudou"); })).rejects.toThrow("Cena mudou");
    expect((await readImageJob(root, jobs[0].id)).phase).toBe("prepared");
    const reserved = await reserveImageBatch(root, batch, batch.jobs, true, async () => {});
    expect(reserved).toHaveLength(5); expect(reserved.every(j => j.phase === "reserved")).toBe(true);
    await expect(reserveImageBatch(root, batch, batch.jobs, true, async () => {})).rejects.toThrow("já foi autorizado");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

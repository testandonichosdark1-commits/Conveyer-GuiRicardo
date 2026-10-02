import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

/**
 * scene_jobs + scene-job-store.ts: durable state for future remote per-scene jobs.
 * Runs against a throwaway DB (FACELESS_STUDIO_DATA_DIR) — no real data, no network.
 */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scene-jobs-"));
const DB_FILE = path.join(DIR, "studio.db");

let store!: typeof import("./scene-job-store");
let db!: typeof import("./db").default;

beforeAll(async () => {
  // A PRE-EXISTING database, as an install upgrading to this version has: an old-shaped
  // runs table with a row in it, and no scene_jobs table.
  const legacy = new Database(DB_FILE);
  legacy.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL, script TEXT NOT NULL, config_json TEXT NOT NULL)");
  legacy.prepare("INSERT INTO runs (id, status, script, config_json) VALUES ('old-run', 'done', 'x', '{}')").run();
  legacy.close();

  process.env.FACELESS_STUDIO_DATA_DIR = DIR;
  db = (await import("./db")).default;
  store = await import("./scene-job-store");
});
afterEach(() => vi.unstubAllGlobals());

let n = 0;
function identity(over: Partial<import("./scene-job-store").SceneJobIdentity> = {}) {
  return {
    runId: `run-${++n}`,
    beatIndex: 3,
    stage: "still_animation" as const,
    provider: "runpod:ltx",
    inputFingerprint: "a".repeat(64),
    ...over,
  };
}
const rowCount = () => (db.prepare("SELECT COUNT(*) AS c FROM scene_jobs").get() as { c: number }).c;

describe("migration", () => {
  it("A. creates scene_jobs on an existing database without touching existing runs", () => {
    const cols = (db.prepare("PRAGMA table_info(scene_jobs)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      "id", "idempotency_key", "run_id", "beat_index", "stage", "provider", "input_fingerprint", "status",
      "attempts", "remote_job_id", "output_path", "error_code", "error_message",
      "created_at", "updated_at", "submitted_at", "completed_at",
    ]);
    expect(db.prepare("SELECT status FROM runs WHERE id = 'old-run'").get()).toEqual({ status: "done" });
    const idx = (db.prepare("PRAGMA index_list(scene_jobs)").all() as { name: string; unique: number }[]);
    expect(idx.map((i) => i.name).sort()).toEqual(
      expect.arrayContaining(["idx_scene_jobs_remote", "idx_scene_jobs_run", "idx_scene_jobs_status"])
    );
    expect(idx.some((i) => i.unique === 1)).toBe(true); // the idempotency_key UNIQUE
  });
});

describe("get-or-create", () => {
  it("B. creates a prepared job with nothing remote yet", () => {
    const { job, created } = store.getOrCreateSceneJob(identity());
    expect(created).toBe(true);
    expect(job).toMatchObject({
      status: "prepared", attempts: 0, beat_index: 3, stage: "still_animation", provider: "runpod:ltx",
      remote_job_id: null, output_path: null, submitted_at: null, completed_at: null,
    });
    expect(job.idempotency_key).toMatch(/^sj1:[0-9a-f]{64}$/);
  });

  it("C/D. the same identity returns the same row and never creates a second one", () => {
    const id = identity();
    const before = rowCount();
    const a = store.getOrCreateSceneJob(id);
    const b = store.getOrCreateSceneJob({ ...id });
    expect(b.created).toBe(false);
    expect(b.job).toEqual(a.job);
    expect(rowCount()).toBe(before + 1);
  });

  it("returns an existing job in its current state — a succeeded job is never reset", () => {
    const id = identity();
    const { job } = store.getOrCreateSceneJob(id);
    store.markSceneJobSubmitting(job.id);
    store.markSceneJobSubmitted(job.id, "rp-1");
    store.markSceneJobSucceeded(job.id, "/runs/x/broll/beat_0003.mp4");
    const again = store.getOrCreateSceneJob(id);
    expect(again.created).toBe(false);
    expect(again.job).toMatchObject({ status: "succeeded", remote_job_id: "rp-1", attempts: 1 });
  });

  it("returns failed / cancelled jobs as they are, never silently revived", () => {
    const f = identity();
    store.markSceneJobFailed(store.getOrCreateSceneJob(f).job.id, "bad_input");
    expect(store.getOrCreateSceneJob(f).job.status).toBe("failed");
    const c = identity();
    store.markSceneJobCancelled(store.getOrCreateSceneJob(c).job.id, "run cancelled");
    expect(store.getOrCreateSceneJob(c).job.status).toBe("cancelled");
  });

  it("20. two callers racing for the same logical job end with ONE row and the same identity", () => {
    const id = identity();
    const before = rowCount();
    // better-sqlite3 is synchronous, so the race is simulated at the level where it would
    // actually be decided: a second connection (a second writer) inserts the same key
    // first, and the store's own insert must lose cleanly to it.
    const other = new Database(DB_FILE);
    const key = store.buildSceneJobIdempotencyKey(id);
    other
      .prepare("INSERT INTO scene_jobs (idempotency_key, run_id, beat_index, stage, provider, input_fingerprint) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, id.runId, id.beatIndex, id.stage, id.provider, id.inputFingerprint);
    const mine = store.getOrCreateSceneJob(id);
    const theirs = other.prepare("SELECT * FROM scene_jobs WHERE idempotency_key = ?").get(key) as { id: number };
    other.close();
    expect(mine.created).toBe(false);
    expect(mine.job.id).toBe(theirs.id);
    // And the in-process case: two back-to-back callers.
    const again = [store.getOrCreateSceneJob(id), store.getOrCreateSceneJob(id)];
    expect(again.map((r) => r.job.id)).toEqual([theirs.id, theirs.id]);
    expect(rowCount()).toBe(before + 1);
  });

  it("the UNIQUE constraint itself rejects a raw duplicate insert", () => {
    const { job } = store.getOrCreateSceneJob(identity());
    expect(() =>
      db.prepare("INSERT INTO scene_jobs (idempotency_key, run_id, beat_index, stage, provider, input_fingerprint) VALUES (?, 'r', 0, 'still_animation', 'p', 'f')").run(job.idempotency_key)
    ).toThrow(/UNIQUE/);
  });

  it("rejects malformed identities before touching the database", () => {
    const before = rowCount();
    expect(() => store.getOrCreateSceneJob(identity({ runId: "" }))).toThrow(/runId/);
    expect(() => store.getOrCreateSceneJob(identity({ beatIndex: -1 }))).toThrow(/beatIndex/);
    expect(() => store.getOrCreateSceneJob(identity({ beatIndex: 1.5 }))).toThrow(/beatIndex/);
    expect(() => store.getOrCreateSceneJob(identity({ stage: "ltx" as never }))).toThrow(/stage/);
    expect(() => store.getOrCreateSceneJob(identity({ provider: "RunPod LTX" }))).toThrow(/provider/);
    expect(() => store.getOrCreateSceneJob(identity({ inputFingerprint: "" }))).toThrow(/inputFingerprint/);
    expect(rowCount()).toBe(before);
  });
});

describe("state machine", () => {
  const fresh = () => store.getOrCreateSceneJob(identity()).job;

  it("E/F/G/H. prepared → submitting → submitted → running → succeeded, each write complete", () => {
    const j = fresh();
    const s1 = store.markSceneJobSubmitting(j.id);
    expect(s1).toMatchObject({ status: "submitting", attempts: 1, remote_job_id: null });
    const s2 = store.markSceneJobSubmitted(j.id, "rp-abc");
    expect(s2).toMatchObject({ status: "submitted", remote_job_id: "rp-abc" });
    expect(s2.submitted_at).not.toBeNull();
    expect(store.markSceneJobRunning(j.id).status).toBe("running");
    const s4 = store.markSceneJobSucceeded(j.id, "/runs/x/broll/beat_0003.mp4");
    expect(s4).toMatchObject({ status: "succeeded", output_path: "/runs/x/broll/beat_0003.mp4", remote_job_id: "rp-abc" });
    expect(s4.completed_at).not.toBeNull();
  });

  it("I. submitted → succeeded directly (finished before we ever saw it running)", () => {
    const j = fresh();
    store.markSceneJobSubmitting(j.id);
    store.markSceneJobSubmitted(j.id, "rp-fast");
    expect(store.markSceneJobSucceeded(j.id, "/out.mp4").status).toBe("succeeded");
  });

  it("J. failed from prepared, submitting, submitted and running — keeping the remote id", () => {
    const p = fresh();
    expect(store.markSceneJobFailed(p.id, "bad_input", "no image").status).toBe("failed");

    const s = fresh();
    store.markSceneJobSubmitting(s.id);
    expect(store.markSceneJobFailed(s.id, "submit_outcome_unknown")).toMatchObject({ status: "failed", remote_job_id: null });

    const sub = fresh();
    store.markSceneJobSubmitting(sub.id);
    store.markSceneJobSubmitted(sub.id, "rp-sub");
    expect(store.markSceneJobFailed(sub.id, "remote_failed", "OOM")).toMatchObject({
      status: "failed", remote_job_id: "rp-sub", error_code: "remote_failed", error_message: "OOM",
    });

    const r = fresh();
    store.markSceneJobSubmitting(r.id);
    store.markSceneJobSubmitted(r.id, "rp-run");
    store.markSceneJobRunning(r.id);
    const f = store.markSceneJobFailed(r.id, "timeout");
    expect(f).toMatchObject({ status: "failed", remote_job_id: "rp-run" });
    expect(f.completed_at).not.toBeNull();
  });

  it("K. cancelled from prepared, submitted and running — but not mid-submit", () => {
    expect(store.markSceneJobCancelled(fresh().id).status).toBe("cancelled");
    const sub = fresh();
    store.markSceneJobSubmitting(sub.id);
    // While submitting we cannot know whether a remote job exists to cancel.
    expect(() => store.markSceneJobCancelled(sub.id)).toThrow(store.InvalidSceneJobTransitionError);
    store.markSceneJobSubmitted(sub.id, "rp-c");
    expect(store.markSceneJobCancelled(sub.id, "run cancelled")).toMatchObject({ status: "cancelled", remote_job_id: "rp-c" });
    const r = fresh();
    store.markSceneJobSubmitting(r.id);
    store.markSceneJobSubmitted(r.id, "rp-r");
    store.markSceneJobRunning(r.id);
    expect(store.markSceneJobCancelled(r.id).status).toBe("cancelled");
  });

  it("L. illegal transitions throw and change nothing", () => {
    const j = fresh();
    const before = store.getSceneJob(j.id);
    expect(() => store.markSceneJobSubmitted(j.id, "rp")).toThrow(/illegal transition "prepared" → "submitted"/);
    expect(() => store.markSceneJobRunning(j.id)).toThrow(store.InvalidSceneJobTransitionError);
    expect(() => store.markSceneJobSucceeded(j.id, "/x.mp4")).toThrow(store.InvalidSceneJobTransitionError);
    expect(store.getSceneJob(j.id)).toEqual(before);
    expect(() => store.markSceneJobRunning(999_999)).toThrow(/does not exist/);
  });

  it("M. terminal states are terminal — succeeded never goes back", () => {
    const j = fresh();
    store.markSceneJobSubmitting(j.id);
    store.markSceneJobSubmitted(j.id, "rp");
    store.markSceneJobSucceeded(j.id, "/x.mp4");
    for (const attempt of [
      () => store.markSceneJobRunning(j.id),
      () => store.markSceneJobSubmitting(j.id),
      () => store.markSceneJobSubmitted(j.id, "rp2"),
      () => store.markSceneJobFailed(j.id, "late"),
      () => store.markSceneJobCancelled(j.id),
      () => store.markSceneJobSucceeded(j.id, "/other.mp4"),
      () => store.markSceneJobSubmitNeverArrived(j.id, "x"),
    ]) {
      expect(attempt).toThrow(store.InvalidSceneJobTransitionError);
    }
    expect(store.getSceneJob(j.id)).toMatchObject({ status: "succeeded", output_path: "/x.mp4", remote_job_id: "rp" });
    for (const s of ["succeeded", "failed", "cancelled"] as const) expect(store.isTerminalSceneJobStatus(s)).toBe(true);
  });

  it("the transition table and the implementation agree, and every target is reachable", () => {
    const t = store.SCENE_JOB_TRANSITIONS;
    expect(t.succeeded).toEqual([]);
    expect(t.prepared).not.toContain("prepared");
    const reachable = new Set(Object.values(t).flat());
    for (const s of ["submitting", "submitted", "running", "succeeded", "failed", "cancelled", "prepared"]) {
      expect(reachable.has(s as never)).toBe(true);
    }
  });

  it("O. attempts counts submissions; submitting → prepared only on a provably undelivered request", () => {
    const j = fresh();
    store.markSceneJobSubmitting(j.id);
    const back = store.markSceneJobSubmitNeverArrived(j.id, "ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443");
    expect(back).toMatchObject({ status: "prepared", attempts: 1, error_code: "ECONNREFUSED", remote_job_id: null });
    const again = store.markSceneJobSubmitting(j.id);
    expect(again).toMatchObject({ status: "submitting", attempts: 2, error_code: null, error_message: null });
    store.markSceneJobSubmitted(j.id, "rp-2nd");
    // Once accepted, there is no way back to prepared.
    expect(() => store.markSceneJobSubmitNeverArrived(j.id, "x")).toThrow(store.InvalidSceneJobTransitionError);
    expect(store.getSceneJob(j.id)!.attempts).toBe(2);
  });

  it("required values are required — no submitted without a remote id, no succeeded without a path", () => {
    const j = fresh();
    store.markSceneJobSubmitting(j.id);
    expect(() => store.markSceneJobSubmitted(j.id, "")).toThrow(/remoteJobId/);
    expect(store.getSceneJob(j.id)!.status).toBe("submitting");
    store.markSceneJobSubmitted(j.id, "rp");
    expect(() => store.markSceneJobSucceeded(j.id, "  ")).toThrow(/outputPath/);
    expect(() => store.markSceneJobFailed(j.id, "")).toThrow(/errorCode/);
    expect(store.getSceneJob(j.id)!.status).toBe("submitted");
  });

  it("the CHECK constraints make half-written states impossible even for raw SQL", () => {
    const j = fresh();
    expect(() => db.prepare("UPDATE scene_jobs SET status = 'submitted' WHERE id = ?").run(j.id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE scene_jobs SET status = 'running' WHERE id = ?").run(j.id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE scene_jobs SET status = 'succeeded', remote_job_id = 'x' WHERE id = ?").run(j.id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE scene_jobs SET status = 'done' WHERE id = ?").run(j.id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE scene_jobs SET attempts = -1 WHERE id = ?").run(j.id)).toThrow(/CHECK/);
    expect(store.getSceneJob(j.id)!.status).toBe("prepared");
  });

  it("output_path alone does not imply success", () => {
    const j = fresh();
    db.prepare("UPDATE scene_jobs SET output_path = '/stale.mp4' WHERE id = ?").run(j.id);
    expect(store.getSceneJob(j.id)!.status).toBe("prepared");
    expect(store.listActiveSceneJobs().some((x) => x.id === j.id)).toBe(false);
  });
});

describe("identity & idempotency keys", () => {
  it("is deterministic and depends on every identity field", () => {
    const base = identity({ runId: "run-fixed" });
    const k = store.buildSceneJobIdempotencyKey(base);
    expect(store.buildSceneJobIdempotencyKey({ ...base })).toBe(k);
    for (const change of [
      { runId: "run-other" },
      { beatIndex: 4 },
      { stage: "avatar_render" as const },
      { provider: "runpod:other" },
      { inputFingerprint: "b".repeat(64) },
    ]) {
      expect(store.buildSceneJobIdempotencyKey({ ...base, ...change })).not.toBe(k);
    }
  });

  it("is not fooled by delimiters inside fields", () => {
    const a = store.buildSceneJobIdempotencyKey(identity({ runId: "r:1", provider: "p" }));
    const b = store.buildSceneJobIdempotencyKey(identity({ runId: "r", provider: "1:p" }));
    expect(a).not.toBe(b);
  });

  it("P. new inputs are a new logical job; the old one is kept as it was", () => {
    const runId = "run-p";
    const v1 = store.fingerprintSceneJobInputs({ image: "sha256:aaa", prompt: "slow push-in", seconds: 5 });
    const v2 = store.fingerprintSceneJobInputs({ image: "sha256:bbb", prompt: "slow push-in", seconds: 5 });
    const j1 = store.getOrCreateSceneJob(identity({ runId, inputFingerprint: v1 })).job;
    store.markSceneJobSubmitting(j1.id);
    store.markSceneJobSubmitted(j1.id, "rp-v1");
    const j2 = store.getOrCreateSceneJob(identity({ runId, inputFingerprint: v2 }));
    expect(j2.created).toBe(true);
    expect(j2.job.id).not.toBe(j1.id);
    expect(store.getSceneJob(j1.id)!.status).toBe("submitted");
  });

  it("fingerprints are canonical: key order does not matter, values do", () => {
    const a = store.fingerprintSceneJobInputs({ image: "x", seconds: 5, hd: true });
    expect(store.fingerprintSceneJobInputs({ hd: true, seconds: 5, image: "x" })).toBe(a);
    expect(store.fingerprintSceneJobInputs({ hd: true, seconds: 6, image: "x" })).not.toBe(a);
    expect(store.fingerprintSceneJobInputs({ hd: true, seconds: "5", image: "x" })).not.toBe(a); // types matter
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(() => store.fingerprintSceneJobInputs({})).toThrow();
  });

  it("Q/R/S. different beats, stages and providers of one run never collide", () => {
    const runId = "run-qrs";
    const ids = [
      identity({ runId, beatIndex: 0 }),
      identity({ runId, beatIndex: 1 }),
      identity({ runId, beatIndex: 1, stage: "avatar_render", provider: "runpod:infinitetalk" }),
      identity({ runId, beatIndex: 1, stage: "avatar_render", provider: "heygen" }),
    ];
    const jobs = ids.map((i) => store.getOrCreateSceneJob(i));
    expect(jobs.every((j) => j.created)).toBe(true);
    expect(new Set(jobs.map((j) => j.job.id)).size).toBe(4);
    expect(store.listSceneJobsForRun(runId).map((j) => [j.beat_index, j.stage, j.provider])).toEqual([
      [0, "still_animation", "runpod:ltx"],
      [1, "avatar_render", "runpod:infinitetalk"],
      [1, "avatar_render", "heygen"],
      [1, "still_animation", "runpod:ltx"],
    ]);
  });
});

describe("durability", () => {
  it("N. status, remote id and attempts survive a restart (fresh connection + re-run migration)", async () => {
    const { job } = store.getOrCreateSceneJob(identity({ runId: "run-restart" }));
    store.markSceneJobSubmitting(job.id);
    store.markSceneJobSubmitted(job.id, "rp-survives");

    // A new process: fresh module graph → db.ts reopens the file and re-runs its
    // (idempotent) migrations.
    vi.resetModules();
    const reopened = await import("./scene-job-store");
    const back = reopened.getSceneJob(job.id)!;
    expect(back).toMatchObject({ status: "submitted", remote_job_id: "rp-survives", attempts: 1 });
    expect(reopened.listActiveSceneJobs().map((j) => j.id)).toContain(job.id);
    expect(reopened.getOrCreateSceneJob(identity({ runId: "run-restart", beatIndex: 3 })).job.id).toBe(job.id);

    // And straight from disk, with no app code at all.
    const raw = new Database(DB_FILE, { readonly: true });
    expect(raw.prepare("SELECT status, remote_job_id FROM scene_jobs WHERE id = ?").get(job.id)).toEqual({
      status: "submitted", remote_job_id: "rp-survives",
    });
    raw.close();
  });

  it("T. the store makes no network request", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const j = store.getOrCreateSceneJob(identity()).job;
    store.markSceneJobSubmitting(j.id);
    store.markSceneJobSubmitted(j.id, "rp");
    store.markSceneJobRunning(j.id);
    store.markSceneJobSucceeded(j.id, "/x.mp4");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

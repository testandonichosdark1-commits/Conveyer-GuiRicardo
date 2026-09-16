import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 1 resume/retry — orphan reconciliation + duplicate-Resume lock.
 *
 * Uses a throwaway DATA_DIR so the real ~/.faceless-studio DB is never touched.
 * FACELESS_STUDIO_DATA_DIR must be set BEFORE db.ts is imported (it opens the
 * SQLite file at import), so db + run-lifecycle are dynamically imported after.
 */
let db: typeof import("./db").default;
let lifecycle: typeof import("./run-lifecycle");

function insertRun(id: string, status: string, owner: string | null) {
  db.prepare("INSERT INTO runs (id, status, script, config_json, owner_instance) VALUES (?, ?, '', '{}', ?)").run(id, status, owner);
}
function statusOf(id: string): string {
  return (db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string }).status;
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-lifecycle-"));
  process.env.FACELESS_STUDIO_DATA_DIR = dir;
  db = (await import("./db")).default;
  lifecycle = await import("./run-lifecycle");
});

describe("reconcileOrphanedRuns", () => {
  it("flips running/pending runs from a previous process to 'interrupted'", () => {
    insertRun("orphan-running", "running", "DEAD-PROCESS-TOKEN");
    insertRun("orphan-pending", "pending", null); // pre-owner-column / died before beginRun
    insertRun("mine-running", "running", lifecycle.INSTANCE_ID); // owned by THIS process
    insertRun("already-done", "done", "DEAD-PROCESS-TOKEN");
    insertRun("already-error", "error", "DEAD-PROCESS-TOKEN");

    const recovered = lifecycle.reconcileOrphanedRuns();

    expect(recovered).toBe(2); // only the two orphans
    expect(statusOf("orphan-running")).toBe("interrupted");
    expect(statusOf("orphan-pending")).toBe("interrupted");
    expect(statusOf("mine-running")).toBe("running"); // current process → untouched
    expect(statusOf("already-done")).toBe("done"); // terminal states untouched
    expect(statusOf("already-error")).toBe("error");
  });

  it("does not touch soft-deleted runs and is idempotent", () => {
    db.prepare("INSERT INTO runs (id, status, script, config_json, owner_instance, deleted_at) VALUES (?, 'running', '', '{}', 'DEAD', datetime('now'))").run("deleted-run");
    expect(lifecycle.reconcileOrphanedRuns()).toBe(0); // nothing left to recover
    expect(statusOf("deleted-run")).toBe("running"); // deleted rows are ignored
  });
});

describe("in-process duplicate-Resume lock", () => {
  it("reports a run active only between beginRun and endRun", () => {
    const id = "lock-run";
    insertRun(id, "interrupted", null);

    expect(lifecycle.isRunActive(id)).toBe(false);

    lifecycle.beginRun(id);
    expect(lifecycle.isRunActive(id)).toBe(true); // a second Resume would be rejected here
    // beginRun also stamps ownership so a later restart won't false-recover it
    const owner = (db.prepare("SELECT owner_instance FROM runs WHERE id = ?").get(id) as { owner_instance: string }).owner_instance;
    expect(owner).toBe(lifecycle.INSTANCE_ID);

    lifecycle.endRun(id);
    expect(lifecycle.isRunActive(id)).toBe(false); // lock released on completion
  });
});

describe("failRun (crash backstop)", () => {
  it("marks a running/pending run 'error' and releases its lock", () => {
    const id = "fail-run";
    insertRun(id, "running", null);
    lifecycle.beginRun(id);
    expect(lifecycle.isRunActive(id)).toBe(true);

    lifecycle.failRun(id, "boom");

    expect(statusOf(id)).toBe("error");
    expect(lifecycle.isRunActive(id)).toBe(false); // lock released → no leaked lock
  });

  it("never clobbers a terminal run's status", () => {
    const id = "fail-run-done";
    insertRun(id, "done", null);
    lifecycle.failRun(id, "should not apply");
    expect(statusOf(id)).toBe("done"); // guarded to running/pending only
  });
});

describe("isBenignFrameworkError (uncaughtException filter)", () => {
  it("treats client-disconnect stream errors as benign (do NOT exit)", () => {
    const byCode = Object.assign(new Error("Invalid state: Controller is already closed"), {
      code: "ERR_INVALID_STATE",
    });
    expect(lifecycle.isBenignFrameworkError(byCode)).toBe(true);
    // message-only match (some throws lose the code)
    expect(lifecycle.isBenignFrameworkError(new Error("Invalid state: Controller is already closed"))).toBe(true);
  });

  it("treats genuine pipeline faults as fatal (WILL exit → recover)", () => {
    expect(lifecycle.isBenignFrameworkError(new Error("ffmpeg exited with code 1"))).toBe(false);
    expect(lifecycle.isBenignFrameworkError(new TypeError("cannot read properties of undefined"))).toBe(false);
    expect(lifecycle.isBenignFrameworkError(undefined)).toBe(false);
  });
});

describe("multi-process detection", () => {
  it("counts another live process as a peer and reaps a dead one", () => {
    // A row for a definitely-dead pid → reaped, not counted.
    db.prepare("INSERT INTO app_instances (instance_id, pid) VALUES ('dead-peer', 2147483646)").run();
    // A row for a definitely-alive pid (this test process itself) under a
    // DIFFERENT instance id → counted as a live peer.
    db.prepare("INSERT INTO app_instances (instance_id, pid) VALUES ('live-peer', ?)").run(process.pid);

    const peers = lifecycle.registerInstanceAndCountPeers();

    expect(peers).toBe(1); // only the live one
    // dead row reaped
    expect(db.prepare("SELECT 1 FROM app_instances WHERE instance_id = 'dead-peer'").get()).toBeUndefined();
    // self registered
    const self = db.prepare("SELECT pid FROM app_instances WHERE instance_id = ?").get(lifecycle.INSTANCE_ID) as { pid: number } | undefined;
    expect(self?.pid).toBe(process.pid);
  });

  it("reports no peers when the DB holds only this process", () => {
    db.prepare("DELETE FROM app_instances WHERE instance_id <> ?").run(lifecycle.INSTANCE_ID);
    expect(lifecycle.registerInstanceAndCountPeers()).toBe(0); // self is never its own peer
  });
});

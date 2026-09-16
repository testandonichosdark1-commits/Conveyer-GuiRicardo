import { randomUUID } from "node:crypto";
import db from "./db";
import { log } from "./logger";
import { markCancelled } from "./cancellation";

/**
 * Phase 1 — run lifecycle & orphan recovery (no external infrastructure).
 *
 * The generation pipeline runs IN-PROCESS as a fire-and-forget task
 * (api/studio → runStudioPipeline, reassemble → resumeStudioPipeline). If that
 * process dies — server reboot, PM2 restart, crash, power loss — the run row is
 * frozen at status "running"/"pending" with no code path left to update it, so
 * the UI can never offer Resume. This module makes such a run self-healing.
 *
 * ── How we prove a run "belongs to a dead process" (no guessing) ──────────────
 *  INSTANCE_ID is a token minted ONCE per process start. A run stamps it
 *  (`beginRun`) the moment its pipeline begins executing. At startup,
 *  `reconcileOrphanedRuns()` runs BEFORE any run in this process starts, so
 *  every row still marked running/pending is necessarily from a PREVIOUS
 *  process — a new boot is a perfect, race-free "the old owner is gone" signal.
 *  We flip those to "interrupted" (a resumable terminal state). Runs started
 *  later in THIS process carry INSTANCE_ID and are never touched.
 *
 * ── Why a heartbeat / timeout threshold is deliberately NOT used ──────────────
 *  Every interruption in Phase-1 scope is a PROCESS DEATH. A time-based
 *  "stale for N seconds" rule would be strictly worse: a crash a few seconds
 *  before the machine finishes rebooting leaves a *recent* last-write, which a
 *  threshold misreads as "still alive" and leaves the run permanently stuck.
 *  The boot itself is the unambiguous signal, so no timing knob is required.
 *  (A heartbeat would only help detect a hung-but-alive process, which is out
 *  of scope here.) This holds because the app is single-process: better-sqlite3
 *  is a single-writer embedded DB, so there is never a second *live* owner of
 *  the same database — "not my instance" therefore always means "dead".
 *
 * ── Duplicate-Resume lock ─────────────────────────────────────────────────────
 *  `activeRuns` is an in-memory set of run ids whose pipeline is executing right
 *  now in this process. Because the pipeline runs in-process, this set is the
 *  authoritative answer to "is it running?" — the Resume endpoint rejects when
 *  `isRunActive` is true, so a second Resume can never start a duplicate
 *  pipeline (which would double-spend HeyGen/AI credits). After a restart the
 *  set is empty and the orphan is already "interrupted", so Resume is allowed.
 */

/** Unique per process start — the ownership token for runs this process runs. */
export const INSTANCE_ID = randomUUID();

const setOwnerStmt = db.prepare("UPDATE runs SET owner_instance = ? WHERE id = ?");
const listOrphansStmt = db.prepare(
  `SELECT id FROM runs
     WHERE status IN ('running', 'pending')
       AND (owner_instance IS NULL OR owner_instance <> ?)
       AND deleted_at IS NULL`
);
const reconcileStmt = db.prepare(
  `UPDATE runs SET status = 'interrupted', updated_at = datetime('now')
     WHERE status IN ('running', 'pending')
       AND (owner_instance IS NULL OR owner_instance <> ?)
       AND deleted_at IS NULL`
);

/** Runs whose pipeline is executing RIGHT NOW in this process. */
const activeRuns = new Set<string>();

/** True while this process is actively running the given run's pipeline. */
export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

/**
 * Claim a run for this process: take the in-memory execution lock and stamp
 * ownership. Call once at the very start of a pipeline (first-run OR resume),
 * right after the run flips to "running".
 */
export function beginRun(runId: string): void {
  activeRuns.add(runId);
  try {
    setOwnerStmt.run(INSTANCE_ID, runId);
  } catch {
    // ownership stamp is best-effort — the in-memory lock still holds this run
  }
}

/** Release the in-process execution lock. Call in a `finally` at pipeline end. */
export function endRun(runId: string): void {
  activeRuns.delete(runId);
}

const failRunStmt = db.prepare(
  `UPDATE runs SET status = 'error', updated_at = datetime('now')
     WHERE id = ? AND status IN ('running', 'pending')`
);

/**
 * Mark a run failed (if still running/pending) and release its in-process lock.
 * The backstop for a pipeline that rejected OUTSIDE its own try/catch/finally —
 * e.g. a throw before the try (mkdirSync), or a throw inside the catch/finally.
 * The fire-and-forget `.catch` at each pipeline entry point calls this so such a
 * run is marked + unlocked in-process, without waiting for the next restart's
 * reconcile. Guarded to running/pending so it never clobbers a done/cancelled row.
 */
export function failRun(runId: string, reason: string): void {
  try {
    failRunStmt.run(runId);
  } catch {
    // best-effort — the lock release below is what prevents a stuck lock
  }
  try {
    log(runId, "error", reason, { stage: "pipeline" });
  } catch {
    // logging is best-effort
  }
  endRun(runId);
}

const pauseRunStmt = db.prepare(
  `UPDATE runs SET status = 'cancelled', updated_at = datetime('now')
     WHERE id = ? AND status IN ('running', 'pending')`
);

/**
 * Pause a run for a reason only the OPERATOR can fix (an API key out of quota/credit) —
 * as opposed to `failRun`, which is for a genuine crash. Reuses the exact mechanism a
 * user-initiated Stop already uses: flag the run for cancellation (so the pipeline's own
 * `checkCancelled()` checkpoints refuse to start any further per-beat work — no more spend,
 * no more silently-unchecked frames) and mark it `cancelled` in the DB. Deliberately NOT
 * `failRun`/`'error'`: nothing is wrong with the run's own state, so Resume must treat it
 * exactly like a cancelled run — which it already does, reusing every beat already
 * rendered and only regenerating what's missing, once the operator has topped up the key
 * and clicks Resume.
 *
 * Does NOT call `endRun` — the pipeline is still executing (winding down beats already
 * in flight) and will release its own lock in its `finally` when it unwinds via
 * CancelledError, exactly as a user-initiated Stop does.
 */
export function pauseRunForOperator(runId: string, reason: string, stage = "pipeline"): void {
  try {
    log(runId, "error", reason, { stage });
  } catch {
    // logging is best-effort
  }
  markCancelled(runId);
  try {
    pauseRunStmt.run(runId);
  } catch {
    // best-effort — the in-memory cancel flag above is what actually stops new work
  }
}

/* ── Process-level crash handlers ──────────────────────────────────────────────
 *  A pipeline runs in-process. If a fault escapes even the entry-point `.catch`,
 *  the active run(s) would be frozen at "running". These handlers are the last
 *  line of defence. The two Node signals mean different things, so we treat them
 *  differently on purpose:
 *
 *   • uncaughtException — a synchronous fault with no handler. Node's default is
 *     to crash, and the process state is now unreliable, so we mark every active
 *     run failed, then exit(1). A supervisor (PM2/systemd) restarts cleanly and
 *     startup reconciliation recovers anything we couldn't mark. On a bare
 *     `npm run dev` the operator restarts manually — either way no run is stuck.
 *
 *   • unhandledRejection — a promise the pipeline's MAIN chain never awaited
 *     rejected. That chain (inside its own try/catch/finally) is unaffected and
 *     stays the authority for the run's status, so we deliberately do NOT mark
 *     runs here: doing so would be a false positive AND releasing the lock while
 *     the pipeline keeps running would re-open the duplicate-Resume double-spend
 *     that Phase 1 closed. We only log loudly (also avoids killing the server for
 *     a benign framework rejection). Runs that truly escape are caught either by
 *     the entry-point `.catch` (→ failRun) or, if the process dies, by reconcile.
 */
let crashHandlersInstalled = false;
let crashing = false;

/**
 * Errors we must NOT treat as fatal. Next.js deliberately installs its own
 * uncaughtException handler that logs-and-survives, because some faults have no
 * bearing on request handling — most notably a client disconnecting mid-stream,
 * which throws "Invalid state: Controller is already closed" (ERR_INVALID_STATE)
 * from the web-stream controller, asynchronously, long after the route returned.
 * Exiting on these would restart the whole server every time a browser closes a
 * video tab. These are framework/transport noise, never a pipeline fault, so we
 * log and keep serving. Genuine faults fall through to the crash path.
 */
export function isBenignFrameworkError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ERR_INVALID_STATE") return true; // controller/stream already closed
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Controller is already closed|Invalid state/i.test(msg);
}

function onUncaughtException(err: unknown): void {
  // Framework/transport disconnect noise (e.g. a client aborting a media stream)
  // is not a pipeline fault — log and keep serving, exactly as Next.js intends.
  // Checked BEFORE the `crashing` guard so it never latches the teardown flag.
  if (isBenignFrameworkError(err)) {
    // eslint-disable-next-line no-console
    console.error("[run-lifecycle] ignored benign framework uncaughtException (server kept alive):", err);
    return;
  }
  if (crashing) return; // a fault while we're already tearing down — don't loop
  crashing = true;
  const ids = [...activeRuns];
  for (const id of ids) {
    failRun(id, "Server process crashed (uncaughtException) — run aborted, can be resumed.");
  }
  // eslint-disable-next-line no-console
  console.error(`[run-lifecycle] uncaughtException — marked ${ids.length} active run(s) failed before exit:`, err);
  process.exit(1);
}

function onUnhandledRejection(reason: unknown): void {
  // eslint-disable-next-line no-console
  console.error("[run-lifecycle] unhandledRejection (server kept alive — pipeline try/catch remains authoritative):", reason);
}

/** Install the process-level crash handlers once. Called from initRunLifecycle. */
export function installCrashHandlers(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
}

/* ── Multi-process detection (warning only — clustering is unsupported) ─────────
 *  The whole no-heartbeat recovery model assumes ONE process owns the DB, so a
 *  second live process (PM2 cluster, a stray `next start`) can silently corrupt
 *  run state and double-spend credits. We can't support that, but we can detect
 *  and shout. Liveness is an OS pid probe at boot — not a heartbeat/timeout. All
 *  processes sharing this SQLite file are on the same host (it's a local file),
 *  so process.kill(pid, 0) is a reliable liveness check. Caveat: pid reuse could
 *  produce a false positive; acceptable for a warning-only diagnostic. */
const listInstancesStmt = db.prepare("SELECT instance_id, pid FROM app_instances");
const deleteInstanceStmt = db.prepare("DELETE FROM app_instances WHERE instance_id = ?");
const upsertInstanceStmt = db.prepare(
  "INSERT OR REPLACE INTO app_instances (instance_id, pid, started_at) VALUES (?, ?, datetime('now'))"
);

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but isn't ours to signal → still alive.
    // ESRCH / range errors = no such process → dead.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

let instanceCleanupInstalled = false;

/**
 * Register this process in app_instances, prune rows for dead pids, and return
 * how many OTHER live processes already share this database. Atomic (one SQLite
 * transaction) so simultaneous PM2 cluster forks still see each other. Also
 * installs a one-time `exit` cleanup that removes our row on a clean shutdown.
 */
export function registerInstanceAndCountPeers(): number {
  let livePeers = 0;
  const tx = db.transaction(() => {
    const rows = listInstancesStmt.all() as { instance_id: string; pid: number }[];
    for (const r of rows) {
      if (r.instance_id === INSTANCE_ID) continue;
      if (isPidAlive(r.pid)) livePeers++;
      else deleteInstanceStmt.run(r.instance_id); // reap a dead process's row
    }
    upsertInstanceStmt.run(INSTANCE_ID, process.pid);
  });
  try {
    tx();
  } catch {
    return 0; // detection must never block startup
  }
  if (!instanceCleanupInstalled) {
    instanceCleanupInstalled = true;
    process.on("exit", () => {
      try {
        deleteInstanceStmt.run(INSTANCE_ID);
      } catch {
        // best-effort — a stale row is reaped by the next boot's pid probe
      }
    });
  }
  return livePeers;
}

/**
 * One-call startup entry for run lifecycle. Installs crash handlers, registers
 * this process, and — only if no other live process shares the DB — reconciles
 * orphaned runs. If a peer IS detected we warn loudly and SKIP reconciliation,
 * because we can't tell which running rows the peer still owns (interrupting
 * them would corrupt its live runs). Called once from ensureInit().
 */
export function initRunLifecycle(): void {
  installCrashHandlers();
  const peers = registerInstanceAndCountPeers();
  if (peers > 0) {
    // eslint-disable-next-line no-console
    console.error(
      "\n[run-lifecycle] ============ UNSUPPORTED MULTI-PROCESS DEPLOYMENT ============\n" +
        `  ${peers} other live app process(es) are already using this database.\n` +
        `  This app is single-process by design — PM2 cluster mode ('pm2 -i N', N>1)\n` +
        "  or a second 'next start' against the same data dir is NOT supported and can\n" +
        "  corrupt run state and duplicate paid generations. Run exactly ONE process\n" +
        "  (PM2 fork mode / a single 'next start').\n" +
        "  Skipping orphaned-run recovery to avoid interrupting the other process.\n" +
        "  ==============================================================================\n"
    );
    return;
  }
  reconcileOrphanedRuns();
}

/**
 * Recover runs orphaned by a previous process: flip any running/pending run not
 * owned by the current process to "interrupted". Idempotent; call once at
 * startup (before any run in this process begins). Never throws — recovery must
 * not block startup. Returns the number of runs recovered.
 */
export function reconcileOrphanedRuns(): number {
  let ids: string[] = [];
  try {
    ids = (listOrphansStmt.all(INSTANCE_ID) as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return 0;
    reconcileStmt.run(INSTANCE_ID);
  } catch {
    return 0;
  }
  // Leave a breadcrumb in each run's own log so the UI explains the gap.
  for (const id of ids) {
    try {
      log(id, "warn", "Pipeline was interrupted by a server/process restart — this run can be resumed.", {
        stage: "pipeline",
      });
    } catch {
      // logging is best-effort
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[run-lifecycle] recovered ${ids.length} interrupted run(s) after restart`);
  return ids.length;
}

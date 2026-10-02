import crypto from "node:crypto";
import db from "./db";

/**
 * Scene job store — durable state for REMOTE per-scene work (a still animated on a GPU
 * worker, an avatar clip rendered remotely). No production code calls this yet.
 *
 * Why a table and not "the clip exists on disk" (what Resume checks today): a remote job
 * has states a file cannot express. The one that matters is the window between "we sent
 * it" and "the clip is here" — a restart inside that window must find the remote job id
 * and poll it, not submit the same paid job again.
 *
 * One row = one LOGICAL job: (run, beat, stage, provider, exact inputs), named by a
 * deterministic idempotency key with a UNIQUE constraint. Asking for the same job again
 * returns the same row, whatever state it is in.
 *
 * Owned by this process (better-sqlite3, single writer). Remote workers never write here;
 * the local orchestrator records what they report.
 *
 * ── State machine ────────────────────────────────────────────────────────────────────
 *
 *   prepared ──► submitting ──► submitted ──► running ──► succeeded
 *      ▲  │          │              │  │         │
 *      └──┼──────────┘              │  └─────────┼──────► succeeded (finished unobserved)
 *         │  (request provably      │            │
 *         │   never arrived)        ▼            ▼
 *         └────────────────────► failed / cancelled   (terminal)
 *
 *  - prepared    recorded locally; nothing has been sent.
 *  - submitting  we are about to send / are sending. PERSISTED on purpose: after a crash,
 *                a row still here means "the provider may or may not have accepted it" —
 *                the one state where blindly resubmitting can double-bill. Without it,
 *                that row would read as `prepared`, i.e. "safe to send".
 *  - submitted   the provider accepted it; remote_job_id is set (enforced by a CHECK).
 *  - running     the provider reports it running.
 *  - succeeded   output downloaded to output_path (CHECK-enforced). Terminal: never
 *                resubmitted, never reopened.
 *  - failed / cancelled  terminal. Reviving one is deliberately NOT supported yet: a retry
 *                policy must first decide what to do about a remote job that may still be
 *                running and billing. Until then, get-or-create returns them as they are.
 *
 * submitting → prepared is the ONLY way back, and only with proof the request never
 * reached the provider (e.g. connection refused — see provesRequestNeverArrived in
 * services/http.ts). It is how `attempts` can exceed 1 without any retry policy existing.
 *
 * `output_path` being set does not make a job succeeded and says nothing about the file:
 * the physical check (exists + ffprobe) stays with the caller.
 */

export type SceneJobStage = "still_animation" | "avatar_render";

export type SceneJobStatus =
  | "prepared"
  | "submitting"
  | "submitted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

const STAGES: readonly SceneJobStage[] = ["still_animation", "avatar_render"];

/** Every legal transition. Anything absent — including any move out of a terminal state — throws. */
export const SCENE_JOB_TRANSITIONS: Readonly<Record<SceneJobStatus, readonly SceneJobStatus[]>> = {
  prepared: ["submitting", "failed", "cancelled"],
  submitting: ["submitted", "prepared", "failed"],
  submitted: ["running", "succeeded", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isTerminalSceneJobStatus(s: SceneJobStatus): boolean {
  return SCENE_JOB_TRANSITIONS[s].length === 0;
}

export interface SceneJob {
  id: number;
  idempotency_key: string;
  run_id: string;
  beat_index: number;
  stage: SceneJobStage;
  /** Who does the work, e.g. "runpod:ltx". Open on purpose — providers are added freely,
   *  as with run_costs.provider; only its shape is validated. */
  provider: string;
  input_fingerprint: string;
  status: SceneJobStatus;
  /** Number of times this job entered `submitting`. */
  attempts: number;
  remote_job_id: string | null;
  output_path: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  completed_at: string | null;
}

export interface SceneJobIdentity {
  runId: string;
  beatIndex: number;
  stage: SceneJobStage;
  provider: string;
  /**
   * Fingerprint of every input that changes the output (source image, audio slice,
   * prompt, model, resolution…), built by the provider — see `fingerprintSceneJobInputs`.
   * Different inputs = a different logical job, so regenerating a scene with a new image
   * gets a new row instead of being answered with the old job's result.
   */
  inputFingerprint: string;
}

export class InvalidSceneJobTransitionError extends Error {
  constructor(
    readonly jobId: number,
    readonly from: SceneJobStatus | null,
    readonly to: SceneJobStatus
  ) {
    super(
      from === null
        ? `Scene job ${jobId} does not exist (cannot move it to "${to}")`
        : `Scene job ${jobId}: illegal transition "${from}" → "${to}"`
    );
    this.name = "InvalidSceneJobTransitionError";
  }
}

const PROVIDER_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const FINGERPRINT_RE = /^[A-Za-z0-9:._-]{1,128}$/;

function validateIdentity(id: SceneJobIdentity): void {
  if (!id.runId || typeof id.runId !== "string") throw new Error("scene job: runId is required");
  if (!Number.isInteger(id.beatIndex) || id.beatIndex < 0) throw new Error(`scene job: invalid beatIndex ${id.beatIndex}`);
  if (!STAGES.includes(id.stage)) throw new Error(`scene job: unknown stage "${id.stage}"`);
  if (!PROVIDER_RE.test(id.provider)) throw new Error(`scene job: invalid provider "${id.provider}"`);
  if (!FINGERPRINT_RE.test(id.inputFingerprint)) throw new Error(`scene job: invalid inputFingerprint "${id.inputFingerprint}"`);
}

/**
 * Canonical fingerprint of a job's inputs: sha256 over the entries sorted by key, so the
 * same inputs always produce the same value regardless of object key order. Callers pass
 * what defines the output — typically content hashes of files, never paths or mtimes.
 */
export function fingerprintSceneJobInputs(inputs: Record<string, string | number | boolean | null>): string {
  const keys = Object.keys(inputs).sort();
  if (keys.length === 0) throw new Error("scene job: an input fingerprint needs at least one input");
  const canonical = JSON.stringify(keys.map((k) => [k, inputs[k]]));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * The deterministic idempotency key of a logical job: "sj1:" + sha256 of the identity
 * tuple. Hashed (not concatenated) so no field can contain a delimiter that makes two
 * identities collide; versioned so the format can change without matching old keys.
 */
export function buildSceneJobIdempotencyKey(id: SceneJobIdentity): string {
  validateIdentity(id);
  const tuple = JSON.stringify(["sj1", id.runId, id.beatIndex, id.stage, id.provider, id.inputFingerprint]);
  return `sj1:${crypto.createHash("sha256").update(tuple).digest("hex")}`;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const insertStmt = db.prepare(
  `INSERT INTO scene_jobs (idempotency_key, run_id, beat_index, stage, provider, input_fingerprint)
   VALUES (@key, @runId, @beatIndex, @stage, @provider, @inputFingerprint)
   ON CONFLICT(idempotency_key) DO NOTHING`
);
const byIdStmt = db.prepare("SELECT * FROM scene_jobs WHERE id = ?");
const byKeyStmt = db.prepare("SELECT * FROM scene_jobs WHERE idempotency_key = ?");
const byRunStmt = db.prepare("SELECT * FROM scene_jobs WHERE run_id = ? ORDER BY beat_index, stage, id");
const activeStmt = db.prepare(
  "SELECT * FROM scene_jobs WHERE status IN ('submitting','submitted','running') ORDER BY id"
);

export function getSceneJob(id: number): SceneJob | null {
  return (byIdStmt.get(id) as SceneJob | undefined) ?? null;
}

export function findSceneJobByKey(idempotencyKey: string): SceneJob | null {
  return (byKeyStmt.get(idempotencyKey) as SceneJob | undefined) ?? null;
}

export function listSceneJobsForRun(runId: string): SceneJob[] {
  return byRunStmt.all(runId) as SceneJob[];
}

/** Jobs that may have remote work in flight — what a restart has to reconcile. */
export function listActiveSceneJobs(): SceneJob[] {
  return activeStmt.all() as SceneJob[];
}

/**
 * Return THE job for this identity, creating it as `prepared` if it does not exist yet.
 * An existing job is returned untouched in whatever state it is — a succeeded job is
 * never reset, a failed one never silently revived. The UNIQUE key is the last line of
 * defence: INSERT … ON CONFLICT DO NOTHING + re-read can only ever yield one row.
 */
export const getOrCreateSceneJob = db.transaction((id: SceneJobIdentity): { job: SceneJob; created: boolean } => {
  const key = buildSceneJobIdempotencyKey(id);
  const res = insertStmt.run({ key, ...id });
  const job = findSceneJobByKey(key)!;
  // The key is a hash of these fields, so a mismatch means a corrupted row or a hash
  // collision — either way, handing back someone else's job would be the worst outcome.
  if (
    job.run_id !== id.runId || job.beat_index !== id.beatIndex || job.stage !== id.stage ||
    job.provider !== id.provider || job.input_fingerprint !== id.inputFingerprint
  ) {
    throw new Error(`scene job ${job.id}: stored identity does not match idempotency key ${key}`);
  }
  return { job, created: res.changes === 1 };
});

/**
 * Compare-and-set: ONE UPDATE that both checks the current status and writes every field
 * of the new state, so no reader can ever observe half a transition (e.g. `submitted`
 * without its remote id). Zero rows changed = the job was not in a legal source state.
 */
function transition(jobId: number, to: SceneJobStatus, setSql: string, params: Record<string, unknown> = {}): SceneJob {
  const from = (Object.keys(SCENE_JOB_TRANSITIONS) as SceneJobStatus[]).filter((s) =>
    SCENE_JOB_TRANSITIONS[s].includes(to)
  );
  const placeholders = from.map((_, i) => `@from${i}`).join(", ");
  const fromParams = Object.fromEntries(from.map((s, i) => [`from${i}`, s]));
  const res = db
    .prepare(
      `UPDATE scene_jobs SET status = @to, ${setSql}${setSql ? ", " : ""}updated_at = ${NOW}
       WHERE id = @jobId AND status IN (${placeholders})`
    )
    .run({ ...params, ...fromParams, to, jobId });
  const job = getSceneJob(jobId);
  if (res.changes !== 1 || !job) throw new InvalidSceneJobTransitionError(jobId, job?.status ?? null, to);
  return job;
}

function required(value: string, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`scene job: ${what} is required`);
  return value;
}

/** prepared → submitting. Counts the attempt in the same write. Call BEFORE sending. */
export function markSceneJobSubmitting(jobId: number): SceneJob {
  return transition(jobId, "submitting", "attempts = attempts + 1, error_code = NULL, error_message = NULL");
}

/** submitting → submitted, recording the provider's job id in the same write. */
export function markSceneJobSubmitted(jobId: number, remoteJobId: string): SceneJob {
  return transition(jobId, "submitted", `remote_job_id = @remoteJobId, submitted_at = ${NOW}`, {
    remoteJobId: required(remoteJobId, "remoteJobId"),
  });
}

/**
 * submitting → prepared. ONLY when the request provably never reached the provider; if
 * there is any doubt, the job stays `submitting` (or is marked failed) — never re-armed.
 */
export function markSceneJobSubmitNeverArrived(jobId: number, errorCode: string, errorMessage?: string): SceneJob {
  return transition(jobId, "prepared", "error_code = @errorCode, error_message = @errorMessage", {
    errorCode: required(errorCode, "errorCode"),
    errorMessage: errorMessage ?? null,
  });
}

/** submitted → running. */
export function markSceneJobRunning(jobId: number): SceneJob {
  return transition(jobId, "running", "");
}

/** submitted | running → succeeded, recording where the output was written, atomically. */
export function markSceneJobSucceeded(jobId: number, outputPath: string): SceneJob {
  return transition(jobId, "succeeded", `output_path = @outputPath, completed_at = ${NOW}`, {
    outputPath: required(outputPath, "outputPath"),
  });
}

/**
 * Any non-terminal state → failed (terminal). From `submitting` this is also how an
 * unresolvable submit window is closed (e.g. error_code "submit_outcome_unknown").
 */
export function markSceneJobFailed(jobId: number, errorCode: string, errorMessage?: string): SceneJob {
  return transition(jobId, "failed", `error_code = @errorCode, error_message = @errorMessage, completed_at = ${NOW}`, {
    errorCode: required(errorCode, "errorCode"),
    errorMessage: errorMessage ?? null,
  });
}

/**
 * prepared | submitted | running → cancelled (terminal). Not from `submitting`: until the
 * submit resolves we do not know whether there is a remote job to cancel.
 */
export function markSceneJobCancelled(jobId: number, reason?: string): SceneJob {
  return transition(jobId, "cancelled", `error_message = @reason, completed_at = ${NOW}`, { reason: reason ?? null });
}

/**
 * Reading ai33.pro (OpenSpeaker) responses — deliberately TOLERANT, and here is why.
 *
 * Every other provider in this codebase was pinned against live requests before a parser
 * was written, because the vendors' documentation was wrong in both directions (see the
 * AI84 section of CLAUDE.md). ai33 could not be probed: `ai33.pro/app/api-document` is
 * behind Cloudflare + a login, the public OpenAPI spec declares the payload schemas as
 * `additionalProperties: true` (i.e. it documents nothing), and an API key is only issued
 * after a donation. So the exact spelling of four fields is genuinely unknown:
 *
 *   1. the task id in the create reply       — `task_id`? `id`? nested under `data`?
 *   2. the status string on completion       — `done`? `success`? `completed`?
 *   3. the audio URL field                   — `audio_url`? `audioUrl`? `url`?
 *   4. the credits-spent field               — `credit_cost`? `credits`? `cost`?
 *
 * THE ALTERNATIVE TO TOLERANCE IS NOT PRECISION, IT IS A GUESS. Picking one spelling per
 * field would give a parser that is exactly as unverified as this one and fails on the
 * tester's first run with "returned no task id" — telling them nothing. So each field is
 * read through its plausible spellings, and when nothing matches the RAW PAYLOAD is
 * carried into the error (see `describeUnparsed`). The first real run therefore either
 * works or hands back the exact contract, which is what a probe would have bought.
 *
 * This tolerance is scoped to READING. Nothing here decides routing, nothing retries, and
 * nothing invents a value: an absent field reads as `null`, never as a default.
 *
 * Pure — no network, no DB, no settings. Everything below is unit-tested.
 */

/**
 * The engines ai33 fronts, from their public docs (2026-08-18). `clone` is the operator's
 * OWN voices, which is why it leads the list — that is the voice a creator comes looking
 * for, exactly as with AI84's cloned voices.
 *
 * Unlike AI84 there is deliberately no engine SETTING: an ai33 `voice_id` is
 * `"<engine>:<id>"`, so the engine travels inside the voice. A separate setting would be a
 * second source of truth for one fact, and its out-of-sync state is precisely the failure
 * that cost a real client two runs on AI84.
 */
export const AI33_ENGINES = ["clone", "elevenlabs", "minimax", "fishaudio", "edge", "vbee"] as const;
export type Ai33Engine = (typeof AI33_ENGINES)[number];

/**
 * Where a payload may hide the fields we need. Checked in order; the outermost wins.
 *
 * `metadata` earned its spot the hard way: a live `/v1/task/:id` reply put `audio_url`
 * (plus `voice_id`, `query`, and even a nested `data`) INSIDE `metadata` instead of at the
 * root — `{status:"done", metadata:{audio_url:"https://…", ...}}`. Nothing else in this
 * container list covers that, so a finished job with a real URL was read as "no audio URL"
 * and the run was killed after the ai33 credits for it had already been spent.
 */
const CONTAINERS = ["data", "task", "result", "job", "output", "response", "metadata"] as const;

/** The payload itself plus each nested container that is an object, in priority order. */
function scopes(payload: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return out;
  const root = payload as Record<string, unknown>;
  out.push(root);
  for (const c of CONTAINERS) {
    const v = root[c];
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>);
  }
  return out;
}

/** First non-empty string among `keys`, searched across every scope. */
function str(payload: unknown, keys: string[]): string | null {
  for (const scope of scopes(payload)) {
    for (const k of keys) {
      const v = scope[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      // Some task APIs answer with a bare number id.
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
  }
  return null;
}

/** First finite number among `keys`, searched across every scope. */
function nums(payload: unknown, keys: string[]): number | null {
  for (const scope of scopes(payload)) {
    for (const k of keys) {
      const v = scope[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      // A credit count served as a string is still a credit count.
      if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
    }
  }
  return null;
}

/**
 * The id used to poll the job.
 *
 * `task_id` first because the public docs name it; the rest are the shapes the same
 * family of task APIs uses (69labs, GenAIPro and AI84 between them use three of these).
 */
export function pickTaskId(payload: unknown): string | null {
  return str(payload, ["task_id", "taskId", "job_id", "jobId", "id", "uuid"]);
}

/** Terminal-failure statuses. Checked FIRST, so a failed job is never read as pending. */
const FAILED = new Set(["failed", "failure", "fail", "error", "errored", "cancelled", "canceled", "rejected", "timeout"]);
/** Terminal-success statuses. */
const DONE = new Set(["done", "success", "succeeded", "successful", "completed", "complete", "finished", "ok"]);

export interface Ai33TaskState {
  /** What the caller acts on. `pending` covers every non-terminal or unrecognised status. */
  phase: "done" | "failed" | "pending";
  /** The finished audio, when the payload carries one. */
  audioUrl: string | null;
  /** Credits this job has consumed so far, when reported. `null` = not reported, NOT zero. */
  credits: number | null;
  /** The provider's own words on failure, preserved verbatim. */
  error: string | null;
  /** The raw status string, for the log — an unrecognised one is worth seeing. */
  rawStatus: string;
}

/** An `http(s)` URL and nothing else — a relative path or a stray word is not audio. */
function asUrl(v: string | null): string | null {
  return v && /^https?:\/\//i.test(v) ? v : null;
}

/**
 * Read one poll response.
 *
 * A PRESENT AUDIO URL OUTRANKS AN UNRECOGNISED STATUS. That rule is what makes an unknown
 * status vocabulary survivable: if ai33 says `"succeed"` or `"FINISH"` and hands us the
 * file, the job is done whatever the word was. Without it a working render would poll to
 * the deadline and the operator would be billed for audio we threw away.
 *
 * A recognised FAILURE still outranks a URL, because a failed job's leftover URL is not
 * something to ship into a video.
 */
export function readTaskState(payload: unknown): Ai33TaskState {
  const rawStatus = str(payload, ["status", "state", "task_status", "taskStatus", "phase"]) ?? "";
  const status = rawStatus.toLowerCase();
  const audioUrl = asUrl(
    str(payload, [
      "audio_url", "audioUrl", "audio", "output_url", "outputUrl",
      "download_url", "downloadUrl", "file_url", "fileUrl", "result_url", "url",
    ])
  );
  const credits = nums(payload, [
    "credit_cost", "creditCost", "credits", "credits_used", "creditsUsed",
    "credit", "cost", "used_credits", "consumed_credits",
  ]);
  const error = str(payload, [
    "error_message", "errorMessage", "error_msg", "errorMessageKey", "error", "message", "msg", "detail", "reason",
  ]);

  const phase: Ai33TaskState["phase"] =
    FAILED.has(status) ? "failed" : audioUrl ? "done" : DONE.has(status) ? "done" : "pending";

  return { phase, audioUrl, credits, error, rawStatus };
}

/** How much of an unrecognised payload to quote. Enough to name the fields, short enough to log. */
const MAX_PAYLOAD = 600;

/**
 * The error text for a payload we could not read — WITH THE PAYLOAD IN IT.
 *
 * This is the load-bearing half of the tolerance above. Because the contract could not be
 * probed, the first operator to run ai33 IS the probe: either it works, or this line hands
 * back the real field names so the parser above becomes one line longer and verified. An
 * error that merely says "no task id" would waste that run.
 */
export function describeUnparsed(what: string, payload: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(payload);
  } catch {
    raw = String(payload);
  }
  return (
    `ai33 ${what}. This is the response it actually sent — please send this line to support ` +
    `so the field names can be pinned: ${(raw ?? "null").slice(0, MAX_PAYLOAD)}`
  );
}

/** One voice as the picker consumes it. */
export interface Ai33Voice {
  /** Always fully qualified as `<engine>:<id>` — what the synthesis call sends verbatim. */
  voice_id: string;
  name: string;
  engine: Ai33Engine;
  /** True for the operator's own cloned voices, so the UI can lead with them. */
  cloned?: boolean;
}

/**
 * Make a voice id fully qualified.
 *
 * ai33 addresses a voice as `"<engine>:<id>"` — the engine is IN the id, which is what
 * removes AI84's whole engine-resolution layer here. Whether `/v3/voices` already returns
 * ids prefixed is one of the unprobed facts, so an id that already carries a known engine
 * prefix is left exactly as it is and only a bare one is qualified. Both shapes therefore
 * come out identical, and the answer to that question changes nothing.
 */
export function qualifyVoiceId(id: string, engine: Ai33Engine): string {
  const v = id.trim();
  const head = v.split(":")[0].toLowerCase();
  return (AI33_ENGINES as readonly string[]).includes(head) ? v : `${engine}:${v}`;
}

/** The engine named by a fully-qualified voice id, or null for a bare/foreign one. */
export function engineOfVoiceId(id: string | null | undefined): Ai33Engine | null {
  const head = (id ?? "").trim().split(":")[0].toLowerCase();
  return (AI33_ENGINES as readonly string[]).includes(head) ? (head as Ai33Engine) : null;
}

/** The array of voices in a listing response, whatever key it arrived under. */
function voiceArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  for (const scope of scopes(payload)) {
    for (const k of ["voices", "data", "items", "results", "list"]) {
      const v = scope[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

/**
 * Parse one engine's voice listing.
 *
 * Entries with no usable id are DROPPED rather than given a placeholder: a picker row that
 * writes an unusable value into AI33_VOICE_ID is worse than a missing row, because it fails
 * at synthesis time when the run has already started.
 */
export function parseVoiceList(payload: unknown, engine: Ai33Engine): Ai33Voice[] {
  const out: Ai33Voice[] = [];
  const seen = new Set<string>();
  for (const v of voiceArray(payload)) {
    const id = str(v, ["voice_id", "voiceId", "id", "canonical_voice_id", "value"]);
    if (!id) continue;
    const voice_id = qualifyVoiceId(id, engine);
    if (seen.has(voice_id)) continue;
    seen.add(voice_id);
    const name = str(v, ["name", "display_name", "displayName", "title", "label"]) ?? id;
    const tags = [str(v, ["gender"]), str(v, ["language", "locale", "lang"]), str(v, ["accent"])]
      .filter(Boolean)
      .join(", ");
    out.push({
      voice_id,
      // The engine is in the LABEL because it is also in the id and in the bill: ai33's
      // engines are priced differently, and an operator picking blind cannot see either.
      name: `${tags ? `${name} (${tags})` : name} · ${engine === "clone" ? "your clone" : engine}`,
      engine,
      ...(engine === "clone" ? { cloned: true } : {}),
    });
  }
  return out;
}

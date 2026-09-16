import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Data dir holds the SQLite database (settings, run records, logs).
 * Lives outside the project source tree so Turbopack file-watcher doesn't try
 * to scan SQLite shm/wal files (which can be locked on Windows).
 *
 * Override via FACELESS_STUDIO_DATA_DIR environment variable.
 * Isolated from other local apps so they can coexist without DB collisions.
 */
const DATA_DIR =
  process.env.FACELESS_STUDIO_DATA_DIR ??
  path.join(os.homedir(), ".faceless-studio");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "studio.db"));
// Without WAL: on Windows the .shm file can lock external readers.
db.pragma("journal_mode = DELETE");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompts (
    name TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Channel profiles (table name "prompt_presets" is legacy). Each row is a
  -- full per-channel bundle the user picks on the New Run page in one click:
  --   name             — channel name
  --   description      — optional human note about the channel
  --   content          — scene_split system prompt (legacy column name)
  --   animation_motion — optional motion-style override
  --   image_prompt     — optional image-style override (unused in video-only)
  --   heygen_voice_id  — optional per-channel HeyGen voice; overrides the
  --                      global HEYGEN_VOICE_ID setting for runs on this channel
  -- Optional fields fall back to global defaults / settings when NULL.
  CREATE TABLE IF NOT EXISTS prompt_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    description TEXT,
    animation_motion TEXT,
    image_prompt TEXT,
    heygen_voice_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    title TEXT,
    folder_name TEXT,
    status TEXT NOT NULL,
    script TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    output_path TEXT,
    -- 'avatar_all' | 'avatar_partial' | NULL — see the tryAddColumn below.
    degraded TEXT,
    -- Provenance snapshot of the detected VideoStructure ({v,kind,direction,total,source}) or NULL.
    -- Observability only; rendering/resume rely on beats.json — see the tryAddColumn below.
    structure_json TEXT
  );

  -- Live app-process registry (DIAGNOSTIC ONLY — clustering is NOT supported).
  -- Each process inserts one row at startup and deletes it on clean exit. On
  -- boot we prune rows whose pid is no longer alive and warn if any OTHER live
  -- process is already using this database (PM2 cluster / a second next-start),
  -- which would corrupt run state and duplicate paid generations. No heartbeat:
  -- liveness is decided by an OS pid probe (process.kill pid 0) at boot only.
  CREATE TABLE IF NOT EXISTS app_instances (
    instance_id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    -- ISO 8601 with Z so the client renders local time correctly
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    level TEXT NOT NULL,
    stage TEXT,
    message TEXT NOT NULL,
    data_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_run_logs_run ON run_logs(run_id, id);

  -- Per-run cost ledger (Cost Monitoring). Append-only: ONE row per metered API
  -- event. We never read-modify-write a running total, so concurrent beats can
  -- INSERT freely with no race. The Costs page aggregates by run_id at read time.
  --   provider   — granular source: 'elevenlabs'|'gemini'|'kie:nano-banana'|'kie:veo'|'heygen'|'69labs'…
  --   category   — UI bucket: 'elevenlabs'|'geminiText'|'geminiVision'|'aiProviders'
  --   units      — chars / tokens / images / video-seconds / clips (the BILLABLE quantity)
  --   amount_eur — the euro AS RECORDED, at the rate + FX in force at write time.
  --                PROVENANCE ONLY — /costs no longer reads it (see rate_kind).
  --   estimated  — 1 = derived from our rate constants, not provider-billed truth
  CREATE TABLE IF NOT EXISTS run_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    provider TEXT NOT NULL,
    category TEXT NOT NULL,
    units REAL NOT NULL DEFAULT 0,
    unit_label TEXT,
    amount_eur REAL NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_run_costs_run ON run_costs(run_id);

  -- Avatar library — the recurring, "memorized" presenters created from a
  -- reference photo. One row per named avatar.
  --   engine        — 'talking_photo' (default, no training) | 'photo_avatar_group' (trained)
  --   heygen_id     — talking_photo_id, OR the trained look's avatar_id. Set when ready.
  --   group_id      — photo_avatar_group id (only for engine = photo_avatar_group)
  --   image_key     — HeyGen asset image_key from the reference-image upload
  --   ref_image_path— local copy of the uploaded reference image (for the UI thumbnail)
  --   preview_url   — talking_photo_url / look preview from HeyGen
  --   status        — pending | training | ready | error
  --   motion_prompt — optional custom_motion_prompt (Avatar IV expressiveness)
  --   use_avatar_iv — '1' to apply HeyGen's higher-realism Avatar IV engine
  --   imported      — '1' when the row only REFERENCES an avatar the operator made
  --                   on HeyGen (import-by-id). We did not create that asset, so we
  --                   must never delete it from their HeyGen account. NULL = ours.
  --   api_engine    — 'avatar_v' when the operator CHOSE HeyGen's Avatar V engine
  --                   (rendered via the v3 API). NULL = rendered via v2, where
  --                   use_avatar_iv picks Avatar IV vs Legacy. This is intent, NOT a
  --                   cached capability: whether an avatar supports Avatar V comes from
  --                   HeyGen's live supported_api_engines and is never stored, because
  --                   it is derived from server state we can't see and can change.
  CREATE TABLE IF NOT EXISTS avatars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    engine TEXT NOT NULL DEFAULT 'talking_photo',
    heygen_id TEXT,
    group_id TEXT,
    image_key TEXT,
    ref_image_path TEXT,
    preview_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    motion_prompt TEXT,
    use_avatar_iv TEXT,
    imported TEXT,
    api_engine TEXT,
    channel_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Channels ("Chaîne") — a simple per-channel defaults bundle:
  --   visual_mode (ai|real|mix), ai_style (AI prompt suffix), interval_sec
  --   (seconds per visual), format (resolution WxH), optional default avatar.
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    visual_mode TEXT NOT NULL DEFAULT 'mix',
    ai_style TEXT,
    visual_prompt TEXT,
    interval_sec REAL NOT NULL DEFAULT 4.5,
    format TEXT NOT NULL DEFAULT '1920x1080',
    avatar_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrations for older DBs. SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS`, so we attempt and ignore failure when the column already exists.
function tryAddColumn(table: string, columnDecl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDecl}`);
  } catch {
    // column already exists
  }
}

tryAddColumn("runs", "folder_name TEXT");
// Final video length in seconds (Cost Monitoring). Persisted at pipeline
// completion from the voiceover duration; null on old runs → cost/min shows "—".
tryAddColumn("runs", "duration_sec REAL");
// Drive references — set by run-upload.ts after a successful sync.
tryAddColumn("runs", "drive_clips_folder_id TEXT");
tryAddColumn("runs", "drive_final_video_id TEXT");
tryAddColumn("runs", "drive_synced_at TEXT");
// Reuse map — JSON `{ "<scene_index>": "<drive_file_id>" }`. When present,
// the pipeline skips video generation for those scenes and downloads from Drive.
tryAddColumn("runs", "reuse_map_json TEXT");
// Prompt preset used for scene splitting + animation motion + image style.
// Stored as a snapshot of the content (not FKs) so deleting the preset later
// doesn't break old runs / diagnostics. preset_content == scene_split.
tryAddColumn("runs", "preset_id INTEGER");
tryAddColumn("runs", "preset_name TEXT");
tryAddColumn("runs", "preset_content TEXT");
tryAddColumn("runs", "preset_animation_motion TEXT");
tryAddColumn("runs", "preset_image_prompt TEXT");
tryAddColumn("runs", "preset_voice_id TEXT");
// Snapshot of the channel's voiceover-speed override at run-create (NULL = global TTS_SPEED).
tryAddColumn("runs", "voice_speed REAL");
// TTS model snapshotted at run-create when the operator picked a voice for THIS video
// (NULL = the provider reads its own global setting, i.e. every run made before this).
//
// It exists because AI84's ENGINE is chosen by the model, and cloned voices live only on
// MiniMax: without a per-run model, two runs share one engine and a cloned voice cannot be
// produced alongside a stock one. Named voice_model, not ai84_model — the column means
// "the TTS model this run was created with"; which provider understands it is dispatchTts'
// business.
tryAddColumn("runs", "voice_model TEXT");
// Backfill for older prompt_presets rows (created before these columns existed)
tryAddColumn("prompt_presets", "animation_motion TEXT");
tryAddColumn("prompt_presets", "image_prompt TEXT");
tryAddColumn("prompt_presets", "description TEXT");
tryAddColumn("prompt_presets", "heygen_voice_id TEXT");
// Channel profile → default avatar (FK into avatars.id). NULL = no avatar (pure faceless).
tryAddColumn("prompt_presets", "avatar_id INTEGER");

// Avatar library forward-compat (no-ops on a fresh DB that already has them).
tryAddColumn("avatars", "motion_prompt TEXT");
tryAddColumn("avatars", "use_avatar_iv TEXT");
tryAddColumn("avatars", "preview_url TEXT");
tryAddColumn("avatars", "ref_image_path TEXT");
tryAddColumn("avatars", "channel_id INTEGER");
// Provenance: '1' = we only REFERENCE an avatar the operator created on HeyGen.
tryAddColumn("avatars", "imported TEXT");
// 'avatar_v' = the operator chose Avatar V (v3). NULL = the v2 path. Intent, not a
// cached capability. No backfill: NULL is already correct for every existing row.
tryAddColumn("avatars", "api_engine TEXT");
// Backfill for rows imported before the column existed — otherwise they stay
// indistinguishable from ours and deleting one would destroy the operator's own
// HeyGen asset (the bug this column fixes).
//
// The tell: EVERY locally-created avatar has a ref_image_path (uploaded, or
// generated from the description during ingest) by the time it earns a
// heygen_id; the import path never sets one. Idempotent — only fills NULLs.
// Deliberately biased toward "imported": a false positive merely leaves an
// orphaned HeyGen slot (recoverable at app.heygen.com), while a false negative
// deletes an asset we don't own (not recoverable).
try {
  db.exec(
    `UPDATE avatars SET imported = '1'
      WHERE imported IS NULL AND ref_image_path IS NULL AND heygen_id IS NOT NULL`
  );
} catch {
  // older DB shape / column missing — nothing to backfill
}
tryAddColumn("channels", "visual_prompt TEXT");
// Per-channel ElevenLabs narration voice (NULL = global ELEVENLABS_VOICE_ID).
tryAddColumn("channels", "voice_id TEXT");
// Per-channel voiceover speed override (NULL = global TTS_SPEED). Same global-vs-channel model as voice_id.
tryAddColumn("channels", "voice_speed REAL");

// Avatar snapshot onto a run — so the pipeline reads a stable avatar even if the
// library row is edited/deleted later. avatar_db_id is the library id; the
// heygen/engine columns are the resolved HeyGen handles at run-create time.
tryAddColumn("runs", "avatar_db_id INTEGER");
tryAddColumn("runs", "avatar_engine TEXT");
tryAddColumn("runs", "avatar_heygen_id TEXT");
tryAddColumn("runs", "avatar_image_key TEXT");
tryAddColumn("runs", "avatar_use_iv TEXT");
tryAddColumn("runs", "avatar_motion_prompt TEXT");
// Which HeyGen engine this run renders its avatar with: 'avatar_v' (v3) or NULL (v2,
// where avatar_use_iv picks Avatar IV vs Legacy).
//
// This CANNOT be derived from the columns above. Stage 1 stores an Avatar V avatar as
// engine='talking_photo' + use_avatar_iv=NULL — byte-identical to a Legacy avatar. So
// without this column a resumed run cannot tell the two apart, would fall onto the v2
// path, and would silently render Avatar V as Legacy while billing $1/min instead of $4.
//
// Nor can it be read live from avatars.api_engine via avatar_db_id: the whole point of
// these avatar_* columns is that a run replays what it was CREATED with. The avatar row
// can be edited or deleted between create and resume — and if it is gone, a live read
// finds nothing and degrades to v2. That is the same silent substitution, only later
// and harder to see. NULL is correct for every existing row: none of them is Avatar V.
tryAddColumn("runs", "avatar_api_engine TEXT");

// Set (datetime) when the operator deletes a job from the Jobs page. Soft
// delete: the run row + run_costs are KEPT so the Costs page stays byte-for-byte
// accurate, but the on-disk files + run_logs are removed. Every runs listing
// filters `deleted_at IS NULL`, and the detail route 404s, so a deleted job is
// hidden everywhere and unreachable — it survives only for cost accounting.
tryAddColumn("runs", "deleted_at TEXT");

// Phase 1 (resume/retry). Token of the PROCESS that last owned this run's
// pipeline (see run-lifecycle.ts INSTANCE_ID). Set when a run starts executing;
// on startup, any running/pending run NOT owned by the current process belonged
// to a dead process and is recovered to status 'interrupted'.
tryAddColumn("runs", "owner_instance TEXT");

// The run finished and produced a real video, but not the one that was asked for:
//   'avatar_all'     — every avatar beat failed; the video has NO avatar footage
//   'avatar_partial' — some avatar beats fell back to b-roll
//   NULL             — delivered as planned
// A CODE, not a message: the UI renders it bilingually, so no English leaks out of
// the pipeline into the operator's screen. It is NOT a status — the run really is
// 'done' (the video exists and is downloadable), and making it a status would mean
// teaching resume/retry a state that isn't a failure. NULL for every existing row is
// already correct: nothing that finished before this column existed is known to have
// degraded, and guessing from old logs would be inventing history.
tryAddColumn("runs", "degraded TEXT");

// Provenance only: a JSON snapshot of the detected VideoStructure ({v,kind,direction,total,source}),
// written once at plan time so we can observe the cue detector's real-world hit/false-positive rate.
// NULL for every pre-existing row is correct — rendering and resume derive nothing from this column
// (beats.json is the canonical plan); it exists purely for observability.
tryAddColumn("runs", "structure_json TEXT");

// ── Cost Monitoring: read-time pricing ────────────────────────────────────────
// `amount_eur` is frozen at write time, so a rate the operator fixes TODAY never
// restates yesterday's rows — which is how 382 recorded 69labs videos sit at €0.00
// and stay there. These two columns store the priceable FACTS instead, so
// /api/costs can compute the euro from current settings on every read.
//
//   rate_kind  — the stable key that decides which rate applies. `provider` alone
//                cannot: HeyGen's engine (avatar_v/avatar_iv/unlimited) is a 3–4x
//                price difference and was stored NOWHERE, and a 69labs image is
//                indistinguishable from its video. See RATE_KINDS in pricing.ts.
//                NULL only on rows the backfill could not classify → priced by the
//                legacy provider default, i.e. no worse than before.
//   amount_usd — the REAL billed USD when a provider reports one (only Runware's
//                `includeCost` does today). NULL = we hold an estimate, not money.
//                Kept in USD, not EUR, so a corrected FX rate restates it too.
//   units_out  — the SECOND billable quantity, for rates that have two. Only Gemini
//                does: `units` stays the total token count and `units_out` is the
//                output tokens, so prompt = units - units_out. Without it a Gemini
//                row cannot be repriced at all (the two rates differ ~6x), which is
//                why pre-existing Gemini rows fall back to their as-recorded euro.
tryAddColumn("run_costs", "rate_kind TEXT");
tryAddColumn("run_costs", "amount_usd REAL");
tryAddColumn("run_costs", "units_out REAL");
// Both period queries scan `ts` (WHERE ts >= ? AND ts < ?) on every 5s page poll.
db.exec("CREATE INDEX IF NOT EXISTS idx_run_costs_ts ON run_costs(ts)");

/**
 * Backfill `rate_kind` onto rows written before the column existed, so history
 * reprices instead of staying frozen at whatever rate was configured that day.
 *
 * Everything except HeyGen is a direct provider→kind mapping. HeyGen is the reason
 * the column had to exist at all: the ledger only ever stored `provider = 'heygen'`,
 * and its three engines span $1–$4/min. The engine IS recoverable — a run snapshots
 * it at create time onto `runs.avatar_api_engine` / `runs.avatar_use_iv` — so we join
 * back to the run rather than guess. The decode matches `billingEngine()` exactly,
 * including the strict `= '1'` (a NULL genuinely means Legacy, not "unset").
 *
 * Rows we cannot classify keep `rate_kind` NULL and fall back to their as-recorded
 * euro (`priceRow`), which is no worse than the previous behaviour. That covers cost
 * rows whose run was hard-deleted — there is no snapshot left to read.
 *
 * Gemini rows get a kind (so the UI can name the rate) but stay unrepriceable: their
 * prompt/output token split was never stored, and inventing one to reprice them would
 * be fabricating history. New rows carry `units_out` and reprice normally.
 *
 * Idempotent via a flag row, in the same shape as the settings.ts migrations.
 */
function backfillRunCostRateKinds(): void {
  try {
    const flag = db.prepare("SELECT value FROM settings WHERE key = ?").get("_migration_run_costs_rate_kind") as
      | { value: string }
      | undefined;
    if (flag?.value === "1") return;

    const set = (kind: string, where: string) =>
      db.prepare(`UPDATE run_costs SET rate_kind = ? WHERE rate_kind IS NULL AND ${where}`).run(kind);

    set("elevenlabs", "provider = 'elevenlabs'");
    set("ai84", "provider = 'ai84'");
    set("fishaudio", "provider = 'fishaudio'");
    set("hume", "provider = 'hume'");
    set("groq", "provider = 'groq'");
    set("kie:image", "provider = 'kie:nano-banana'");
    set("kie:veo", "provider = 'kie:veo'");
    set("magnific:image", "provider = 'magnific:mystic'");
    set("magnific:video", "provider = 'magnific:video'");
    set("higgsfield:image", "provider = 'higgsfield:soul'");
    set("higgsfield:video", "provider = 'higgsfield:dop'");
    set("runware:image", "provider LIKE 'runware:%'");
    // A '69labs' row is a video; the stills were written as '69labs:image'.
    set("69labs:image", "provider = '69labs:image'");
    set("69labs:video", "provider = '69labs'");
    // Gemini: the model is in the provider string, and '-lite' names the cheap tier.
    set("gemini:lite", "provider LIKE 'gemini:%' AND lower(provider) LIKE '%lite%'");
    set("gemini:std", "provider LIKE 'gemini:%'");

    // HeyGen — recover the engine from the run's own snapshot.
    db.prepare(
      `UPDATE run_costs SET rate_kind = (
         SELECT CASE
           WHEN r.avatar_api_engine = 'avatar_v' THEN 'heygen:avatar_v'
           WHEN r.avatar_use_iv = '1'            THEN 'heygen:avatar_iv'
           ELSE 'heygen:unlimited'
         END
         FROM runs r WHERE r.id = run_costs.run_id
       )
       WHERE rate_kind IS NULL
         AND provider = 'heygen'
         AND EXISTS (SELECT 1 FROM runs r WHERE r.id = run_costs.run_id)`
    ).run();

    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, '1', datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')"
    ).run("_migration_run_costs_rate_kind");
  } catch {
    // Cost tracking is fail-open everywhere else; a failed backfill must not stop the
    // app from booting. Unclassified rows simply keep showing their as-recorded euro.
  }
}
backfillRunCostRateKinds();

export default db;

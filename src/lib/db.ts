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
    output_path TEXT
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
  --   units      — chars / tokens / images / video-seconds / clips (for audit)
  --   amount_eur — computed from configurable rates in pricing.ts (EUR)
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
tryAddColumn("channels", "visual_prompt TEXT");
// Per-channel ElevenLabs narration voice (NULL = global ELEVENLABS_VOICE_ID).
tryAddColumn("channels", "voice_id TEXT");
// Per-channel real-footage vs AI-image ratio (NULL = global REAL_RATIO_PERCENT).
tryAddColumn("channels", "real_ratio_percent REAL");
// Per-channel ordered b-roll source priority — JSON array of comma-joined
// provider-key strings, e.g. ["openverse,wikimedia","pixabay,pexels"]. Each
// tier is tried in order; YouTube/AI fallback (unchanged) only kicks in after
// every tier is exhausted. NULL = global FOOTAGE_SOURCES (all providers in parallel).
tryAddColumn("channels", "footage_source_tiers TEXT");

// Avatar snapshot onto a run — so the pipeline reads a stable avatar even if the
// library row is edited/deleted later. avatar_db_id is the library id; the
// heygen/engine columns are the resolved HeyGen handles at run-create time.
tryAddColumn("runs", "avatar_db_id INTEGER");
tryAddColumn("runs", "avatar_engine TEXT");
tryAddColumn("runs", "avatar_heygen_id TEXT");
tryAddColumn("runs", "avatar_image_key TEXT");
tryAddColumn("runs", "avatar_use_iv TEXT");
tryAddColumn("runs", "avatar_motion_prompt TEXT");

// Set (datetime) when the operator deletes a job from the Jobs page. Soft
// delete: the run row + run_costs are KEPT so the Costs page stays byte-for-byte
// accurate, but the on-disk files + run_logs are removed. Every runs listing
// filters `deleted_at IS NULL`, and the detail route 404s, so a deleted job is
// hidden everywhere and unreachable — it survives only for cost accounting.
tryAddColumn("runs", "deleted_at TEXT");

export default db;

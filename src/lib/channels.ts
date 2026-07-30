import db from "./db";

/**
 * Channels ("Chaîne") — a simple per-channel defaults bundle the operator picks
 * when creating a video: visual mode, AI image style, seconds-per-visual, output
 * format, and an optional default avatar. Distinct from the inherited
 * `prompt_presets` (scene-split prompts) — this model is intentionally simple.
 */

export type VisualMode = "ai" | "real" | "mix";

export interface Channel {
  id: number;
  name: string;
  visual_mode: VisualMode;
  ai_style: string | null;
  /** Editable guidance for the per-beat visual-query ("split") prompt. NULL = default. */
  visual_prompt: string | null;
  /** Per-channel ElevenLabs narration voice_id. NULL = global ELEVENLABS_VOICE_ID. */
  voice_id: string | null;
  interval_sec: number;
  format: string;
  avatar_id: number | null;
  /** Per-channel real-footage vs AI-image ratio (0-100). NULL = global REAL_RATIO_PERCENT. */
  real_ratio_percent: number | null;
  /** Ordered b-roll source priority — JSON array of comma-joined provider-key
   * strings (e.g. ["openverse,wikimedia","pixabay,pexels"]). NULL = global
   * FOOTAGE_SOURCES (all configured providers queried in parallel). */
  footage_source_tiers: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = "id, name, visual_mode, ai_style, visual_prompt, voice_id, interval_sec, format, avatar_id, real_ratio_percent, footage_source_tiers, created_at, updated_at";
const listStmt = db.prepare(`SELECT ${COLS} FROM channels ORDER BY name COLLATE NOCASE ASC`);
const getStmt = db.prepare(`SELECT ${COLS} FROM channels WHERE id = ?`);
const getByNameStmt = db.prepare(`SELECT ${COLS} FROM channels WHERE name = ?`);
const insertStmt = db.prepare(
  `INSERT INTO channels (name, visual_mode, ai_style, visual_prompt, voice_id, interval_sec, format, avatar_id, real_ratio_percent, footage_source_tiers)
   VALUES (@name, @visual_mode, @ai_style, @visual_prompt, @voice_id, @interval_sec, @format, @avatar_id, @real_ratio_percent, @footage_source_tiers)`
);
const deleteStmt = db.prepare("DELETE FROM channels WHERE id = ?");

export function listChannels(): Channel[] {
  return listStmt.all() as Channel[];
}
export function getChannel(id: number): Channel | null {
  return (getStmt.get(id) as Channel | undefined) ?? null;
}
export function getChannelByName(name: string): Channel | null {
  return (getByNameStmt.get(name) as Channel | undefined) ?? null;
}

export interface ChannelInput {
  name: string;
  visual_mode?: VisualMode;
  ai_style?: string | null;
  visual_prompt?: string | null;
  voice_id?: string | null;
  interval_sec?: number;
  format?: string;
  avatar_id?: number | null;
  real_ratio_percent?: number | null;
  footage_source_tiers?: string | null;
}

function normRealRatio(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}

function normMode(m: string | undefined): VisualMode {
  return m === "ai" || m === "real" ? m : "mix";
}

export function createChannel(input: ChannelInput): number {
  const name = input.name.trim();
  if (!name) throw new Error("Channel name cannot be empty");
  if (getChannelByName(name)) throw new Error(`A channel named "${name}" already exists`);
  const res = insertStmt.run({
    name,
    visual_mode: normMode(input.visual_mode),
    ai_style: input.ai_style?.trim() || null,
    visual_prompt: input.visual_prompt?.trim() || null,
    voice_id: input.voice_id?.trim() || null,
    interval_sec: Number.isFinite(input.interval_sec) ? Number(input.interval_sec) : 4.5,
    format: (input.format || "1920x1080").trim(),
    avatar_id: input.avatar_id ?? null,
    real_ratio_percent: normRealRatio(input.real_ratio_percent),
    footage_source_tiers: input.footage_source_tiers?.trim() || null,
  });
  return Number(res.lastInsertRowid);
}

export function updateChannel(id: number, input: ChannelInput): void {
  const name = input.name.trim();
  if (!name) throw new Error("Channel name cannot be empty");
  db.prepare(
    `UPDATE channels SET name=@name, visual_mode=@visual_mode, ai_style=@ai_style, visual_prompt=@visual_prompt,
       voice_id=@voice_id, interval_sec=@interval_sec, format=@format, avatar_id=@avatar_id,
       real_ratio_percent=@real_ratio_percent, footage_source_tiers=@footage_source_tiers, updated_at=datetime('now')
     WHERE id=@id`
  ).run({
    id,
    name,
    visual_mode: normMode(input.visual_mode),
    ai_style: input.ai_style?.trim() || null,
    visual_prompt: input.visual_prompt?.trim() || null,
    voice_id: input.voice_id?.trim() || null,
    interval_sec: Number.isFinite(input.interval_sec) ? Number(input.interval_sec) : 4.5,
    format: (input.format || "1920x1080").trim(),
    avatar_id: input.avatar_id ?? null,
    real_ratio_percent: normRealRatio(input.real_ratio_percent),
    footage_source_tiers: input.footage_source_tiers?.trim() || null,
  });
}

export function deleteChannel(id: number): void {
  deleteStmt.run(id);
}

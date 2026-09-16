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
  /** Per-channel voiceover speed override. NULL = global TTS_SPEED. */
  voice_speed: number | null;
  interval_sec: number;
  format: string;
  avatar_id: number | null;
  created_at: string;
  updated_at: string;
}

const COLS = "id, name, visual_mode, ai_style, visual_prompt, voice_id, voice_speed, interval_sec, format, avatar_id, created_at, updated_at";
const listStmt = db.prepare(`SELECT ${COLS} FROM channels ORDER BY name COLLATE NOCASE ASC`);
const getStmt = db.prepare(`SELECT ${COLS} FROM channels WHERE id = ?`);
const getByNameStmt = db.prepare(`SELECT ${COLS} FROM channels WHERE name = ?`);
const insertStmt = db.prepare(
  `INSERT INTO channels (name, visual_mode, ai_style, visual_prompt, voice_id, voice_speed, interval_sec, format, avatar_id)
   VALUES (@name, @visual_mode, @ai_style, @visual_prompt, @voice_id, @voice_speed, @interval_sec, @format, @avatar_id)`
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
  voice_speed?: number | null;
  interval_sec?: number;
  format?: string;
  avatar_id?: number | null;
}

function normMode(m: string | undefined): VisualMode {
  return m === "ai" || m === "real" ? m : "mix";
}

/** Per-channel speed: a finite number is stored as-is (providers clamp to their own range); anything else → NULL (use global TTS_SPEED). */
function normSpeed(s: number | null | undefined): number | null {
  return typeof s === "number" && Number.isFinite(s) ? s : null;
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
    voice_speed: normSpeed(input.voice_speed),
    interval_sec: Number.isFinite(input.interval_sec) ? Number(input.interval_sec) : 4.5,
    format: (input.format || "1920x1080").trim(),
    avatar_id: input.avatar_id ?? null,
  });
  return Number(res.lastInsertRowid);
}

export function updateChannel(id: number, input: ChannelInput): void {
  const name = input.name.trim();
  if (!name) throw new Error("Channel name cannot be empty");
  db.prepare(
    `UPDATE channels SET name=@name, visual_mode=@visual_mode, ai_style=@ai_style, visual_prompt=@visual_prompt,
       voice_id=@voice_id, voice_speed=@voice_speed, interval_sec=@interval_sec, format=@format, avatar_id=@avatar_id, updated_at=datetime('now')
     WHERE id=@id`
  ).run({
    id,
    name,
    visual_mode: normMode(input.visual_mode),
    ai_style: input.ai_style?.trim() || null,
    visual_prompt: input.visual_prompt?.trim() || null,
    voice_id: input.voice_id?.trim() || null,
    voice_speed: normSpeed(input.voice_speed),
    interval_sec: Number.isFinite(input.interval_sec) ? Number(input.interval_sec) : 4.5,
    format: (input.format || "1920x1080").trim(),
    avatar_id: input.avatar_id ?? null,
  });
}

export function deleteChannel(id: number): void {
  deleteStmt.run(id);
}

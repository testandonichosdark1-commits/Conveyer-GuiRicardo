import db from "./db";

/**
 * Avatar library — the recurring, "memorized" presenters.
 *
 * Each row is one named avatar the operator created from a reference photo.
 * The HeyGen handle (`heygen_id` = talking_photo_id or trained look avatar_id)
 * is filled asynchronously once HeyGen finishes ingesting/training the photo;
 * until then `status` is "pending"/"training". The pipeline only uses avatars
 * whose status is "ready".
 *
 * See heygen-avatar.ts for how rows are created/advanced, and docs/DESIGN.md
 * for the HeyGen API shapes.
 */

export type AvatarEngine = "talking_photo" | "photo_avatar_group";
export type AvatarStatus = "pending" | "training" | "ready" | "error";

export interface Avatar {
  id: number;
  name: string;
  description: string | null;
  engine: AvatarEngine;
  /** talking_photo_id, or the trained look's avatar_id. NULL until ready. */
  heygen_id: string | null;
  /** photo_avatar_group id (engine = photo_avatar_group only). */
  group_id: string | null;
  /** HeyGen asset image_key from the reference-image upload. */
  image_key: string | null;
  /** Local copy of the uploaded reference image (served to the UI). */
  ref_image_path: string | null;
  /** talking_photo_url / look preview from HeyGen. */
  preview_url: string | null;
  status: AvatarStatus;
  error: string | null;
  /** Optional custom_motion_prompt (Avatar IV expressiveness). */
  motion_prompt: string | null;
  /** "1" to apply HeyGen's higher-realism Avatar IV engine. */
  use_avatar_iv: string | null;
  /** Optional channel this avatar belongs to (NULL = available to all). */
  channel_id: number | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, name, description, engine, heygen_id, group_id, image_key, ref_image_path, preview_url, status, error, motion_prompt, use_avatar_iv, channel_id, created_at, updated_at";

const listStmt = db.prepare(`SELECT ${COLS} FROM avatars ORDER BY created_at DESC`);
const getStmt = db.prepare(`SELECT ${COLS} FROM avatars WHERE id = ?`);
const getByNameStmt = db.prepare(`SELECT ${COLS} FROM avatars WHERE name = ?`);
const insertStmt = db.prepare(
  `INSERT INTO avatars (name, description, engine, image_key, ref_image_path, status, motion_prompt, use_avatar_iv, channel_id)
   VALUES (@name, @description, @engine, @image_key, @ref_image_path, @status, @motion_prompt, @use_avatar_iv, @channel_id)`
);
const deleteStmt = db.prepare("DELETE FROM avatars WHERE id = ?");

export function listAvatars(): Avatar[] {
  return listStmt.all() as Avatar[];
}

export function getAvatar(id: number): Avatar | null {
  return (getStmt.get(id) as Avatar | undefined) ?? null;
}

export function getAvatarByName(name: string): Avatar | null {
  return (getByNameStmt.get(name) as Avatar | undefined) ?? null;
}

export interface CreateAvatarInput {
  name: string;
  description?: string | null;
  engine?: AvatarEngine;
  image_key?: string | null;
  ref_image_path?: string | null;
  status?: AvatarStatus;
  motion_prompt?: string | null;
  use_avatar_iv?: boolean;
  channel_id?: number | null;
}

export function createAvatar(input: CreateAvatarInput): number {
  const name = input.name.trim();
  if (!name) throw new Error("Avatar name cannot be empty");
  if (getAvatarByName(name)) throw new Error(`An avatar named "${name}" already exists`);
  const res = insertStmt.run({
    name,
    description: input.description?.trim() || null,
    engine: input.engine ?? "talking_photo",
    image_key: input.image_key ?? null,
    ref_image_path: input.ref_image_path ?? null,
    status: input.status ?? "pending",
    motion_prompt: input.motion_prompt?.trim() || null,
    use_avatar_iv: input.use_avatar_iv ? "1" : null,
    channel_id: input.channel_id ?? null,
  });
  return Number(res.lastInsertRowid);
}

/** Patch any subset of mutable columns. Used by the HeyGen pipeline to advance state. */
export function updateAvatar(
  id: number,
  patch: Partial<
    Pick<
      Avatar,
      | "heygen_id"
      | "group_id"
      | "image_key"
      | "ref_image_path"
      | "preview_url"
      | "status"
      | "error"
      | "motion_prompt"
      | "use_avatar_iv"
      | "description"
    >
  >
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const setSql = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(
    `UPDATE avatars SET ${setSql}, updated_at = datetime('now') WHERE id = @id`
  ).run({ ...patch, id });
}

export function deleteAvatar(id: number): void {
  deleteStmt.run(id);
}

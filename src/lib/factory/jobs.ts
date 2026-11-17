/**
 * Video Factory ("Fábrica") — the job table.
 *
 * One row per title. A job walks four steps in order: script → thumbnail →
 * video (voice + assets + assembly are the existing studio pipeline). Every step
 * writes its result into the job's own folder before the row moves on, so a
 * retry resumes at the first step whose output is missing and never repeats
 * paid work that already succeeded.
 */
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import db from "../db";
import { DATA_DIR } from "../data-dir";

db.exec(`
  CREATE TABLE IF NOT EXISTS factory_jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    channel_kind TEXT NOT NULL,          -- 'a' military | 'b' trucking | 'c' aviation (script brief)
    options_json TEXT NOT NULL,          -- studio options: channelId, visualMode, realPercent, avatarPercent
    status TEXT NOT NULL,                -- queued | running | done | error | cancelled
    step TEXT NOT NULL,                  -- script | thumbnail | video | finished
    detail TEXT,                         -- last progress line or error message
    run_id TEXT,                         -- studio run created by the video step
    folder TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export type ChannelKind = "a" | "b" | "c";
export type FactoryStep = "script" | "thumbnail" | "video" | "finished";
export type FactoryStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface FactoryOptions {
  channelId: number | null;
  visualMode: "ai" | "real" | "mix";
  realPercent: number;
  avatarPercent: number;
  /** "voicestudio" = local free narration (default); "channel" = the channel/global provider. */
  voice: "voicestudio" | "channel";
  /** Zero cost: real footage only, and a beat with no good match keeps the best real clip
   *  instead of falling to AI (whose fallback chain can end at a paid provider). */
  free: boolean;
}

export interface FactoryJob {
  id: string;
  title: string;
  channel_kind: ChannelKind;
  options_json: string;
  status: FactoryStatus;
  step: FactoryStep;
  detail: string | null;
  run_id: string | null;
  folder: string;
  created_at: string;
  updated_at: string;
}

export const FACTORY_DIR = path.join(DATA_DIR, "factory");

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || "video"
  );
}

const insertStmt = db.prepare(
  `INSERT INTO factory_jobs (id, title, channel_kind, options_json, status, step, folder)
   VALUES (?, ?, ?, ?, 'queued', 'script', ?)`
);

export function createJob(title: string, kind: ChannelKind, options: FactoryOptions): FactoryJob {
  const id = randomUUID();
  const folder = path.join(FACTORY_DIR, `${slugify(title)}-${id.slice(0, 6)}`);
  fs.mkdirSync(folder, { recursive: true });
  insertStmt.run(id, title.trim(), kind, JSON.stringify(options), folder);
  return getJob(id)!;
}

export function getJob(id: string): FactoryJob | null {
  return (db.prepare("SELECT * FROM factory_jobs WHERE id = ?").get(id) as FactoryJob | undefined) ?? null;
}

export function listJobs(limit = 200): FactoryJob[] {
  return db.prepare("SELECT * FROM factory_jobs ORDER BY created_at DESC LIMIT ?").all(limit) as FactoryJob[];
}

export function jobsWithStatus(...statuses: FactoryStatus[]): FactoryJob[] {
  const marks = statuses.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM factory_jobs WHERE status IN (${marks}) ORDER BY created_at ASC`)
    .all(...statuses) as FactoryJob[];
}

export function updateJob(
  id: string,
  patch: Partial<Pick<FactoryJob, "status" | "step" | "detail" | "run_id">>
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE factory_jobs SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
    ...keys.map((k) => patch[k] ?? null),
    id
  );
}

export function deleteJob(id: string): void {
  db.prepare("DELETE FROM factory_jobs WHERE id = ?").run(id);
}

export function jobOptions(job: FactoryJob): FactoryOptions {
  const o = JSON.parse(job.options_json) as Partial<FactoryOptions>;
  return {
    channelId: typeof o.channelId === "number" ? o.channelId : null,
    visualMode: o.visualMode === "ai" || o.visualMode === "real" ? o.visualMode : "mix",
    realPercent: Number.isFinite(o.realPercent) ? Number(o.realPercent) : 50,
    avatarPercent: Number.isFinite(o.avatarPercent) ? Number(o.avatarPercent) : 0,
    voice: o.voice === "channel" ? "channel" : "voicestudio",
    free: o.free !== false,
  };
}

/** The files a job produces, found by suffix (the script skill names them after the slug). */
export function jobFiles(job: FactoryJob) {
  const names = fs.existsSync(job.folder) ? fs.readdirSync(job.folder) : [];
  const find = (pred: (n: string) => boolean) => {
    const n = names.find(pred);
    return n ? path.join(job.folder, n) : null;
  };
  return {
    script: find(
      (n) =>
        n.endsWith(".txt") &&
        !n.endsWith("_descricao.txt") &&
        !n.startsWith("claude-") &&
        n !== "plano-do-lote.md"
    ),
    description: find((n) => n.endsWith("_descricao.txt")),
    research: find((n) => n.endsWith("_pesquisa.md")),
    thumbnailPackage: find((n) => n.endsWith("_thumbnail.md")),
    thumbnailSpec: find((n) => n === "thumbnail.json"),
    thumbnailBase: find((n) => n === "thumbnail-base.png"),
    thumbnail: find((n) => n === "thumbnail.jpg"),
  };
}

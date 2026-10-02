import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * `runs.avatar_renderer` — the snapshot that keeps Resume deterministic.
 *
 * A run records the renderer it was created with; the pipeline (fresh AND Resume) reads
 * the avatar only through `readAvatar`, which decodes that snapshot. NULL — every run
 * made before the column existed — means HeyGen.
 *
 * Runs against a throwaway DB (FACELESS_STUDIO_DATA_DIR) — no real data, no keys, no
 * HeyGen calls.
 */
vi.mock("./logger", () => ({ log: () => {} }));

let db!: typeof import("./db").default;
let avatars!: typeof import("./avatars");
let pipeline!: typeof import("./studio-pipeline");

beforeAll(async () => {
  process.env.FACELESS_STUDIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-renderer-"));
  const { ensureInit } = await import("./init");
  ensureInit();
  db = (await import("./db")).default;
  avatars = await import("./avatars");
  pipeline = await import("./studio-pipeline");
});

let n = 0;
function newRun(): string {
  const id = `run-${++n}`;
  db.prepare("INSERT INTO runs (id, status, script, config_json) VALUES (?, 'pending', '', '{\"mode\":\"studio\"}')").run(id);
  return id;
}
function readyAvatar(over: Partial<import("./avatars").CreateAvatarInput> = {}) {
  const id = avatars.createAvatar({ name: `Avatar ${++n}`, status: "ready", ...over });
  avatars.updateAvatar(id, { heygen_id: `tp_${id}` });
  return avatars.getAvatar(id)!;
}
const snapshotCols = (runId: string) =>
  db.prepare(
    "SELECT avatar_db_id, avatar_engine, avatar_heygen_id, avatar_image_key, avatar_use_iv, avatar_motion_prompt, avatar_api_engine, avatar_renderer FROM runs WHERE id = ?"
  ).get(runId) as Record<string, unknown>;

describe("runs.avatar_renderer", () => {
  it("is added by the normal additive migration", () => {
    const cols = (db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("avatar_renderer");
  });

  it("C. a new run with an avatar records renderer = heygen, and every other snapshot column as before", () => {
    const av = readyAvatar({ use_avatar_iv: true, motion_prompt: "nods" });
    const run = newRun();
    avatars.snapshotRunAvatar(run, av);
    expect(snapshotCols(run)).toEqual({
      avatar_db_id: av.id,
      avatar_engine: "talking_photo",
      avatar_heygen_id: av.heygen_id,
      avatar_image_key: null,
      avatar_use_iv: "1",
      avatar_motion_prompt: "nods",
      avatar_api_engine: null,
      avatar_renderer: "heygen",
    });
  });

  it("B. an old run whose avatar_renderer is NULL resolves to HeyGen, untouched on disk", () => {
    const av = readyAvatar();
    const run = newRun();
    avatars.snapshotRunAvatar(run, av);
    db.prepare("UPDATE runs SET avatar_renderer = NULL WHERE id = ?").run(run); // pre-column row
    expect(pipeline.readAvatar(run)?.renderer).toBe("heygen");
    expect(snapshotCols(run).avatar_renderer).toBeNull(); // reading never backfills
  });

  it("H. Resume replays the snapshot, not the avatar library", () => {
    const av = readyAvatar({ api_engine: "avatar_v" });
    const run = newRun();
    avatars.snapshotRunAvatar(run, av);
    const atCreate = pipeline.readAvatar(run);
    // The library row is edited and then deleted between create and resume.
    db.prepare("UPDATE avatars SET api_engine = NULL, use_avatar_iv = '1' WHERE id = ?").run(av.id);
    avatars.deleteAvatar(av.id);
    const atResume = pipeline.readAvatar(run);
    expect(atResume).toEqual(atCreate);
    expect(atResume).toMatchObject({ renderer: "heygen", apiEngine: "avatar_v", heygenId: av.heygen_id, useAvatarIv: false });
  });

  it("an unknown stored renderer fails the run instead of silently rendering on HeyGen", () => {
    const av = readyAvatar();
    const run = newRun();
    avatars.snapshotRunAvatar(run, av);
    db.prepare("UPDATE runs SET avatar_renderer = 'infinitetalk' WHERE id = ?").run(run);
    expect(() => pipeline.readAvatar(run)).toThrow(/refusing to guess/);
  });

  it("I. a run with no avatar still has no avatar", () => {
    expect(pipeline.readAvatar(newRun())).toBeNull();
  });
});

describe("the pipeline renders avatars only through the seam", () => {
  it("studio-pipeline imports generateAvatarClip from avatar-renderer, never heygen-video directly", () => {
    const src = fs.readFileSync(path.join(__dirname, "studio-pipeline.ts"), "utf-8");
    expect(src).toMatch(/import \{ generateAvatarClip[^}]*\} from "\.\/services\/avatar-renderer"/);
    expect(src).not.toMatch(/import[^;]*generateAvatarClip[^;]*from "\.\/services\/heygen-video"/);
    // Both the fresh path and Resume call it, and both read the avatar via readAvatar.
    expect(src.match(/generateAvatarClip\(runId, avatar,/g)).toHaveLength(2);
    expect(src.match(/const avatar = readAvatar\(runId\)/g)).toHaveLength(2);
  });
});

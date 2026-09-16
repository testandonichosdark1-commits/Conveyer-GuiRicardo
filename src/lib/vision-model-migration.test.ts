import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * VISION_MATCH_MODEL was seeded as "" by v0.3.0 and given a real default a month later.
 * `seedDefaults` never revisits a key it already wrote, and the key has no form field,
 * so installs from that window are stuck on "" with no way to notice or correct it.
 *
 * "" is not inert: every read site is `VISION_MATCH_MODEL || SCENE_SPLIT_MODEL`, so the
 * per-candidate vision scoring — hundreds of back-to-back calls on a long run — silently
 * lands on the PLANNER's model, which is chosen for a handful of calls seconds apart.
 */
let dir: string;

async function freshSettings() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-mig-"));
  process.env.FACELESS_STUDIO_DATA_DIR = dir;
  vi.resetModules();
  return import("./settings");
}

/** Make the DB look like one from before this migration: old value in place, flag absent. */
async function pretendOlderInstall(values: Record<string, string>) {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(dir, "studio.db"));
  const set = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  for (const [k, v] of Object.entries(values)) set.run(k, v);
  db.prepare("DELETE FROM settings WHERE key = '_migration_vision_model_default_v1'").run();
  db.close();
}

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.FACELESS_STUDIO_DATA_DIR;
});

describe("VISION_MATCH_MODEL on a fresh install", () => {
  it("names its own cheap model rather than inheriting the planner's", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    expect(s.getSetting("VISION_MATCH_MODEL")).toBe("gemini-3.1-flash-lite");
  });
});

describe("VISION_MATCH_MODEL on an install frozen on the old empty default", () => {
  it("fills in the model, so vision scoring stops running on the planner's model", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    await pretendOlderInstall({ VISION_MATCH_MODEL: "" }); // what those installs actually hold
    s.seedDefaults();
    expect(s.getSetting("VISION_MATCH_MODEL")).toBe("gemini-3.1-flash-lite");
  });

  it("never overwrites a model the operator chose", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    await pretendOlderInstall({ VISION_MATCH_MODEL: "gemini-3.5-flash" });
    s.seedDefaults();
    expect(s.getSetting("VISION_MATCH_MODEL")).toBe("gemini-3.5-flash");
  });

  it("leaves the planner's own model alone", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    await pretendOlderInstall({ VISION_MATCH_MODEL: "", SCENE_SPLIT_MODEL: "gemini-3.5-flash" });
    s.seedDefaults();
    expect(s.getSetting("SCENE_SPLIT_MODEL")).toBe("gemini-3.5-flash");
  });

  it("runs once, so blanking it deliberately afterwards sticks", async () => {
    // "" is a documented, supported value (inherit the planner's model). Re-filling it on
    // every boot would take that choice away from anyone who set it through the API.
    const s = await freshSettings();
    s.seedDefaults();
    await pretendOlderInstall({ VISION_MATCH_MODEL: "" });
    s.seedDefaults(); // fills it, and marks itself done
    s.setSetting("VISION_MATCH_MODEL", "");
    s.seedDefaults();
    expect(s.getSetting("VISION_MATCH_MODEL")).toBe("");
  });
});

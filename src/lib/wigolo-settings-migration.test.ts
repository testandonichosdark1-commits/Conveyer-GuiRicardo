import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * These cover the two ways an EXISTING install is left behind by `seedDefaults`, which only
 * ever fills MISSING keys and never revisits a key it already wrote.
 *
 * The first one shipped: WIGOLO_URL defaulted to empty back when the daemon had to be
 * installed by hand. Once npm install brought the binary and predev started it, every
 * install had a running daemon, a tickable checkbox, and no address to send queries to —
 * the source returned nothing and looked broken rather than off.
 */
let dir: string;

async function freshSettings() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wigolo-mig-"));
  process.env.FACELESS_STUDIO_DATA_DIR = dir;
  vi.resetModules();
  return import("./settings");
}

/**
 * Make the database look like one from before these migrations existed: the old values in
 * place and no completion flag. Seeding a fresh DB runs them immediately and marks them
 * done, so without this a test would only ever exercise the already-migrated path.
 */
async function pretendOlderInstall(values: Record<string, string>) {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(dir, "studio.db"));
  const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(values)) set.run(k, v);
  db.prepare(
    "DELETE FROM settings WHERE key IN ('_migration_wigolo_url_backfill','_migration_wigolo_exclude_reupload','_migration_wigolo_default_on')"
  ).run();
  db.close();
}

beforeEach(() => {
  delete process.env.WIGOLO_URL;
  delete process.env.WIGOLO_EXCLUDE_DOMAINS;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.FACELESS_STUDIO_DATA_DIR;
});

describe("wigolo settings on a fresh install", () => {
  it("points at the daemon the app starts for itself", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    expect(s.getSetting("WIGOLO_URL")).toBe("http://127.0.0.1:3477");
  });

  it("excludes the re-upload sites, where the landing page is never the rights holder", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    const list = s.getSetting("WIGOLO_EXCLUDE_DOMAINS");
    for (const d of ["pinterest.com", "pinimg.com", "tumblr.com"]) expect(list).toContain(d);
  });
});

describe("wigolo settings on an install that predates them", () => {
  it("fills an address that was left empty by the old default", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    await pretendOlderInstall({ WIGOLO_URL: "" }); // what an older install actually holds
    s.seedDefaults();
    expect(s.getSetting("WIGOLO_URL")).toBe("http://127.0.0.1:3477");
  });

  it("never overwrites an address the operator chose", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    await pretendOlderInstall({ WIGOLO_URL: "http://192.168.1.50:9999" });
    s.seedDefaults();
    expect(s.getSetting("WIGOLO_URL")).toBe("http://192.168.1.50:9999");
  });

  it("widens the exclude list only when it is untouched", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    const OLD =
      "alamy.com,gettyimages.com,shutterstock.com,istockphoto.com,dreamstime.com,depositphotos.com,123rf.com,agefotostock.com,freepik.com";
    await pretendOlderInstall({ WIGOLO_EXCLUDE_DOMAINS: OLD });
    s.seedDefaults();
    expect(s.getSetting("WIGOLO_EXCLUDE_DOMAINS")).toContain("pinterest.com");
  });

  it("leaves a customised exclude list exactly as written", async () => {
    // Appending to somebody's deliberate choice is the worse failure of the two.
    const s = await freshSettings();
    s.seedDefaults();
    await pretendOlderInstall({ WIGOLO_EXCLUDE_DOMAINS: "example.com" });
    s.seedDefaults();
    expect(s.getSetting("WIGOLO_EXCLUDE_DOMAINS")).toBe("example.com");
  });

  it("turns the source on, keeping every source the operator already had", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    await pretendOlderInstall({ FOOTAGE_SOURCES: "pexels,pixabay,storyblocks" });
    s.seedDefaults();
    const list = s.getSetting("FOOTAGE_SOURCES").split(",");
    expect(list).toContain("wigolo");
    for (const kept of ["pexels", "pixabay", "storyblocks"]) expect(list).toContain(kept);
  });

  it("adds the source exactly once, so unticking it afterwards sticks", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    await pretendOlderInstall({ FOOTAGE_SOURCES: "pexels" });
    s.seedDefaults(); // enables it, and marks itself done
    s.setSetting("FOOTAGE_SOURCES", "pexels"); // operator unticks it, afterwards
    s.seedDefaults();
    expect(s.getSetting("FOOTAGE_SOURCES")).toBe("pexels");
  });

  it("runs each migration once, so a later manual change sticks", async () => {
    const s = await freshSettings();
    s.seedDefaults();
    await pretendOlderInstall({ WIGOLO_URL: "" });
    s.seedDefaults(); // backfills, and marks itself done
    s.setSetting("WIGOLO_URL", ""); // operator blanks it deliberately, afterwards
    s.seedDefaults();
    expect(s.getSetting("WIGOLO_URL")).toBe("");
  });
});

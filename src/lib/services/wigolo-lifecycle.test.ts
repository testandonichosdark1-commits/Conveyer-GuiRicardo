import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * The daemon launcher (`scripts/wigolo.mjs`), exercised as a real subprocess.
 *
 * Two promises are worth automating, because both fail in ways nobody would notice until it
 * is expensive: `ensure` must never delay or break app startup on a machine without wigolo,
 * and `stop` must never kill a process that isn't ours.
 */

const SCRIPT = path.join(process.cwd(), "scripts/wigolo.mjs");

let dataDir: string;

function seedSettings(values: Record<string, string>): void {
  const db = new Database(path.join(dataDir, "studio.db"));
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  const up = db.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const [k, v] of Object.entries(values)) up.run(k, v);
  db.close();
}

/**
 * Deliberately async: the "already running" case is served by an HTTP stub living in THIS
 * process, and spawnSync would block the event loop so the stub could never answer — the
 * script would see a dead port and the test would assert the opposite of what it means to.
 */
function run(cmd: "ensure" | "stop"): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, cmd], {
      env: { ...process.env, FACELESS_STUDIO_DATA_DIR: dataDir },
      cwd: process.cwd(),
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (status) => resolve({ status, out }));
  });
}

const pidFile = () => path.join(dataDir, "wigolo.pid");

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wigolo-life-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("ensure", () => {
  it("exits cleanly and starts nothing when wigolo isn't installed", async () => {
    // A bogus explicit path pins the "no binary anywhere" branch regardless of what happens
    // to be installed on the machine running the tests.
    seedSettings({ WIGOLO_URL: "http://127.0.0.1:59999", WIGOLO_BIN: path.join(dataDir, "does-not-exist") });

    const { status, out } = await run("ensure");

    expect(status).toBe(0); // anything else would abort `npm run dev`
    expect(out).toMatch(/not installed/i);
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it("is a no-op when the daemon is already answering, however many times it runs", async () => {
    const server: Server = createServer((req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    seedSettings({ WIGOLO_URL: `http://127.0.0.1:${port}` });

    try {
      for (const _ of [1, 2]) {
        const { status, out } = await run("ensure");
        expect(status).toBe(0);
        expect(out).toMatch(/already running/i);
        // No pid file means nothing was spawned — which is what keeps a second `npm run dev`
        // from leaving a second daemon behind.
        expect(fs.existsSync(pidFile())).toBe(false);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("stop", () => {
  it("says so and exits cleanly when nothing was ever started", async () => {
    const { status, out } = await run("stop");
    expect(status).toBe(0);
    expect(out).toMatch(/nothing to stop/i);
  });

  it("discards a pid file whose process is long gone", async () => {
    // 2^22 is above the default pid_max on Linux and macOS, so it cannot be live.
    fs.writeFileSync(pidFile(), "4194304");
    const { status, out } = await run("stop");
    expect(status).toBe(0);
    expect(out).toMatch(/not a wigolo process|stale/i);
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it("refuses to kill a recycled pid belonging to something else", async () => {
    // The OS reuses pids, so a pid file left over from a previous session can point at an
    // unrelated process — one the operator may very much care about. Existence is therefore
    // not enough to justify a kill.
    const victim: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    expect(victim.pid).toBeTruthy();
    fs.writeFileSync(pidFile(), String(victim.pid));

    try {
      const { status, out } = await run("stop");

      expect(status).toBe(0);
      expect(out).toMatch(/not a wigolo process/i);
      expect(fs.existsSync(pidFile())).toBe(false); // stale entry cleaned up…
      expect(victim.killed).toBe(false); // …but the process left alone
      expect(() => process.kill(victim.pid as number, 0)).not.toThrow();
    } finally {
      victim.kill("SIGKILL");
    }
  });
});

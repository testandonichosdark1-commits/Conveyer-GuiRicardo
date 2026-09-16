// Lifecycle for the optional wigolo daemon (the "Wigolo (web photos)" footage source).
//
//   node scripts/wigolo.mjs ensure   # start it if it isn't already answering
//   node scripts/wigolo.mjs stop     # shut down the one we started
//
// `ensure` runs from the `predev` npm hook, so it covers every way the app is started:
// `npm run dev` in a terminal and the double-clickable start.command / start.bat both end
// up in `npm run dev`, and neither launcher needed changing.
//
// TWO RULES GOVERN THIS FILE.
//
// 1. It must never block or fail the app. Wigolo is optional; the app has to start on a
//    machine where it was never installed. Every path here ends in exit code 0.
//
// 2. It must never install anything. `npx wigolo` is deliberately NOT used: with the package
//    absent, npx either prompts interactively (hanging a launcher that has no terminal) or,
//    with -y, silently downloads from the registry on every single app start. Verified:
//    `npx --no-install wigolo` fails with "canceled due to missing packages and no YES
//    option". So we look for an already-installed binary and give up quietly if there is
//    none.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { executableCandidates, pickFromPathLookup, needsShell } from "./wigolo-launch.mjs";

// For the optional better-sqlite3 read in setting() below.
const require = createRequire(import.meta.url);

const DATA_DIR = process.env.FACELESS_STUDIO_DATA_DIR ?? path.join(os.homedir(), ".faceless-studio");
const PID_FILE = path.join(DATA_DIR, "wigolo.pid");
const LOG_FILE = path.join(DATA_DIR, "wigolo.log");
const DEFAULT_URL = "http://127.0.0.1:3477";
const READY_TIMEOUT_MS = 20_000;

const say = (msg) => process.stdout.write(`[wigolo] ${msg}\n`);

/**
 * Settings live in the app's SQLite DB, so this reads them directly rather than importing
 * the TypeScript settings module. Any failure — no DB yet on a fresh install, a locked file,
 * better-sqlite3 not built — falls back to the defaults instead of stopping the app.
 */
function setting(key, fallback = "") {
  try {
    const dbPath = path.join(DATA_DIR, "studio.db");
    if (!fs.existsSync(dbPath)) return fallback;
    // better-sqlite3 is CommonJS and its module.exports IS the constructor — there is no
    // `.default` to destructure, and reaching for one yields undefined, which throws on
    // `new` and silently lands in the catch below as "use the defaults".
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
      return row && row.value ? String(row.value) : fallback;
    } finally {
      db.close();
    }
  } catch {
    return fallback;
  }
}

const baseUrl = () => (setting("WIGOLO_URL", DEFAULT_URL) || DEFAULT_URL).trim();

/** Port the daemon should listen on, taken from the configured URL so the two can't drift. */
function portFromUrl(url) {
  try {
    const p = new URL(url).port;
    return p || "3477";
  } catch {
    return "3477";
  }
}

async function isUp(url, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(new URL("/health", url), { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An already-installed wigolo executable, or null. Order: explicit setting, then PATH, then
 * the project's own node_modules. Nothing is ever fetched.
 *
 * Every step goes through executableCandidates/pickFromPathLookup, so on Windows the
 * extensionless npm shim is never chosen — Node cannot execute it (spawn → ENOENT).
 */
function findBinary() {
  const explicit = setting("WIGOLO_BIN").trim();
  if (explicit) return executableCandidates(explicit).find((p) => fs.existsSync(p)) ?? null;

  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["wigolo"], { encoding: "utf8" });
  if (onPath.status === 0) {
    const hit = pickFromPathLookup(onPath.stdout);
    if (hit && fs.existsSync(hit)) return hit;
  }

  const local = path.join(process.cwd(), "node_modules", ".bin", "wigolo");
  return executableCandidates(local).find((p) => fs.existsSync(p)) ?? null;
}

/**
 * The wigolo package's own JS entry point, resolved from the project's node_modules.
 *
 * wigolo is a dependency of this project and its `bin` is a plain .js file, so the most
 * reliable way to start it is to hand that file to the SAME node that is running this
 * script. That skips the shim layer entirely — no extensionless file to hit ENOENT on, no
 * .cmd needing a shell, no PATH lookup to get wrong — and it behaves identically on
 * Windows, macOS and Linux. It also keeps the pid ours: the process we start IS wigolo,
 * not a cmd.exe wrapper that would survive being killed.
 *
 * Returns null when the package isn't installed here (e.g. a global-only install), and the
 * binary search above takes over.
 */
function findPackageEntry() {
  try {
    // Read node_modules/wigolo/package.json by PATH, not via require.resolve: wigolo
    // declares an `exports` map that does not expose "./package.json", so resolving it
    // throws ERR_PACKAGE_PATH_NOT_EXPORTED. That failure is silent (we'd fall back to the
    // shim and break Windows again), so it is deliberately not done that way.
    const pkgPath = path.join(process.cwd(), "node_modules", "wigolo", "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.wigolo;
    if (!rel) return null;
    const entry = path.resolve(path.dirname(pkgPath), rel);
    // Only hand node something node can run; a compiled binary must go through spawn as-is.
    if (!/\.(js|mjs|cjs)$/i.test(entry) || !fs.existsSync(entry)) return null;
    return entry;
  } catch {
    return null;
  }
}

/**
 * How to start the daemon: `{ file, args, viaShell }`, or null when nothing is installed.
 *
 * WIGOLO_BIN comes first because it is the operator saying explicitly which build to run;
 * an automatic choice must never quietly override that.
 */
function launchPlan(port) {
  const serve = ["serve", "--port", port];

  const explicit = setting("WIGOLO_BIN").trim();
  if (explicit) {
    const bin = executableCandidates(explicit).find((p) => fs.existsSync(p));
    return bin ? { file: bin, args: serve, viaShell: needsShell(bin) } : null;
  }

  const entry = findPackageEntry();
  if (entry) return { file: process.execPath, args: [entry, ...serve], viaShell: false };

  const bin = findBinary();
  return bin ? { file: bin, args: serve, viaShell: needsShell(bin) } : null;
}

/**
 * The command line of a running process, or null when it cannot be determined.
 *
 * null is meaningful and is NOT the same as "no match": the caller refuses to kill anything
 * it could not positively identify, so an unavailable lookup fails safe.
 */
function commandLineOf(pid) {
  const probes =
    process.platform === "win32"
      ? [
          ["powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]],
          // wmic is absent from recent Windows builds, hence the PowerShell probe first.
          ["wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine"]],
        ]
      : [["ps", ["-o", "command=", "-p", String(pid)]]];

  for (const [file, args] of probes) {
    const r = spawnSync(file, args, { encoding: "utf8" });
    if (r.status === 0 && String(r.stdout || "").trim()) return String(r.stdout);
  }
  return null;
}

/** True when `pid` is alive AND positively identifiable as our daemon — see stop() for why. */
function isOurDaemon(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check only
  } catch {
    return false; // no such process (ESRCH), or not ours to signal (EPERM)
  }
  const cmd = commandLineOf(pid);
  if (cmd === null) return false; // couldn't verify → treat as "not ours" and leave it be
  // Both tokens, not just the name: we launch it as `<bin> serve --port N`, and "wigolo"
  // alone would also match any unrelated process whose command line merely mentions the
  // word — a checkout living in a directory named …/something-wigolo/ is enough.
  return /wigolo/i.test(cmd) && /\bserve\b/.test(cmd);
}

async function ensure() {
  const url = baseUrl();
  if (await isUp(url)) {
    say(`already running at ${url}`);
    return;
  }

  const plan = launchPlan(portFromUrl(url));
  if (!plan) {
    // The normal state on any machine that never installed it. Not a warning — the app is
    // fully functional without this source, it simply stays unavailable.
    say("not installed — the Wigolo photo source will be unavailable (everything else works)");
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");

  // RULE 1 OF THIS FILE, and the reason a client could not start the app at all:
  // spawn() reports a launch failure as an 'error' EVENT, not by throwing. An unhandled
  // 'error' event is a hard crash with a non-zero exit — and this script runs from
  // `predev`, so that crash took `npm run dev` down with it. The app didn't lose an
  // optional photo source; it refused to start. Both the synchronous throw (EINVAL on a
  // .cmd without a shell) and the async event must be caught here.
  let child;
  try {
    child = spawn(plan.file, plan.args, {
      detached: true, // survives this script and the npm process that ran it
      stdio: ["ignore", out, out],
      shell: plan.viaShell,
      windowsHide: true, // no console window flashing up on Windows
    });
  } catch (e) {
    say(`could not start (${e?.code ?? e?.message ?? e}) — continuing without it`);
    return;
  }

  let launchError = null;
  child.on("error", (e) => {
    launchError = e;
  });
  child.unref();
  if (child.pid) fs.writeFileSync(PID_FILE, String(child.pid));
  say(`starting on ${url} (pid ${child.pid ?? "?"}, log: ${LOG_FILE})`);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    // The 'error' event lands a tick or two after spawn returns, so it is checked inside
    // the wait loop: without this we would sit here for the full 20s waiting on a process
    // that never existed.
    if (launchError) {
      fs.rmSync(PID_FILE, { force: true }); // never leave a pid that was never running
      say(`could not start (${launchError.code ?? launchError.message}) — continuing without it`);
      return;
    }
    if (await isUp(url)) {
      say("ready");
      return;
    }
  }
  // Started but slow (it lazy-loads a browser engine and ML models on first use). Not fatal:
  // the source is simply empty until it finishes coming up.
  say(`still starting after ${READY_TIMEOUT_MS / 1000}s — continuing; see ${LOG_FILE}`);
}

function stop() {
  if (!fs.existsSync(PID_FILE)) {
    say("nothing to stop");
    return;
  }
  const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
  fs.rmSync(PID_FILE, { force: true });

  if (!Number.isInteger(pid) || pid <= 0) {
    say("stale pid file discarded");
    return;
  }
  // A pid file can outlive its process by days, and the OS recycles pids — the number may
  // by now belong to something else entirely, possibly something the operator cares about.
  // So existence alone is not enough: the process also has to look like wigolo.
  if (!isOurDaemon(pid)) {
    say(`pid ${pid} is not a wigolo process — leaving it alone, stale pid file discarded`);
    return;
  }
  try {
    if (process.platform === "win32") {
      // /T kills the process TREE. On Windows the pid can be a cmd.exe wrapper (a .cmd
      // shim has to be launched through a shell — see needsShell), and killing only the
      // wrapper would leave the real daemon running and unreachable. wigolo also spawns
      // workers for its browser/ML engine, which /T reaps too.
      const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || "taskkill failed").trim());
    } else {
      process.kill(pid);
    }
    say(`stopped (pid ${pid})`);
  } catch (e) {
    say(`could not stop pid ${pid}: ${e.message}`);
  }
}

const cmd = process.argv[2];
try {
  if (cmd === "stop") stop();
  else await ensure();
} catch (e) {
  // Belt and braces: whatever went wrong, starting the app must not be what pays for it.
  say(`skipped (${e?.message ?? e})`);
}
process.exit(0);

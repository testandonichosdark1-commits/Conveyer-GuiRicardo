import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { DATA_DIR } from "./data-dir";

export { DATA_DIR };

/**
 * Root for run output folders (audio, images, animations, clips, final.mp4).
 * User can override via /settings → RUNS_OUTPUT_DIR.
 * Default: <DATA_DIR>/runs/
 */
const getRunsOutputSetting = db.prepare(
  "SELECT value FROM settings WHERE key = 'RUNS_OUTPUT_DIR'"
);

export function getRunsRoot(): string {
  const row = getRunsOutputSetting.get() as { value: string } | undefined;
  const custom = row?.value?.trim();
  return custom && custom.length > 0 ? custom : path.join(DATA_DIR, "runs");
}

const getFolderStmt = db.prepare("SELECT folder_name FROM runs WHERE id = ?");

/** Absolute path to a specific run's folder. */
export function getRunDir(runId: string): string {
  const row = getFolderStmt.get(runId) as { folder_name: string | null } | undefined;
  return path.join(getRunsRoot(), row?.folder_name || runId);
}

/**
 * Total size in bytes of every file under `dir` (recursive). A missing dir → 0.
 * Used by the storage widget (walk of the runs root) and the per-run delete
 * dialog (single run folder). Best-effort: entries that vanish mid-walk or that
 * we can't stat are skipped rather than throwing.
 */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        total += dirSizeBytes(full);
      } else if (ent.isFile()) {
        total += fs.statSync(full).size;
      }
    } catch {
      // vanished / permission — skip
    }
  }
  return total;
}

/**
 * Turn a run title into a safe folder name:
 *  - strip Windows-forbidden characters `<>:"/\|?*` and control chars
 *  - clamp to 80 characters
 *  - if empty after sanitization, fall back to the short UUID
 */
export function sanitizeFolderName(title: string | null | undefined, fallback: string): string {
  // Strip Windows-forbidden chars AND apostrophes / quotes / backticks. The
  // latter are legal on disk but break ffmpeg's concat-list single-quote
  // syntax (and assorted shell tooling) when they land in a run folder path —
  // e.g. a run titled "Woman's Fountain of Youth" crashed assembly.
  let name = (title ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1f'`‘’“”]/g, "")
    .trim();
  if (name.length > 80) name = name.slice(0, 80).trim();
  return name || fallback;
}

/**
 * Pick a folder name that doesn't collide with anything on disk yet
 * (appends `(2)`, `(3)`, ... if base already taken).
 */
export function pickAvailableFolderName(base: string): string {
  const root = getRunsRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  let name = base;
  let n = 2;
  while (fs.existsSync(path.join(root, name))) {
    name = `${base} (${n})`;
    n++;
  }
  return name;
}

/**
 * Validate + create the RUNS_OUTPUT_DIR, then refresh the `data/runs` junction
 * inside the project so file browsers always see the right contents.
 * Called from /api/settings when RUNS_OUTPUT_DIR changes.
 */
export function applyRunsRoot(newPath: string | undefined): { ok: boolean; error?: string; resolved?: string } {
  const target = newPath?.trim() ? newPath.trim() : path.join(DATA_DIR, "runs");

  // Reject paths inside the project source tree — Turbopack would scan them
  if (/[\\/](src|node_modules|\.next)[\\/]?/.test(target)) {
    return { ok: false, error: "Path cannot be inside src/, node_modules/, or .next/" };
  }

  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Failed to create folder: ${(e as Error).message}` };
  }

  // Refresh the `data/runs` junction in the project so navigating from the
  // project folder always lands in the current runs directory. Best-effort.
  try {
    const projectData = path.join(process.cwd(), "data");
    const projectRunsLink = path.join(projectData, "runs");
    if (!fs.existsSync(projectData)) fs.mkdirSync(projectData, { recursive: true });
    if (fs.existsSync(projectRunsLink)) {
      const stat = fs.lstatSync(projectRunsLink);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        fs.rmSync(projectRunsLink, { recursive: true, force: true });
      }
    }
    if (process.platform === "win32") {
      fs.symlinkSync(target, projectRunsLink, "junction");
    } else {
      fs.symlinkSync(target, projectRunsLink, "dir");
    }
  } catch {
    // Non-critical: the platform still works even if the junction fails.
  }

  return { ok: true, resolved: target };
}

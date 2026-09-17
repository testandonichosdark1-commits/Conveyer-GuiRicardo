import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execSync } from "node:child_process";

/**
 * Legacy/shared root — the ONLY data dir before per-branch isolation existed,
 * and still the fallback when a branch can't be determined (no .git, a
 * detached HEAD, or a production deploy shipped without git history). Also
 * the seed source for a branch dir's first run.
 */
const HOME_ROOT = path.join(os.homedir(), ".faceless-studio");

/**
 * Sibling of HOME_ROOT, NOT nested inside it — fs.cpSync refuses to copy a
 * directory into its own subdirectory, so a branch dir under
 * HOME_ROOT/branches/<name> could never be seeded from HOME_ROOT itself.
 */
const BRANCHES_ROOT = path.join(os.homedir(), ".faceless-studio-branches");

/** Current git branch of this working tree, or null if it can't be resolved. */
function detectGitBranch(): string | null {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    // "HEAD" means detached HEAD (rev-parse's own placeholder), not a real branch.
    return out && out !== "HEAD" ? out : null;
  } catch {
    return null;
  }
}

function sanitizeForPath(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * What actually constitutes "settings and avatars": the DB (settings table +
 * avatars metadata + channels) plus the two folders that hold their files.
 * Deliberately NOT the rest of HOME_ROOT — bin/ (auto-downloaded ffmpeg/
 * yt-dlp) and local-engines/ (a full Python venv) are large shared tooling,
 * runs/ is generated output rather than config, and uploads/ is transient
 * staging. Copying those per branch would be slow and wasteful for
 * something the operator never asked to duplicate.
 */
const SEEDED_ENTRIES = ["studio.db", "avatars", "settings"];

/**
 * One-time seed for a branch dir that doesn't exist yet: copy the legacy
 * shared root's settings/avatars into it, so switching to per-branch
 * storage doesn't blank out config a run already had. Never touches an
 * existing branch dir (no re-seeding, no overwrite of anything the branch
 * has since changed).
 */
function seedFromLegacy(branchDir: string): void {
  if (fs.existsSync(branchDir) || !fs.existsSync(HOME_ROOT)) return;
  try {
    fs.mkdirSync(branchDir, { recursive: true });
    for (const entry of SEEDED_ENTRIES) {
      const src = path.join(HOME_ROOT, entry);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(branchDir, entry), { recursive: true });
    }
  } catch {
    // Best-effort seed only — an empty fresh dir is still a valid outcome.
  }
}

/**
 * Data dir holds the SQLite database (settings, run records, logs), avatars
 * and uploads. Lives outside the project source tree so Turbopack's
 * file-watcher doesn't scan lock-prone SQLite shm/wal files, and so
 * `git pull`/checkout never touches user data.
 *
 * Scoped per git branch by default: each branch checked out in this working
 * tree gets its own settings/avatars/channels/runs, so switching branches
 * never carries over another branch's config. Override with
 * FACELESS_STUDIO_DATA_DIR to force one shared dir regardless of branch.
 */
export const DATA_DIR: string = (() => {
  const override = process.env.FACELESS_STUDIO_DATA_DIR;
  if (override) return override;
  const branch = detectGitBranch();
  if (!branch) return HOME_ROOT;
  const branchDir = path.join(BRANCHES_ROOT, sanitizeForPath(branch));
  seedFromLegacy(branchDir);
  return branchDir;
})();

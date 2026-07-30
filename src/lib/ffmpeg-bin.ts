import fs from "node:fs";
import path from "node:path";
import { getSetting } from "./settings";
import { DATA_DIR } from "./run-paths";

/**
 * Central ffmpeg / ffprobe binary resolver.
 *
 * Resolution order (first hit wins):
 *   1. FFMPEG_PATH setting — explicit absolute path (highest priority override).
 *   2. A bundled / dropped-in binary in the project's `bin/` folder — lets a
 *      non-technical operator simply copy ffmpeg's `bin` folder into the project
 *      (or have it shipped there), with NO PATH editing and NO FFMPEG_PATH typing.
 *   3. Bare "ffmpeg" / "ffprobe" — rely on the system PATH.
 *
 * Resolved fresh on every call (cheap fs.existsSync probes) so a newly-set
 * FFMPEG_PATH or a just-dropped-in binary takes effect without a restart.
 */

const isWin = process.platform === "win32";
const FFMPEG_EXE = isWin ? "ffmpeg.exe" : "ffmpeg";
const FFPROBE_EXE = isWin ? "ffprobe.exe" : "ffprobe";

/** Bin folders probed (in order) when FFMPEG_PATH is unset. */
function candidateDirs(): string[] {
  const cwd = process.cwd();
  return [
    path.join(cwd, "bin"), // ffmpeg's bin copied into / shipped with the project
    path.join(cwd, "ffmpeg", "bin"), // or the whole ffmpeg folder dropped in
    path.join(DATA_DIR, "bin"), // same place yt-dlp auto-downloads to
    // Standard macOS / Linux install locations, probed BEFORE the bare-"ffmpeg"
    // PATH fallback. A .command double-clicked from Finder often does NOT inherit
    // Homebrew's PATH, so an ffmpeg that works in Terminal is invisible to the app
    // → spawn ENOENT → "ffmpeg failed (rc=null)". Checking these dirs directly finds
    // it regardless of how the app was launched. (Non-existent on Windows → skipped.)
    "/opt/homebrew/bin", // Apple Silicon Homebrew
    "/usr/local/bin", // Intel Homebrew / manual installs
    "/opt/local/bin", // MacPorts
    "/usr/bin", // system package managers
  ];
}

function findInDirs(exe: string): string | null {
  for (const dir of candidateDirs()) {
    const p = path.join(dir, exe);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* unreadable candidate — skip */
    }
  }
  return null;
}

/** ffmpeg binary path/command for spawn(): FFMPEG_PATH → bundled ./bin → system PATH. */
export function resolveFfmpeg(): string {
  const explicit = getSetting("FFMPEG_PATH");
  if (explicit) return explicit;
  return findInDirs(FFMPEG_EXE) ?? "ffmpeg";
}

/**
 * ffprobe path/command. When FFMPEG_PATH is set, ffprobe is taken from beside it
 * (same bin folder); otherwise mirrors the bundled-bin → system-PATH chain.
 */
export function resolveFfprobe(): string {
  const explicit = getSetting("FFMPEG_PATH");
  if (explicit) return explicit.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  return findInDirs(FFPROBE_EXE) ?? "ffprobe";
}

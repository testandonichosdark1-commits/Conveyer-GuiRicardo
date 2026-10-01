import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

/**
 * An NTSTATUS value (Windows) leaking out as a process exit code — always >= 0xC0000000
 * when treated as an unsigned 32-bit int (the sign bit plus the top "severity" bits are
 * set for every *_ERROR status). A real ffmpeg failure (bad input, unsupported codec,
 * missing file) exits with a small code ffmpeg itself chose, normally 0-255; it is Node's
 * `spawnSync`/`spawn` reporting a status it read from the OS, not something ffmpeg
 * returned, that lands all the way out here as a 10-digit number. 3221225794
 * (0xC0000142, STATUS_DLL_INIT_FAILED) is the one observed live, on a system under
 * process-creation pressure — `ffmpeg -version` succeeded instantly seconds later in two
 * separate shells, so the binary itself was never broken.
 */
const WINDOWS_NTSTATUS_FLOOR = 0xc0000000;

/**
 * Should a failed ffmpeg/ffprobe spawn be retried? True for "the OS never actually ran
 * ffmpeg's own code" (spawn ENOENT → status null, or a Windows NTSTATUS-shaped status) —
 * worth a retry, the binary and its input were never the problem. False for a real,
 * small, ffmpeg-chosen exit code: that's ffmpeg genuinely rejecting its input, and
 * retrying it would just reproduce the same real failure.
 *
 * Shared by every ffmpeg call site in the pipeline (studio-assemble's decodeToWav/concat,
 * ken-burns, avatar-assemble) — confirmed live that the SAME transient OS failure can hit
 * any of them independently (each is its own spawn at its own instant), so each needs this
 * same check rather than only the preflight (`assertFfmpegAvailable`) having it.
 */
export function isTransientSpawnFailure(status: number | null): boolean {
  return status === null || status >= WINDOWS_NTSTATUS_FLOOR;
}

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
  // VALIDATE the explicit path — don't trust it blindly. A stale FFMPEG_PATH (the
  // binary moved/renamed/deleted, or a typo) would otherwise be spawned as-is →
  // ENOENT → the recurring "ffmpeg failed (rc=null)" crash. If it no longer exists,
  // fall through to auto-detection so a dead override self-heals instead of crashing.
  if (explicit && fs.existsSync(explicit)) return explicit;
  return findInDirs(FFMPEG_EXE) ?? "ffmpeg";
}

/**
 * ffprobe path/command. When FFMPEG_PATH is set (and exists), ffprobe is taken from
 * beside it (same bin folder); otherwise mirrors the bundled-bin → system-PATH chain.
 */
export function resolveFfprobe(): string {
  const explicit = getSetting("FFMPEG_PATH");
  if (explicit && fs.existsSync(explicit)) return explicit.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  return findInDirs(FFPROBE_EXE) ?? "ffprobe";
}

/**
 * Drop the toolchain fingerprint from a DELIVERED file's container.
 *
 * ffmpeg stamps `encoder=Lavf<ver>` on the container and `encoder=Lavc<ver> libx264`
 * on the video stream, so every video we hand a client openly advertises how it was
 * built. `-map_metadata -1` drops metadata inherited from the inputs; `-fflags +bitexact`
 * suppresses the muxer's own `encoder` tag.
 *
 * Measured, because the obvious approach does NOT work: `-metadata encoder=` clears the
 * STREAM tag but the mp4 muxer writes the container `encoder=Lavf...` regardless, and
 * even an explicit `-metadata encoder="…"` failed to override it. Only `+bitexact`
 * removes both. It is a FORMAT flag (`-fflags`, not `-flags`), so it changes muxer
 * bookkeeping only — encoders are untouched.
 *
 * Scope, deliberately: this REMOVES our stamp, it does not FORGE someone else's — no
 * fake CapCut/Premiere identity is written. Two deeper fingerprints survive
 * (`stsd/avc1` vendor_id=FFMP and `ftyp` minor_version=512); erasing those needs an
 * in-place binary patch of the MP4 boxes and is a separate piece of work.
 *
 * Apply in whichever pass writes a delivered file LAST. `masterLoudness()` re-muxes
 * final.mp4 after assembly, so it applies these too — otherwise that re-mux would
 * cheerfully stamp the tags straight back on. Lives here, in the shared ffmpeg module,
 * rather than in an assembler: both assemblers and the loudness pass need it, and
 * importing it from one of them would create a cycle.
 */
export const STRIP_TOOLCHAIN_TAGS = ["-map_metadata", "-1", "-fflags", "+bitexact"];

/**
 * Actionable message for the #1 recurring client crash — ffmpeg can't be launched
 * (surfaces as "ffmpeg failed (rc=null)"). Tells the operator exactly how to fix it
 * per-platform instead of leaving a cryptic error.
 */
export function ffmpegNotFoundMessage(): string {
  return (
    "FFmpeg was not found or could not be run — the app can't render audio/video without it. " +
    (isWin
      ? "Fix (Windows): download FFmpeg from https://www.gyan.dev/ffmpeg/builds/ (\"ffmpeg-release-full\"), unzip it " +
        "(e.g. to C:\\ffmpeg), then in Settings → full settings set FFMPEG_PATH = C:\\ffmpeg\\bin\\ffmpeg.exe and Save. " +
        "(Or just copy ffmpeg's 'bin' folder into the app folder — it's found automatically.)"
      : "Fix (Mac): open Terminal, run 'brew install ffmpeg', then fully close and relaunch the app.") +
    " If FFMPEG_PATH is already set, it likely points to a moved/deleted file — clear that field and Save (the app will auto-detect), or correct the path."
  );
}

/**
 * Preflight: verify ffmpeg actually LAUNCHES before the pipeline spends money
 * (voiceover, HeyGen). Throws {@link ffmpegNotFoundMessage} on failure so a run
 * without a usable ffmpeg fails FAST and CLEARLY, instead of burning credits and
 * then crashing at the first render with a cryptic "rc=null".
 *
 * Retried 3x with a short backoff before giving up. A single spawnSync attempt was
 * observed live to fail transiently (OS-level process-creation pressure, confirmed by
 * `ffmpeg -version` succeeding instantly seconds later in two separate shells) — the
 * pipeline crashed a run before the voiceover was even synthesized over a hiccup that
 * had already cleared by the time the operator saw the error. A genuinely missing/broken
 * ffmpeg still fails after 3 attempts with the same actionable message; this only
 * absorbs a one-off OS blip, it does not mask a real misconfiguration.
 *
 * async + a real setTimeout-based delay, deliberately — this runs inside the Node
 * server process that also serves every other concurrent run's HTTP requests. A
 * synchronous busy-wait here would freeze the ENTIRE event loop (every run, every page
 * load) for up to ~2.4s per call; `await`ing a timer costs nothing else running on the
 * server and only delays this one preflight.
 */
export async function assertFfmpegAvailable(): Promise<void> {
  const bin = resolveFfmpeg();
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let ok = false;
    try {
      const r = spawnSync(bin, ["-version"], { stdio: "pipe", timeout: 10_000 });
      ok = r.status === 0; // null (spawn ENOENT) or non-zero → not usable
    } catch {
      ok = false;
    }
    if (ok) return;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
  }
  throw new Error(ffmpegNotFoundMessage());
}

// Pure helpers for locating the wigolo executable. Extracted from wigolo.mjs so the
// Windows path selection — the part that actually broke — can be unit-tested without
// spawning anything or being on Windows.
//
// THE WINDOWS BUG THESE EXIST FOR:
// npm installs a package's bin as THREE files on Windows — `wigolo` (an extensionless
// shell script for Git Bash), `wigolo.cmd` and `wigolo.ps1`. Only the latter two are
// executable by Windows. Node's spawn() on the extensionless one fails with ENOENT,
// which is exactly what a client hit:
//
//     Error: spawn C:\…\node_modules\.bin\wigolo ENOENT
//
// And because npm puts `node_modules/.bin` on PATH when it runs a script, `where wigolo`
// lists that extensionless file FIRST — so taking the first line of the lookup picks the
// one file that cannot run.

/** Extensions Windows will actually execute, in the order we prefer them. */
const WINDOWS_EXECUTABLE = [".cmd", ".exe", ".bat", ".com"];

const hasExtension = (p) => /\.[a-z0-9]+$/i.test(p);

/**
 * Paths to try for a bare binary path, best first.
 *
 * On Windows an extensionless path is tried LAST, not first: it usually exists (npm wrote
 * it) but cannot be executed, so preferring it re-creates the ENOENT. A path that already
 * carries an extension is taken as the operator meant it.
 */
export function executableCandidates(base, platform = process.platform) {
  if (platform !== "win32" || hasExtension(base)) return [base];
  return [...WINDOWS_EXECUTABLE.map((ext) => `${base}${ext}`), base];
}

/**
 * Pick a runnable path out of `where`/`which` output.
 *
 * On Windows this SKIPS extensionless matches rather than taking the first line — see the
 * header. Returns null when the lookup found only unrunnable entries, so the caller falls
 * through to its next strategy instead of spawning something that cannot start.
 */
export function pickFromPathLookup(stdout, platform = process.platform) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (platform !== "win32") return lines[0] ?? null;
  return lines.find((l) => WINDOWS_EXECUTABLE.some((ext) => l.toLowerCase().endsWith(ext))) ?? null;
}

/**
 * Does spawning this path require a shell?
 *
 * Since the CVE-2024-27980 fix (Node 18.20.2 / 20.12.2 / 21.7.3 and later), spawning a
 * .bat or .cmd file WITHOUT `shell: true` throws `EINVAL` instead of running it. So on
 * Windows a .cmd shim — the very file we now prefer — must be launched through a shell.
 * Anything else (a real .exe, or a .js entry run by node) must NOT be, because a shell
 * adds a cmd.exe parent that owns the pid and outlives our kill.
 */
export function needsShell(file, platform = process.platform) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

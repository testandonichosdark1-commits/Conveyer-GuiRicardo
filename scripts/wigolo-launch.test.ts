import { describe, it, expect } from "vitest";
import { executableCandidates, pickFromPathLookup, needsShell } from "./wigolo-launch.mjs";

/**
 * The Windows launch bug, pinned. A client on Windows could not start the app AT ALL:
 *
 *     Error: spawn C:\…\node_modules\.bin\wigolo ENOENT
 *
 * npm writes a package's bin as three files on Windows — an extensionless shell script,
 * a .cmd and a .ps1 — and only the last two are executable by Windows. npm also puts
 * node_modules/.bin on PATH when running a script, so `where wigolo` lists the
 * extensionless one FIRST. Taking the first line picked the one file that cannot run.
 *
 * Everything here is pure, and platform is a parameter, so the Windows behaviour is
 * testable from any machine — which is the point: none of us develops on Windows.
 */

/** Verbatim `where wigolo` output from the client's machine, extensionless line first. */
const WHERE_OUTPUT = [
  "C:\\rohit\\vToolV.01\\node_modules\\.bin\\wigolo",
  "C:\\rohit\\vToolV.01\\node_modules\\.bin\\wigolo.cmd",
  "C:\\rohit\\vToolV.01\\node_modules\\.bin\\wigolo.ps1",
].join("\r\n");

describe("pickFromPathLookup", () => {
  it("skips the extensionless shim Windows cannot execute — the actual ENOENT", () => {
    expect(pickFromPathLookup(WHERE_OUTPUT, "win32")).toBe(
      "C:\\rohit\\vToolV.01\\node_modules\\.bin\\wigolo.cmd"
    );
  });

  it("never returns a .ps1 — spawn cannot run it either", () => {
    const onlyPs1 = "C:\\x\\wigolo\r\nC:\\x\\wigolo.ps1";
    expect(pickFromPathLookup(onlyPs1, "win32")).toBeNull();
  });

  it("returns null rather than an unrunnable path, so the caller can fall through", () => {
    expect(pickFromPathLookup("C:\\x\\wigolo", "win32")).toBeNull();
    expect(pickFromPathLookup("", "win32")).toBeNull();
  });

  it("takes the first match on POSIX, where an extensionless binary is the normal case", () => {
    expect(pickFromPathLookup("/usr/local/bin/wigolo\n/opt/bin/wigolo\n", "linux")).toBe(
      "/usr/local/bin/wigolo"
    );
  });

  it("tolerates CRLF and stray whitespace from `where`", () => {
    expect(pickFromPathLookup("  C:\\x\\wigolo.cmd  \r\n\r\n", "win32")).toBe("C:\\x\\wigolo.cmd");
  });
});

describe("executableCandidates", () => {
  it("tries executable extensions BEFORE the bare path on Windows", () => {
    // Order matters: the extensionless file usually exists (npm wrote it), so preferring
    // it re-creates the ENOENT. It stays last as a final resort, not first.
    const got = executableCandidates("C:\\x\\wigolo", "win32");
    expect(got[0]).toBe("C:\\x\\wigolo.cmd");
    expect(got.at(-1)).toBe("C:\\x\\wigolo");
    expect(got).toContain("C:\\x\\wigolo.exe");
  });

  it("respects a path the operator already gave an extension to", () => {
    expect(executableCandidates("C:\\x\\wigolo.exe", "win32")).toEqual(["C:\\x\\wigolo.exe"]);
  });

  it("changes nothing on POSIX", () => {
    expect(executableCandidates("/usr/local/bin/wigolo", "darwin")).toEqual(["/usr/local/bin/wigolo"]);
  });
});

describe("needsShell", () => {
  it("requires a shell for .cmd/.bat — Node throws EINVAL without one", () => {
    // Since the CVE-2024-27980 fix (Node 18.20.2+), spawning a .cmd without shell:true
    // fails outright. The client is on Node 22, so this is not hypothetical: it is the
    // error the "just find the .cmd" fix would have hit next.
    expect(needsShell("C:\\x\\wigolo.cmd", "win32")).toBe(true);
    expect(needsShell("C:\\x\\wigolo.bat", "win32")).toBe(true);
  });

  it("does NOT use a shell for a real executable or for node itself", () => {
    // A shell would insert a cmd.exe parent that owns the pid and survives our kill.
    expect(needsShell("C:\\x\\wigolo.exe", "win32")).toBe(false);
    expect(needsShell("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe(false);
  });

  it("never uses a shell on POSIX", () => {
    expect(needsShell("/usr/local/bin/wigolo", "darwin")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { runAsync, killTreeWin32 } from "./visual-source";

/** True while `pid` still exists. Signal 0 = existence probe, no signal delivered. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * Guards for the CONFIRMED field hang: runs freezing dead at the YouTube step with no
 * error and no crash. Mechanism — yt-dlp spawns an ffmpeg grandchild that inherits the
 * stdout/stderr pipes; when yt-dlp dies the grandchild keeps the write-ends open, so the
 * child's "close" event never fires. Settling only on "close" therefore left the promise
 * pending forever, hanging the beat and leaking its ytDownloadLimiter slot.
 *
 * These are hermetic: no network, no yt-dlp binary — just `node -e` children that
 * reproduce the exact stdio shapes runAsync must survive.
 */

const node = process.execPath;

describe("runAsync", () => {
  it("resolves with status 0 and captured stdout for a normal child", async () => {
    const r = await runAsync(node, ["-e", "process.stdout.write('hello')"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("hello");
    expect(r.error).toBeUndefined();
  });

  it("returns Buffer output when no encoding is set (spawnSync's rule)", async () => {
    const r = await runAsync(node, ["-e", "process.stdout.write('bytes')"]);
    expect(Buffer.isBuffer(r.stdout)).toBe(true);
    expect((r.stdout as Buffer).toString()).toBe("bytes");
  });

  /**
   * THE REGRESSION TEST — this is the actual production bug.
   *
   * The child spawns a detached grandchild that INHERITS its stdout, then exits at once.
   * The grandchild lives on holding the pipe write-end open, so "close" never arrives:
   * against the old settle-on-close-only logic this promise stays pending forever and the
   * test times out. With the exit-drain settle it resolves inside EXIT_DRAIN_MS (2s).
   */
  it("settles when the child exits but a grandchild keeps the stdout pipe open", async () => {
    const script = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: ["ignore", 1, "ignore"], // inherit OUR stdout — the pipe runAsync reads
        detached: true,
      });
      g.unref();
      process.stdout.write("parent-done:" + g.pid); // pid so the test can reap the orphan
      process.exit(0);
    `;
    const t0 = Date.now();
    const r = await runAsync(node, ["-e", script], { encoding: "utf8" });
    const elapsed = Date.now() - t0;

    // Reap the deliberately-orphaned grandchild rather than leaving it to age out (30s).
    const gpid = Number(/parent-done:(\d+)/.exec(String(r.stdout))?.[1]);
    if (Number.isFinite(gpid) && gpid > 0) {
      try { process.kill(gpid, "SIGKILL"); } catch {}
    }

    // The guarantee: the promise settles once the process is gone, grandchild or not.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("parent-done");
    // Settled via the drain path (~2s), nowhere near the grandchild's 30s lifetime.
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  /**
   * THE OTHER HALF — and the shape real yt-dlp actually has.
   *
   * The test above spawns its grandchild `detached`, which puts it OUT of the child's
   * process group: killTree's kill(-pid) cannot reach it, so that test only ever exercises
   * the exit-drain. yt-dlp spawns ffmpeg NON-detached, i.e. INSIDE the group — so this is
   * the case where killTree is the guard that does the work. Here the parent stays alive and
   * silent, so the drain can't help: only the stall watchdog + a group kill can settle this.
   */
  it("stall-kills the whole group when a NON-detached grandchild holds the stdout pipe", async () => {
    const script = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: ["ignore", 1, "ignore"], // inherit OUR stdout; same process group (no detach)
      });
      process.stdout.write("gpid:" + g.pid);
      setTimeout(() => {}, 30000); // parent lives on, silent — nothing can settle but killTree
    `;
    const r = await runAsync(node, ["-e", script], { encoding: "utf8", stallTimeout: 300 });

    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe("ESTALLED");
    expect(r.status).not.toBe(0);

    // The point of the test: killTree reaped the GRANDCHILD too, not just the direct child.
    const gpid = Number(/gpid:(\d+)/.exec(String(r.stdout))?.[1]);
    expect(Number.isFinite(gpid) && gpid > 0).toBe(true);
    for (let i = 0; i < 40 && alive(gpid); i++) await new Promise((res) => setTimeout(res, 50));
    const grandchildStillAlive = alive(gpid);
    if (grandchildStillAlive) { try { process.kill(gpid, "SIGKILL"); } catch {} } // don't leak on failure
    expect(grandchildStillAlive).toBe(false);
  }, 20_000);

  /**
   * win32 fallback (#1). Windows cannot be executed on this host, so the branch is reached
   * by injecting a failing taskkill — modelling the way spawnSync ACTUALLY reports a missing
   * binary: it returns `{ error, status: null }`, it does NOT throw. The bug being guarded
   * against is that a `try { spawnSync(...) } catch {}` therefore swallows nothing, silently
   * kills nothing, and the promise never settles → the original field hang, on the client's
   * platform. The fallback must still reap the direct child.
   */
  it("falls back to child.kill when taskkill fails to reap (win32 branch)", async () => {
    const child = spawn(node, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise((res) => child.once("spawn", res));
    const pid = child.pid!;
    try {
      let called = 0;
      // Exactly what spawnSync returns for an ENOENT taskkill: no throw, error set, status null.
      killTreeWin32(child, "SIGTERM", () => {
        called++;
        return { error: Object.assign(new Error("spawnSync taskkill ENOENT"), { code: "ENOENT" }), status: null };
      });
      expect(called).toBe(1);
      for (let i = 0; i < 40 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50));
      expect(alive(pid)).toBe(false);
    } finally {
      // A FAILING assertion here means the child was NOT reaped — never leak it to the suite.
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }, 20_000);

  it("does NOT fall back to child.kill when taskkill succeeds (win32 branch)", async () => {
    // status 0 + no error = the tree is already gone; a second signal would be redundant.
    const child = spawn(node, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise((res) => child.once("spawn", res));
    const pid = child.pid!;
    try {
      killTreeWin32(child, "SIGTERM", () => ({ status: 0 }));
      expect(alive(pid)).toBe(true); // untouched — taskkill "handled" it
    } finally {
      child.kill("SIGKILL");
      await new Promise((res) => child.once("exit", res));
    }
  }, 20_000);

  /**
   * The Ctrl+C reaper (`detached` stops SIGINT propagating, so we kill survivors on exit)
   * must hook the process ONCE. A listener per spawn would leak and trip
   * MaxListenersExceededWarning after 10 downloads — i.e. in every real run.
   */
  it("registers its shutdown handlers once, not per spawn", async () => {
    const count = () => process.listenerCount("SIGINT") + process.listenerCount("SIGTERM") + process.listenerCount("exit");
    await runAsync(node, ["-e", "process.stdout.write('a')"], { encoding: "utf8" });
    const after1 = count();
    for (let i = 0; i < 5; i++) await runAsync(node, ["-e", "process.stdout.write('a')"], { encoding: "utf8" });
    expect(count()).toBe(after1);
  }, 20_000);

  it("kills a silent child via the stall watchdog and reports ESTALLED", async () => {
    const r = await runAsync(node, ["-e", "setTimeout(() => {}, 30000)"], {
      encoding: "utf8",
      stallTimeout: 200,
    });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe("ESTALLED");
    expect(r.status).not.toBe(0);
  }, 20_000);

  it("does NOT kill a slow child that keeps emitting progress (stall timer resets)", async () => {
    // Emits a byte every ~50ms for ~600ms — total runtime is well past stallTimeout (300ms),
    // but it is never silent for 300ms, so it must be allowed to finish. This is the
    // throttled-but-working download the old flat timeout wrongly killed.
    const script = `
      let n = 0;
      const t = setInterval(() => {
        process.stdout.write(".");
        if (++n === 12) { clearInterval(t); process.exit(0); }
      }, 50);
    `;
    const r = await runAsync(node, ["-e", script], { encoding: "utf8", stallTimeout: 300 });
    expect(r.status).toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toBe(".".repeat(12));
  }, 20_000);

  it("reports spawn failure (ENOENT) as status null with error set", async () => {
    const r = await runAsync("definitely-not-a-real-binary-xyz", ["--version"], { encoding: "utf8" });
    expect(r.status).toBeNull();
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
  });

  it("enforces the absolute timeout cap as ETIMEDOUT even while output flows", async () => {
    // Chatty forever: the stall watchdog never fires, so only the absolute cap can stop it.
    const script = `setInterval(() => process.stdout.write("x"), 20);`;
    const r = await runAsync(node, ["-e", script], {
      encoding: "utf8",
      stallTimeout: 5000,
      timeout: 300,
    });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
  }, 20_000);
});

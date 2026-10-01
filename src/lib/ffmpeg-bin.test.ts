import { describe, it, expect, vi, beforeEach } from "vitest";

// resolveFfmpeg() falls through to the bare "ffmpeg" PATH command when nothing else
// matches — no filesystem probing needed for these tests, so settings/run-paths stay
// unmocked and simply resolve to their real (irrelevant) values.
const spawnSyncMock = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync: (...args: unknown[]) => spawnSyncMock(...args) }));

const { assertFfmpegAvailable, isTransientSpawnFailure } = await import("./ffmpeg-bin");

beforeEach(() => {
  spawnSyncMock.mockReset();
  vi.useFakeTimers();
});

/** Advance past assertFfmpegAvailable's internal backoff without a real 2.4s test. */
async function flushRetries() {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve(); // let the pending spawnSync/await settle
    await vi.runAllTimersAsync();
  }
}

describe("isTransientSpawnFailure", () => {
  it("treats a Node spawn ENOENT (status null) as transient", () => {
    expect(isTransientSpawnFailure(null)).toBe(true);
  });

  it("treats the live-observed Windows NTSTATUS exit code as transient", () => {
    // 3221225794 = 0xC0000142 (STATUS_DLL_INIT_FAILED) — confirmed live: ffmpeg's OWN
    // preflight passed, then the real decode call failed with exactly this code while
    // `ffmpeg -version` succeeded instantly in two separate shells seconds later.
    expect(isTransientSpawnFailure(3221225794)).toBe(true);
  });

  it("does NOT retry a real small ffmpeg exit code", () => {
    // ffmpeg itself choosing to exit 1 (bad input, missing codec, etc.) is a REAL failure
    // — retrying it would just waste time reproducing the same real problem.
    expect(isTransientSpawnFailure(1)).toBe(false);
    expect(isTransientSpawnFailure(255)).toBe(false);
  });

  it("treats the status 0 case as out of scope (callers check this separately)", () => {
    // Not actually a failure path at all — included for documentation of the boundary.
    expect(isTransientSpawnFailure(0)).toBe(false);
  });
});

describe("assertFfmpegAvailable", () => {
  it("resolves immediately when the first attempt succeeds — no retry spent", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    await expect(assertFfmpegAvailable()).resolves.toBeUndefined();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("recovers from a transient spawn failure on a later attempt", async () => {
    // Mirrors what was observed live: spawnSync failed once (OS-level process-creation
    // pressure) while a plain `ffmpeg -version` in two other shells succeeded seconds
    // later — the binary was never actually broken, the FIRST probe just lost a race.
    spawnSyncMock
      .mockReturnValueOnce({ status: null }) // spawn ENOENT / transient failure
      .mockReturnValueOnce({ status: 0 });
    const p = assertFfmpegAvailable();
    await flushRetries();
    await expect(p).resolves.toBeUndefined();
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("still throws the actionable message when ffmpeg is genuinely unusable every time", async () => {
    // The retry must never mask a REAL misconfiguration — it only absorbs a one-off blip.
    // The rejects.toThrow() assertion is attached to `p` BEFORE flushRetries() advances
    // the fake timers that let it settle, so there is never a tick where `p` is a
    // rejected promise with no handler attached yet (which vitest/Node reports as an
    // unhandled rejection even though the test goes on to await it correctly).
    spawnSyncMock.mockReturnValue({ status: null });
    const p = assertFfmpegAvailable();
    const assertion = expect(p).rejects.toThrow(/FFmpeg was not found or could not be run/);
    await flushRetries();
    await assertion;
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });

  it("treats a thrown spawnSync call the same as a bad status (both are 'not usable')", async () => {
    spawnSyncMock.mockImplementationOnce(() => { throw new Error("spawn EAGAIN"); });
    spawnSyncMock.mockReturnValueOnce({ status: 0 });
    const p = assertFfmpegAvailable();
    await flushRetries();
    await expect(p).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Studio runs auto-upload to Google Drive (Bug #1).
 *
 * Before this, `syncRunToDrive` was called only from the LEGACY pipeline and the manual
 * button, so the pipeline that renders every video this product makes never uploaded
 * anything: the toggle could be on and Drive connected, and "Not yet in Google Drive"
 * would stay forever, with no error to explain it.
 *
 * What must hold, and is guarded here:
 *   1. the studio path calls the EXISTING implementation — no second upload path;
 *   2. it does NOT pass `force`, so GDRIVE_SYNC_ENABLED still decides (the manual
 *      button passes force:true precisely because a manual action overrides the toggle —
 *      an automatic one must not);
 *   3. a Drive failure never turns a finished render into a failed run.
 *
 * studio-pipeline pulls in the whole render stack at import, so the leaves are stubbed —
 * same approach as degrade-code.test.ts.
 */

const { drive } = vi.hoisted(() => ({ drive: { sync: vi.fn(), rebuild: vi.fn() } }));
const { logs } = vi.hoisted(() => ({ logs: [] as { level: string; msg: string }[] }));

vi.mock("./settings", () => ({ getSetting: () => "" }));
vi.mock("./logger", () => ({ log: (_r: string, level: string, msg: string) => { logs.push({ level, msg }); } }));
vi.mock("./db", () => ({ default: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) } }));
vi.mock("./services/run-upload", () => ({
  syncRunToDrive: (...a: unknown[]) => drive.sync(...a),
  rebuildSceneAssetsFromDisk: (...a: unknown[]) => drive.rebuild(...a),
}));

import { syncFinishedRunToDrive } from "./studio-pipeline";

const RUN = "run-1";
const DIR = "/runs/my-run";
const FINAL = "/runs/my-run/final.mp4";

beforeEach(() => {
  drive.sync.mockReset().mockResolvedValue(true);
  drive.rebuild.mockReset().mockReturnValue([]);
  logs.length = 0;
});

describe("studio runs participate in the existing Drive flow", () => {
  it("calls the existing syncRunToDrive with the run's dir and final video", async () => {
    await syncFinishedRunToDrive(RUN, DIR, FINAL);
    expect(drive.sync).toHaveBeenCalledTimes(1);
    const [runId, assets, runDir, finalPath] = drive.sync.mock.calls[0];
    expect(runId).toBe(RUN);
    expect(runDir).toBe(DIR);
    expect(finalPath).toBe(FINAL);
    expect(assets).toEqual([]);
  });

  it("sources scene assets from the SAME helper the manual upload route uses", async () => {
    // Not a hardcoded [] — so when that helper learns the studio layout (Bug #2),
    // the automatic and manual paths start uploading clips together.
    await syncFinishedRunToDrive(RUN, DIR, FINAL);
    expect(drive.rebuild).toHaveBeenCalledWith(DIR);
    const assetsPassed = drive.sync.mock.calls[0][1];
    expect(assetsPassed).toBe(drive.rebuild.mock.results[0].value);
  });

  it("passes whatever that helper returns straight through, without inspecting it", async () => {
    const fake = [{ scene: { index: 1 } }];
    drive.rebuild.mockReturnValue(fake);
    await syncFinishedRunToDrive(RUN, DIR, FINAL);
    expect(drive.sync.mock.calls[0][1]).toBe(fake);
  });

  it("does NOT force — the GDRIVE_SYNC_ENABLED toggle still governs automatic uploads", async () => {
    // The manual route passes { force: true } so a deliberate click overrides the toggle.
    // If the automatic path ever did that, turning auto-upload OFF would stop working.
    await syncFinishedRunToDrive(RUN, DIR, FINAL);
    const opts = drive.sync.mock.calls[0][4];
    expect(opts === undefined || opts.force !== true).toBe(true);
  });
});

describe("a Drive failure never breaks a finished run", () => {
  it("swallows the error instead of rethrowing into the pipeline", async () => {
    drive.sync.mockRejectedValue(new Error("Drive quota exceeded"));
    await expect(syncFinishedRunToDrive(RUN, DIR, FINAL)).resolves.toBeUndefined();
  });

  it("logs a warning that says the local files are safe", async () => {
    drive.sync.mockRejectedValue(new Error("Drive quota exceeded"));
    await syncFinishedRunToDrive(RUN, DIR, FINAL);
    const warn = logs.find((l) => l.level === "warn");
    expect(warn?.msg).toMatch(/Drive sync failed/);
    expect(warn?.msg).toMatch(/local files preserved/);
    expect(warn?.msg).toMatch(/Drive quota exceeded/); // the real cause, not a generic message
  });

  it("survives a non-Error rejection without masking it", async () => {
    drive.sync.mockRejectedValue("socket hang up");
    await expect(syncFinishedRunToDrive(RUN, DIR, FINAL)).resolves.toBeUndefined();
    expect(logs.find((l) => l.level === "warn")?.msg).toMatch(/socket hang up/);
  });

  it("a rebuild failure is caught too — it must not escape either", async () => {
    drive.rebuild.mockImplementation(() => { throw new Error("scenes.json unreadable"); });
    await expect(syncFinishedRunToDrive(RUN, DIR, FINAL)).resolves.toBeUndefined();
    expect(drive.sync).not.toHaveBeenCalled();
    expect(logs.find((l) => l.level === "warn")?.msg).toMatch(/scenes.json unreadable/);
  });
});

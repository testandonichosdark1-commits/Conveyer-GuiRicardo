import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 2 — incremental log loading (getLogsSince). Proves the polling contract:
 * a cursor (?sinceId) returns only newer rows, so the UI appends instead of
 * re-downloading the whole history, and a resume's new lines never duplicate the
 * old ones. Throwaway DATA_DIR so the real DB is untouched; env set before import.
 */
let logger: typeof import("./logger");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-"));
  process.env.FACELESS_STUDIO_DATA_DIR = dir;
  logger = await import("./logger");
});

describe("getLogsSince (incremental log loading)", () => {
  it("returns full history at sinceId=0, only newer rows after a cursor, and never duplicates", () => {
    const run = "run-A";
    logger.log(run, "info", "first");
    logger.log(run, "info", "second");
    logger.log(run, "info", "third");

    // First load (browser mount / refresh): sinceId=0 → the whole history.
    const all = logger.getLogsSince(run, 0);
    expect(all.map((l) => l.message)).toEqual(["first", "second", "third"]);
    const cursor = all[all.length - 1].id!;

    // Poll with the cursor while nothing new happened → empty delta (no re-download).
    expect(logger.getLogsSince(run, cursor)).toEqual([]);

    // Simulate the run continuing (e.g. after Resume): new lines get higher ids.
    logger.log(run, "success", "fourth");
    logger.log(run, "success", "fifth");

    // Next poll with the SAME cursor returns ONLY the new rows — append, no dupes.
    const delta = logger.getLogsSince(run, cursor);
    expect(delta.map((l) => l.message)).toEqual(["fourth", "fifth"]);
    expect(delta.every((l) => l.id! > cursor)).toBe(true);

    // getLogs() is exactly getLogsSince(run, 0).
    expect(logger.getLogs(run).map((l) => l.message)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
      "fifth",
    ]);
  });

  it("scopes rows to their own run", () => {
    logger.log("run-B", "info", "b-only");
    const a = logger.getLogsSince("run-A", 0).map((l) => l.message);
    expect(a).not.toContain("b-only");
    expect(logger.getLogsSince("run-B", 0).map((l) => l.message)).toEqual(["b-only"]);
  });
});

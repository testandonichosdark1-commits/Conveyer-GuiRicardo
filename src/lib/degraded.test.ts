import { describe, it, expect } from "vitest";
import { parseDegraded, joinDegraded, DEGRADE_TEXT, type DegradeCode } from "./degraded";

/**
 * `runs.degraded` went from a single code to a comma-joined list so a run can report losing
 * its avatar AND its text cards. The rows already on every client's disk hold the old single
 * value, and there is no migration — these tests are what says that is safe.
 */
describe("parseDegraded", () => {
  it("reads a legacy single-code row exactly as before", () => {
    expect(parseDegraded("avatar_all")).toEqual(["avatar_all"]);
    expect(parseDegraded("avatar_partial")).toEqual(["avatar_partial"]);
  });

  it("treats a clean run as clean, whatever shape the column is in", () => {
    for (const raw of [null, undefined, "", "   "]) expect(parseDegraded(raw)).toEqual([]);
  });

  it("reads a multi-failure row", () => {
    expect(parseDegraded("avatar_partial,overlays_missing")).toEqual(["avatar_partial", "overlays_missing"]);
  });

  it("orders worst-first regardless of how it was stored", () => {
    expect(parseDegraded("overlays_missing,avatar_all")).toEqual(["avatar_all", "overlays_missing"]);
  });

  it("drops codes it doesn't know instead of rendering a blank warning", () => {
    // A newer build could write a code this one has no text for; DEGRADE_TEXT[c] would be
    // undefined and the banner would render empty. Unknown codes must not reach the UI.
    expect(parseDegraded("avatar_all,invented_later")).toEqual(["avatar_all"]);
    expect(parseDegraded("invented_later")).toEqual([]);
  });

  it("tolerates whitespace around stored codes", () => {
    expect(parseDegraded("avatar_all, overlays_missing")).toEqual(["avatar_all", "overlays_missing"]);
  });
});

describe("joinDegraded", () => {
  it("keeps a clean run's column NULL, exactly as it has always been", () => {
    expect(joinDegraded([])).toBeNull();
  });

  it("round-trips through parseDegraded", () => {
    const codes: DegradeCode[] = ["avatar_partial", "overlays_missing"];
    expect(parseDegraded(joinDegraded(codes))).toEqual(codes);
  });

  it("writes a legacy-shaped value for a single failure, so older builds still read it", () => {
    expect(joinDegraded(["avatar_all"])).toBe("avatar_all");
  });
});

describe("DEGRADE_TEXT", () => {
  it("has usable wording for every code parseDegraded can emit", () => {
    for (const code of parseDegraded("avatar_all,avatar_partial,overlays_missing")) {
      const t = DEGRADE_TEXT[code];
      expect(t.short.length).toBeGreaterThan(0);
      expect(t.heading.length).toBeGreaterThan(0);
      expect(t.detail.length).toBeGreaterThan(0);
    }
  });

  it("points the operator at the actual cause of missing cards", () => {
    expect(DEGRADE_TEXT.overlays_missing.detail).toMatch(/Gemini/);
    expect(DEGRADE_TEXT.overlays_missing.detail).toMatch(/quota/);
  });
});

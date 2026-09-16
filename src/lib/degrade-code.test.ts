import { describe, it, expect, vi } from "vitest";

/**
 * What a finished run reports it delivered.
 *
 * The bug this guards: an avatar could be deleted on HeyGen's side, every avatar beat
 * would 404 and degrade to b-roll, and the run still ended on an unqualified success.
 * The operator picked an avatar and got a faceless video with a green tick. This code
 * is what the UI keys on to say otherwise, so "no avatar at all" must never be
 * mistakable for "delivered as planned".
 */

// studio-pipeline pulls in the whole render stack at import; stub the leaves so this
// stays a pure unit test.
vi.mock("./settings", () => ({ getSetting: () => "" }));
vi.mock("./logger", () => ({ log: () => {} }));
vi.mock("./db", () => ({ default: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) } }));

import { degradeCode, degradeCodes, overlaysWereLost } from "./studio-pipeline";

describe("degradeCode", () => {
  it("reports nothing when the avatar rendered on every beat", () => {
    expect(degradeCode(0, 12)).toBeNull();
  });

  it("reports 'avatar_all' when every avatar beat was dropped (the faceless video)", () => {
    expect(degradeCode(12, 12)).toBe("avatar_all");
  });

  it("reports 'avatar_partial' when only some beats fell back to b-roll", () => {
    expect(degradeCode(3, 12)).toBe("avatar_partial");
  });

  it("still says 'avatar_all' if dropped overshoots planned", () => {
    // The two are counted at different moments. If a count ever drifts, "all of them
    // failed" must not soften into the milder "some of them".
    expect(degradeCode(13, 12)).toBe("avatar_all");
  });

  it("reports nothing for a faceless run — no avatar was asked for, so none is missing", () => {
    // planned=0 with dropped=0 must stay NULL, not divide-by-zero into a warning on
    // every faceless run.
    expect(degradeCode(0, 0)).toBeNull();
  });

  /**
   * NULL is a real outcome, not just an initial state: the pipeline writes the result of
   * this on EVERY completion, so a Resume that finally renders the avatar clears an
   * earlier degrade instead of warning about a problem the run no longer has.
   */
  it("clears back to null once a resumed run renders the avatar", () => {
    expect(degradeCode(5, 10)).toBe("avatar_partial"); // first attempt
    expect(degradeCode(0, 10)).toBeNull(); // resumed, all beats rendered
  });
});

/**
 * The same honesty rule, extended to the text cards.
 *
 * A client switched text mode ON, their Gemini key was out of quota, the plan produced no
 * cards — and the run reported a clean "done". Same defect as the faceless avatar render:
 * the warnings were in the log, the outcome contradicted them, and people read the outcome.
 */
describe("overlaysWereLost", () => {
  const withCard = [{ overlay: { type: "section", title: "x" } }, {}];
  const noCards = [{}, {}];

  it("is true only when cards were asked for and none were produced", () => {
    expect(overlaysWereLost(true, noCards)).toBe(true);
    expect(overlaysWereLost(true, withCard)).toBe(false);
  });

  it("never marks a run that did not ask for cards", () => {
    // Overlays off is the DEFAULT path — marking it would put a warning on almost every run.
    for (const requested of [false, undefined] as const) {
      expect(overlaysWereLost(requested, noCards)).toBe(false);
    }
  });

  it("asks the SAME question the assembler acts on", () => {
    // The assembler skips the overlay pass on `!beats.some(b => b.overlay)`. If this ever
    // diverged, the badge would contradict the delivered file — the exact failure mode the
    // degrade flag exists to prevent. Mixed beats: one card is enough to have delivered.
    const mixed = [{}, { overlay: { type: "fact", title: "x" } }, {}];
    expect(overlaysWereLost(true, mixed)).toBe(!mixed.some((b) => "overlay" in b));
    expect(overlaysWereLost(true, mixed)).toBe(false);
  });
});

describe("degradeCodes", () => {
  const noCards = [{}];
  const withCard = [{ overlay: { type: "section", title: "x" } }];

  it("stays NULL when the run delivered everything it promised", () => {
    expect(degradeCodes(0, 12, overlaysWereLost(true, withCard))).toBeNull();
  });

  it("writes the legacy single value when only the avatar failed", () => {
    // Byte-identical to what the column held before text cards were tracked, so an
    // older build (and every existing row) still reads it.
    expect(degradeCodes(12, 12, false)).toBe("avatar_all");
    expect(degradeCodes(3, 12, false)).toBe("avatar_partial");
  });

  it("reports missing cards on their own", () => {
    expect(degradeCodes(0, 12, true)).toBe("overlays_missing");
  });

  it("reports BOTH failures rather than letting one hide the other", () => {
    expect(degradeCodes(12, 12, true)).toBe("avatar_all,overlays_missing");
    expect(degradeCodes(3, 12, true)).toBe("avatar_partial,overlays_missing");
  });
});

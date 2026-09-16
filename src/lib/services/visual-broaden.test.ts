import { describe, it, expect, vi } from "vitest";

/**
 * broadenQuery — the three-attempt ladder that gives a beat a second and third chance at
 * stock before it gives up.
 *
 * The defect: the "protected entity" was the leading run of non-generic tokens, uncapped. A
 * query containing no generic descriptor anywhere — which is most plain descriptive queries —
 * had its ENTIRE text read as one entity, so there was nothing left to drop and every level
 * returned the original string. acquireReal then skipped the retry as a duplicate and the
 * ladder silently collapsed to a single attempt, for exactly the queries that most needed
 * broadening.
 *
 * Measured on 217 real runs before the fix: 182 of 585 broaden attempts were discarded as
 * identical — close to one in four. The four queries below are taken verbatim from those logs.
 *
 * This also matters to the surrender gate: weakPoolVerdict now answers a first weak pool with
 * "broaden and look again", which is worth nothing if broadening returns the same string.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { broadenQuery } from "./visual-source";

/** Verbatim from run_logs, where each was skipped as "broadened query identical". */
const REAL_QUERIES = [
  "modern police patrol car parked under a streetlight",
  "19th century water wheel flat blades",
  "handwritten family records inside a ledger",
  "old rusty metal gears turning slowly",
];

describe("broadenQuery — a query with no descriptor still broadens", () => {
  for (const q of REAL_QUERIES) {
    it(`narrows "${q.slice(0, 34)}…" at every level`, () => {
      const l1 = broadenQuery(q, 1);
      const l2 = broadenQuery(q, 2);
      // Each rung must be a genuinely different string, or acquireReal discards the attempt.
      expect(l1).not.toBe(q);
      expect(l2).not.toBe(l1);
      // ...and each must be strictly shorter — broadening drops words, never adds them.
      expect(l1.split(/\s+/).length).toBeLessThan(q.split(/\s+/).length);
      expect(l2.split(/\s+/).length).toBeLessThan(l1.split(/\s+/).length);
    });
  }

  it("keeps the leading words, which carry the subject", () => {
    expect(broadenQuery("modern police patrol car parked under a streetlight", 2)).toBe("modern police patrol");
    expect(broadenQuery("19th century water wheel flat blades", 2)).toBe("19th century water");
  });

  it("narrows a brand down TO the brand, instead of leaving it unbroadened", () => {
    // Before the cap both levels returned "Arm & Hammer washing soda" and level 2 was skipped
    // as a duplicate. The brand is what should survive the last rung.
    expect(broadenQuery("Arm & Hammer washing soda box", 1)).toBe("Arm & Hammer washing soda");
    expect(broadenQuery("Arm & Hammer washing soda box", 2)).toBe("Arm & Hammer");
  });
});

describe("broadenQuery — everything else is untouched", () => {
  it("is byte-identical for queries that DO lead with a descriptor", () => {
    // These already broadened correctly; the cap must not move them.
    expect(broadenQuery("aerial view rusty industrial gears turning slowly workshop", 1)).toBe("rusty industrial gears turning");
    expect(broadenQuery("aerial view rusty industrial gears turning slowly workshop", 2)).toBe("rusty industrial");
    expect(broadenQuery("wide shot rusty gears turning in an old workshop", 1)).toBe("rusty gears turning in");
    expect(broadenQuery("wide shot rusty gears turning in an old workshop", 2)).toBe("rusty gears");
  });

  it("leaves level 0 and a single-token query alone", () => {
    expect(broadenQuery("old rusty metal gears turning slowly", 0)).toBe("old rusty metal gears turning slowly");
    expect(broadenQuery("Colosseum", 1)).toBe("Colosseum");
    expect(broadenQuery("Colosseum", 2)).toBe("Colosseum");
  });

  it("does not change level 3, the strict-only widest rung", () => {
    // real-strict.test.ts depends on this rung collapsing to one token.
    expect(broadenQuery("old rusty metal gears turning slowly", 3)).toBe("old");
    expect(broadenQuery("Arm & Hammer washing soda box", 3)).toBe("Arm");
    expect(broadenQuery("aerial view rusty industrial gears turning slowly workshop", 3)).toBe("rusty");
  });
});

import { describe, it, expect, vi } from "vitest";

/**
 * Which beats are protected from being handed to AI generation.
 *
 * Two gates read this — the weak-pool surrender and the chemistry-keyword exemption that
 * skips stock retrieval entirely — so it decides, run-wide, which beats are even allowed to
 * try stock. It used to be one regex: a capital letter, or an ampersand.
 *
 * That protected "Cummins P7100" and abandoned "steel mill workers 1940s" — an era, a trade
 * and a decade, every bit as specific and well covered by stock. A cheap, expensive and
 * invisible routing decision was being made on letter case.
 *
 * The planner already classifies every beat from the NARRATION rather than from the query
 * string. These tests pin that its verdict now wins — in BOTH directions, which is the part
 * that is easy to lose: OR-ing the old text test back in "for safety" would leave the
 * original defect exactly as it was.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { __testing } from "./visual-source";
import type { Beat } from "./studio-plan";

const { entityProtected, hasLikelyEntity } = __testing;

const beat = (b: Partial<Beat>) => b as Beat;

describe("entityProtected — the planner's classification wins", () => {
  it("no longer protects a generic beat just because it has capitals", () => {
    // The defect. Capitals made this specific-looking, and it was never re-examined.
    expect(hasLikelyEntity("Steel Mill Workers 1940s")).toBe(true); // the old rule, still true
    expect(entityProtected(beat({ queryType: "generic" }), "Steel Mill Workers 1940s")).toBe(false);
  });

  it("protects an entity beat that happens to be lowercase", () => {
    expect(hasLikelyEntity("cummins p7100")).toBe(false); // the old rule missed this entirely
    expect(entityProtected(beat({ queryType: "entity" }), "cummins p7100")).toBe(true);
  });

  it("protects archival beats, whatever their query looks like", () => {
    // Thin stock pools by nature, and the worst possible trade: AI cannot produce archival
    // footage, only an imitation of it.
    expect(entityProtected(beat({ footageKind: "archival" }), "factory floor 1940s")).toBe(true);
    expect(entityProtected(beat({ footageKind: "archival", queryType: "generic" }), "factory floor")).toBe(true);
  });

  it("protects a named product shot", () => {
    expect(entityProtected(beat({ queryType: "generic", productLabel: "WD-40" }), "spray can on a bench")).toBe(true);
    // ...but an empty or whitespace label is not a product name.
    expect(entityProtected(beat({ queryType: "generic", productLabel: "  " }), "spray can on a bench")).toBe(false);
  });

  it("does not protect an abstract beat", () => {
    expect(entityProtected(beat({ queryType: "abstract" }), "the Nature of Progress")).toBe(false);
  });

  it("falls back to the text test only when the planner said nothing", () => {
    // Older plans and Gemini-503 chunks carry no classification; their behaviour is unchanged.
    expect(entityProtected(undefined, "Tide")).toBe(true);
    expect(entityProtected(undefined, "soap bubbles")).toBe(false);
    expect(entityProtected(beat({}), "Arm & Hammer")).toBe(true);
    expect(entityProtected(beat({ footageKind: "contemporary" }), "soap bubbles")).toBe(false);
  });
});

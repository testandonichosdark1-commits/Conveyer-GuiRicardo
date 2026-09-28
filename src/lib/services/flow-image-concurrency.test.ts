import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The concurrent-image-generation primitives (FLOW_IMAGE_CONCURRENCY > 1) — v2, after v1
 * (identify-by-data-media-id-while-holding-the-lock) was DISPROVEN by a real 7-beat run:
 * beat 1's and beat 2's images were shifted by one position. See the "Concurrent image
 * generation" section comment in flow-browser.ts and CLAUDE.md for the incident and the
 * live-DOM findings that produced this fix (Flow's `aria-label` is a content-derived
 * caption of a tile's OWN result, confirmed live: a prompt for a blue teacup on a wooden
 * table produced a tile captioned "Blue teacup on wooden table").
 *
 * A bug in any of these three pieces would either (a) silently misattribute one beat's
 * image to another — worse than the slow serial default this feature exists to speed up —
 * or (b) not actually bound concurrency, so each gets direct coverage.
 */
let concurrencySetting = "1";
vi.mock("../settings", () => ({ getSetting: (key: string) => (key === "FLOW_IMAGE_CONCURRENCY" ? concurrencySetting : "") }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { flowImageConcurrency, imageWaitLimit, currentFlowImageTiles, captionMatchScore, claimFlowTile } from "./flow-browser";

/** A fake `<flow-grid-tile-container>` — enough of the real DOM shape (querySelector +
 *  getAttribute) that the REAL evaluateAll callback in currentFlowImageTiles runs against
 *  it unmodified, rather than a mock that only pretends to. `mediaId: null` models a tile
 *  still rendering (no img[data-media-id] child yet). */
function fakeTileEl(mediaId: string | null, caption: string, src: string) {
  const img = mediaId ? { getAttribute: (n: string) => (n === "data-media-id" ? mediaId : null), currentSrc: src, src } : null;
  return {
    querySelector: (sel: string) => (sel.includes("data-media-id") ? img : null),
    getAttribute: (n: string) => (n === "aria-label" ? caption : null),
  };
}

function fakePageWithTiles(sequence: ReturnType<typeof fakeTileEl>[][]): import("playwright").Page {
  let call = 0;
  return {
    locator: () => ({
      evaluateAll: async (fn: (els: unknown[]) => unknown) => fn(sequence[Math.min(call++, sequence.length - 1)]),
    }),
    waitForTimeout: async () => {},
  } as unknown as import("playwright").Page;
}

describe("flowImageConcurrency", () => {
  beforeEach(() => { concurrencySetting = "1"; });

  it("defaults to 1 (the old fully-serial behavior)", () => {
    expect(flowImageConcurrency()).toBe(1);
  });

  it("reads an operator-raised value", () => {
    concurrencySetting = "4";
    expect(flowImageConcurrency()).toBe(4);
  });

  it("clamps above the 8 ceiling", () => {
    concurrencySetting = "50";
    expect(flowImageConcurrency()).toBe(8);
  });

  it("never goes below 1 — 0, blank and garbage all mean serial, never 'no limit'", () => {
    concurrencySetting = "0";
    expect(flowImageConcurrency()).toBe(1);
    concurrencySetting = "";
    expect(flowImageConcurrency()).toBe(1);
    concurrencySetting = "not-a-number";
    expect(flowImageConcurrency()).toBe(1);
    concurrencySetting = "-3";
    expect(flowImageConcurrency()).toBe(1);
  });
});

describe("currentFlowImageTiles", () => {
  it("returns only tiles that have BOTH a media id and a src — a still-rendering tile is invisible, not a false empty match", async () => {
    const page = fakePageWithTiles([[
      fakeTileEl("a", "Blue teacup on wooden table", "https://flow-content.google/image/a"),
      fakeTileEl(null, "", ""), // still rendering — no img[data-media-id] child yet
    ]]);
    await expect(currentFlowImageTiles(page)).resolves.toEqual([
      { mediaId: "a", caption: "Blue teacup on wooden table", src: "https://flow-content.google/image/a" },
    ]);
  });
});

describe("captionMatchScore", () => {
  it("scores a real confirmed live pair highly — 'Blue teacup on wooden table' against the prompt that produced it", () => {
    const prompt = "TESTE CORRELACAO 999 a bright blue teacup sitting on top of a dark wooden table, still photo";
    expect(captionMatchScore("Blue teacup on wooden table", prompt)).toBeGreaterThanOrEqual(0.6);
  });

  it("scores a DIFFERENT beat's caption low against this prompt — the actual bug this exists to prevent", () => {
    const prompt = "A close-up video of water droplets slowly dripping from the end of a white PVC pipe onto dry dirt ground";
    // The confirmed misattribution: beat 1's own prompt (above) vs. beat 0's caption (a
    // completely different scene) must NOT read as a match.
    expect(captionMatchScore("Hand pointing at air conditioner pipe", prompt)).toBeLessThan(0.6);
  });

  it("is 0 for an empty caption — never a false 'perfect match' on nothing", () => {
    expect(captionMatchScore("", "any prompt at all")).toBe(0);
  });

  it("ignores stopwords so a caption of only common words never inflates the score", () => {
    expect(captionMatchScore("the of and", "the quick brown fox")).toBe(0);
  });
});

describe("claimFlowTile", () => {
  it("claims an unclaimed id and then refuses a second claim of the same id", () => {
    const id = `test-${Math.random()}`;
    expect(claimFlowTile(id)).toBe(true);
    expect(claimFlowTile(id)).toBe(false);
  });

  it("two different ids can each be claimed independently", () => {
    const a = `test-a-${Math.random()}`;
    const b = `test-b-${Math.random()}`;
    expect(claimFlowTile(a)).toBe(true);
    expect(claimFlowTile(b)).toBe(true);
  });
});

describe("imageWaitLimit", () => {
  it("respects the configured concurrency ceiling — never more than N tasks active at once", async () => {
    concurrencySetting = "2";
    let active = 0;
    let maxActive = 0;
    const task = () => new Promise<void>((resolve) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => { active--; resolve(); }, 20);
    });
    await Promise.all([1, 2, 3, 4, 5].map(() => imageWaitLimit(task)));
    expect(maxActive).toBe(2);
  });

  it("falls back to a single lane when concurrency is 1 (the default)", async () => {
    concurrencySetting = "1";
    let active = 0;
    let maxActive = 0;
    const task = () => new Promise<void>((resolve) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => { active--; resolve(); }, 10);
    });
    await Promise.all([1, 2, 3].map(() => imageWaitLimit(task)));
    expect(maxActive).toBe(1);
  });
});

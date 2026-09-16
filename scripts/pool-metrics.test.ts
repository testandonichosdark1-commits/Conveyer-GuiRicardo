import { describe, it, expect, vi } from "vitest";

/**
 * pool-metrics — the off-line measurement harness for candidate selection.
 *
 * These tests pin the harness itself, not a defect: every stage that follows is graded by
 * the numbers this module produces, so a silent arithmetic change here would silently
 * re-grade the whole series. The fixture is hand-built with fully computable scores, and
 * each expectation below is a number that can be derived by hand from the weight tables.
 *
 * The three queries deliberately cover the three ways attempt 0 can end:
 *   A — a candidate clears the bars and is picked
 *   B — the poolIsWeak gate ends it before anything is scored (no vision call at all)
 *   C — a vision call happens and nothing clears the bars
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../src/lib/settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../src/lib/logger", () => ({ log: () => {} }));

import { measure, simulateQuery, type CapturedQuery } from "./pool-metrics";
import type { ProviderHit } from "../src/lib/services/visual-source";

/** hitLabel() reads the sourceUrl slug, so the slug IS the candidate's searchable text. */
function hit(kind: "video" | "image", id: string, slug: string, withThumb = true): ProviderHit {
  return {
    kind,
    url: `https://example.test/file/${id}.${kind === "video" ? "mp4" : "jpg"}`,
    dedupeId: id,
    sourceUrl: `https://example.test/page/${slug}`,
    ...(withThumb ? { thumbUrl: `https://example.test/thumb/${id}.jpg` } : {}),
  };
}

/** Matches on all three query tokens; the runner-up pixabay video blocks the Gemini bypass. */
const QUERY_A: CapturedQuery = {
  query: "colosseum aerial rome",
  lists: {
    pexels: [hit("video", "pexels:1", "colosseum-aerial-rome"), hit("video", "pexels:2", "kitchen-sink")],
    pixabay: [hit("video", "pixabay:1", "colosseum-rome")],
    wikimedia: [hit("image", "wikimedia:1", "Colosseum_rome.jpg")],
  },
};

/** Two low-tier stills, no video: heuristic max is 0, so poolIsWeak fires before scoring. */
const QUERY_B: CapturedQuery = {
  query: "underwater volcano eruption",
  lists: {
    wikimedia: [hit("image", "wikimedia:2", "Cat_photo.jpg")],
    openverse: [hit("image", "openverse:1", "dog-park")],
  },
};

/** Videos present, so the pool is NOT weak — it is scored, and nothing clears the bar. */
const QUERY_C: CapturedQuery = {
  query: "underwater volcano eruption",
  lists: {
    pexels: [hit("video", "pexels:3", "kitchen-sink")],
    pixabay: [hit("video", "pixabay:2", "garden-hose")],
  },
};

describe("pool-metrics — per-query simulation", () => {
  it("A: merges round-robin, scores, and picks the best by rankKey", () => {
    const o = simulateQuery(QUERY_A);
    // Round-robin over 3 providers: rank 0 of each (3), then pexels rank 1 (1) = 4.
    expect(o.poolSize).toBe(4);
    expect(o.scoredSize).toBe(4); // below MAX_GEMINI_CANDIDATES, so nothing is cut
    expect(o.scoredVideos).toBe(3);
    expect(o.geminiImages).toBe(4); // every candidate carries a thumbUrl
    expect(o.visionCalls).toBe(1);
    expect(o.bypassed).toBe(false); // pexels 9 vs pixabay 7 → margin 2 < 6
    expect(o.routedWeak).toBe(false);
    // pexels:1 matches all three tokens and wins on rankKey.
    expect(o.pickProvider).toBe("pexels");
    expect(o.pickKind).toBe("video");
  });

  it("B: the weak-pool gate ends the query before any vision call", () => {
    const o = simulateQuery(QUERY_B);
    expect(o.poolSize).toBe(2);
    expect(o.routedWeak).toBe(true);
    expect(o.pickProvider).toBeNull();
    // The point of the gate: nothing is scored, so nothing is billed.
    expect(o.visionCalls).toBe(0);
    expect(o.geminiImages).toBe(0);
    expect(o.scoredSize).toBe(0);
  });

  it("C: a scored pool where nothing clears the bars is a no-pass, not a weak route", () => {
    const o = simulateQuery(QUERY_C);
    expect(o.poolSize).toBe(2);
    expect(o.routedWeak).toBe(false); // a video is present → never weak
    expect(o.visionCalls).toBe(1);
    expect(o.geminiImages).toBe(2);
    expect(o.pickProvider).toBeNull();
  });

  it("takes a dominant Pexels video with no vision call at all", () => {
    const o = simulateQuery({
      query: "colosseum aerial rome",
      lists: { pexels: [hit("video", "pexels:9", "colosseum-aerial-rome")] },
    });
    expect(o.bypassed).toBe(true);
    expect(o.visionCalls).toBe(0);
    expect(o.geminiImages).toBe(0);
    expect(o.pickProvider).toBe("pexels");
  });

  it("caps each provider's contribution at SOURCE_POOL_PER_PROVIDER", () => {
    const many = Array.from({ length: 9 }, (_, i) => hit("video", `pexels:m${i}`, "kitchen-sink"));
    expect(simulateQuery({ query: "colosseum aerial rome", lists: { pexels: many } }).poolSize).toBe(5);
  });
});

describe("pool-metrics — summary", () => {
  it("aggregates exactly across the fixture", () => {
    const { metrics: m } = measure([QUERY_A, QUERY_B, QUERY_C]);
    expect(m.queries).toBe(3);
    expect(m.noPass).toBe(2); // B and C
    expect(m.routedWeak).toBe(1); // B only
    expect(m.bypassed).toBe(0);
    expect(m.visionCalls).toBe(2); // A and C
    expect(m.geminiImages).toBe(6); // 4 + 0 + 2
    expect(m.poolTotal).toBe(8); // 4 + 2 + 2
    expect(m.scoredVideoShare).toBeCloseTo(5 / 6, 6); // (3 + 0 + 2) of (4 + 0 + 2)
    expect(m.pickVideoShare).toBe(1); // the single pick is a video
    expect(m.pickVideos).toBe(1);
    expect(m.pickTotal).toBe(1);
    expect(m.providerMix).toEqual({ pexels: 1 });
  });

  it("reports zero shares rather than NaN when nothing is scored or picked", () => {
    const { metrics: m } = measure([QUERY_B]);
    expect(m.scoredVideoShare).toBe(0);
    expect(m.pickVideoShare).toBe(0);
    expect(m.providerMix).toEqual({});
  });
});

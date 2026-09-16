import { describe, it, expect, vi } from "vitest";

/**
 * The pre-Gemini cut, and the lexical signal that decides it alongside provenance.
 *
 * The defect these pin: when more than MAX_GEMINI_CANDIDATES candidates are gathered, the
 * cut used to rank on provider/kind/thumbnail ALONE. It never saw the scene or the query, so
 * an archive still that was exactly about the beat lost to an off-topic pexels clip by -4 vs
 * +4 before anything looked at either — which is why historical topics missed footage that
 * demonstrably existed in Wikimedia and Archive.
 *
 * The opposite failure is just as real and cheaper to cause by accident: let relevance
 * dominate and the cut goes to whichever candidate's FILENAME echoes the query, which
 * open-web sources win by SEO rather than by being right, trading video for stills. So the
 * numbers below are pinned, not just the orderings — LEX_WEIGHT must not drift silently.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { __testing, type ProviderHit } from "./visual-source";

const { prefilterCandidates, heuristicScore, fallbackSemanticScore, PREFILTER_PROVIDER_WEIGHT, MAX_GEMINI_CANDIDATES } =
  __testing;

const QUERY = "colosseum aerial rome";

/** hitLabel() reads the sourceUrl slug, so the slug IS the candidate's searchable text. */
function hit(provider: string, kind: "video" | "image", id: string, slug: string): ProviderHit {
  return {
    kind,
    provider,
    url: `https://e.test/f/${id}.${kind === "video" ? "mp4" : "jpg"}`,
    dedupeId: id,
    sourceUrl: `https://e.test/p/${slug}`,
    thumbUrl: `https://e.test/t/${id}.jpg`,
  };
}

/** Today's rule, kept here so "unchanged when nothing matches" is checked, not assumed. */
function heuristicOnlyCut(pool: ProviderHit[]): ProviderHit[] {
  return [...pool].sort((a, b) => heuristicScore(b) - heuristicScore(a)).slice(0, MAX_GEMINI_CANDIDATES);
}

describe("prefilterCandidates — relevance survives the cut", () => {
  it("keeps a matching archive still over eleven off-topic strong-provider clips", () => {
    // The one candidate that is actually about the scene is also the lowest-ranked provider
    // and the only still. Before the lexical term it was the single candidate dropped.
    const offTopic = [
      ...Array.from({ length: 6 }, (_, i) => hit("pexels", "video", `pexels:${i}`, "kitchen-sink-tap-water")),
      ...Array.from({ length: 4 }, (_, i) => hit("pixabay", "video", `pixabay:${i}`, "garden-hose-lawn")),
    ];
    const relevant = hit("archive", "image", "archive:1", "colosseum-aerial-rome");
    const pool = [...offTopic, relevant];

    expect(pool.length).toBeGreaterThan(MAX_GEMINI_CANDIDATES);
    expect(heuristicOnlyCut(pool)).not.toContain(relevant); // the defect, still reproducible
    expect(prefilterCandidates(pool, QUERY, "test", 0)).toContain(relevant);
  });

  it("does not let a PARTIAL match overturn a strong video", () => {
    // The guard against trading video for stills. A pexels video matching one query word
    // must still outrank an archive still matching all of them.
    const partialVideo = hit("pexels", "video", "pexels:p", "rome-street-traffic");
    const fullStill = hit("archive", "image", "archive:f", "colosseum-aerial-rome");
    const rank = (h: ProviderHit) => heuristicScore(h) + 0.1 * (fallbackSemanticScore(QUERY, h) - provVid(h));

    expect(rank(partialVideo)).toBeGreaterThan(rank(fullStill));
    // Pinned numerically: 9 + 0.1*33.3 = 12.3 vs -3 + 0.1*120 = 9.0. If LEX_WEIGHT moves,
    // this is the invariant that breaks first.
    expect(rank(partialVideo)).toBeCloseTo(12.33, 1);
    expect(rank(fullStill)).toBeCloseTo(9.0, 1);
  });

  it("is byte-identical to the old cut when nothing matches lexically", () => {
    // Every candidate takes the same -30 zero-overlap penalty, so the ordering — and the
    // kept set — must be exactly what provenance alone produced.
    const pool = [
      ...Array.from({ length: 6 }, (_, i) => hit("pexels", "video", `pexels:${i}`, "kitchen-sink")),
      ...Array.from({ length: 4 }, (_, i) => hit("wikimedia", "image", `wikimedia:${i}`, "garden-hose")),
      hit("archive", "image", "archive:1", "garden-hose"),
    ];
    const ids = (hits: ProviderHit[]) => hits.map((h) => h.dedupeId);
    expect(ids(prefilterCandidates(pool, QUERY, "test", 0))).toEqual(ids(heuristicOnlyCut(pool)));
  });

  it("returns the pool untouched at or below the candidate cap", () => {
    const pool = Array.from({ length: MAX_GEMINI_CANDIDATES }, (_, i) => hit("archive", "image", `a:${i}`, "kitchen-sink"));
    expect(prefilterCandidates(pool, QUERY, "test", 0)).toBe(pool); // same reference: no work done
  });
});

/** The provider/kind half that fallbackSemanticScore adds on top of the lexical half. */
function provVid(h: ProviderHit): number {
  return (PREFILTER_PROVIDER_WEIGHT[h.provider ?? ""] ?? 0) + (h.kind === "video" ? 4 : 0);
}

describe("fallbackSemanticScore — unchanged by the split", () => {
  // Golden values computed against the pre-split implementation. The lexical half was
  // extracted so the prefilter could weigh relevance without double-counting the provider
  // weight; the fallback scorer's own output must not have moved by so much as a point.
  const cases: [string, ProviderHit, number][] = [
    // full overlap (100) + bigram (20) + pexels video (8)
    ["exact match, pexels video", hit("pexels", "video", "p:1", "colosseum-aerial-rome"), 128],
    // 2/3 overlap (66.67) + leading token (20) + pixabay video (6)
    ["partial match, pixabay video", hit("pixabay", "video", "x:1", "colosseum-rome"), 92.67],
    // no overlap (0) - penalty (30) + pexels video (8)
    ["no overlap, pexels video", hit("pexels", "video", "p:2", "kitchen-sink"), -22],
    // no overlap (0) - penalty (30) + archive image (-4)
    ["no overlap, archive still", hit("archive", "image", "a:1", "kitchen-sink"), -34],
  ];

  for (const [name, h, expected] of cases) {
    it(name, () => expect(fallbackSemanticScore(QUERY, h)).toBeCloseTo(expected, 2));
  }

  it("falls back to provider/kind alone when the query has no usable tokens", () => {
    const h = hit("pexels", "video", "p:3", "kitchen-sink");
    expect(fallbackSemanticScore("the and of", h)).toBe(provVid(h)); // all stopwords → 8
  });
});

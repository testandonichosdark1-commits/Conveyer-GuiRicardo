import { describe, it, expect, vi } from "vitest";

/**
 * Provider ranking weights — the rule, not the instances.
 *
 * An unlisted provider does not rank last; it falls to `?? 0` and lands THIRD, above
 * wikimedia, openverse, web and archive, purely by omission. CLAUDE.md documents that trap
 * — it was written when wigolo was added — and storyblocks slipped past the same comment
 * anyway, which is the argument for a test rather than a comment: storyblocks is the only
 * PAID source here, so its position moves money as well as quality.
 *
 * So these tests pin the CLASS of defect. Whoever adds the next provider gets a red test
 * naming their provider, not a silent default that outranks five deliberate entries.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { __testing } from "./visual-source";

const { PROVIDER_WEIGHT, PREFILTER_PROVIDER_WEIGHT, PROVIDERS, heuristicScore, shouldBypassGemini } = __testing;

describe("provider weights", () => {
  it("gives every registered provider an explicit weight in both tables", () => {
    for (const name of Object.keys(PROVIDERS)) {
      expect(PROVIDER_WEIGHT, `${name} is missing from PROVIDER_WEIGHT`).toHaveProperty(name);
      expect(PREFILTER_PROVIDER_WEIGHT, `${name} is missing from PREFILTER_PROVIDER_WEIGHT`).toHaveProperty(name);
    }
  });

  it("keeps the two tables identical", () => {
    // The prefilter decides who Gemini SEES and rankKey decides who WINS. If they disagree,
    // a provider can be cut before scoring yet be documented as preferred after it — and
    // poolIsWeak, which reads the prefilter table, would grade a pool the ranking disowns.
    expect(PREFILTER_PROVIDER_WEIGHT).toEqual(PROVIDER_WEIGHT);
  });

  it("ranks storyblocks below pexels and above pixabay", () => {
    // Paid, video-only, professionally shot, always thumbnailed. It belongs in the top tier:
    // a free pexels video should still win a straight tie, but a reserved paid slot is
    // better spent on a graded clip than on a pixabay one.
    expect(PROVIDER_WEIGHT.storyblocks).toBeLessThan(PROVIDER_WEIGHT.pexels);
    expect(PROVIDER_WEIGHT.storyblocks).toBeGreaterThan(PROVIDER_WEIGHT.pixabay);
    expect(PROVIDER_WEIGHT.storyblocks).toBeGreaterThan(PROVIDER_WEIGHT.wikimedia);
  });

  it("does not let the storyblocks weight unblock the Gemini bypass", () => {
    // shouldBypassGemini accepts a pexels video with NO vision call when it leads by >= 6.
    // A storyblocks video in the pool must keep that gate shut, exactly as it did at the
    // accidental 0 — otherwise this change silently starts skipping quality checks.
    const vid = (provider: string, id: string) => ({
      kind: "video" as const,
      url: `https://e.test/${id}.mp4`,
      dedupeId: id,
      thumbUrl: `https://e.test/${id}.jpg`,
      provider,
    });
    const pool = [vid("pexels", "pexels:1"), vid("storyblocks", "storyblocks:1")];
    expect(heuristicScore(pool[0]) - heuristicScore(pool[1])).toBeLessThan(6);
    expect(shouldBypassGemini(pool)).toBeNull();
  });
});

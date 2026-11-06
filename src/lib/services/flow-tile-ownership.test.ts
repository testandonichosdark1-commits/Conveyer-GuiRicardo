import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Concurrent Flow images: a tile goes to the submitted prompt it matches BEST, not to the
 * first waiter whose prompt merely clears MIN_CAPTION_MATCH.
 *
 * Regression case (archive run d954871c, 2026-11-06): beat 3 asked for the Nineveh
 * excavation, beat 7 for a tablet close-up. With a visual world, both prompts carry the same
 * topic anchor and vocabulary, so beat 7's tablet tile also cleared 0.6 for beat 3 — beat 3
 * took it and beat 7 timed out. The prompts below are those beats' real ai_prompts, each
 * prefixed with the run's real topic anchor, as buildPrompt sends them.
 */
vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { captionMatchScore, tileBelongsToPrompt, __pendingFlowPromptsForTests as reg } from "./flow-browser";

const ANCHOR = "in a documentary about: George Smith, Nineveh flood tablet fragments, and Victorian Assyriology";
const BEAT3 =
  "1850s archival sepia photograph of the archaeological excavation site at Nineveh, dusty earthen trenches revealing ancient " +
  "Assyrian stone wall carvings and buried clay tablets, " + ANCHOR;
const BEAT7 =
  "Museum photography of an ancient Mesopotamian cuneiform clay tablet fragment, close-up view showing crisp wedge-shaped " +
  "script impressions, dark dramatic lighting, " + ANCHOR;
const TABLET_CAPTION = "Ancient cuneiform clay tablet fragment";
const DIG_CAPTION = "Archaeological excavation site at Nineveh";

beforeEach(() => reg.clear());

describe("tileBelongsToPrompt", () => {
  it("reproduces the incident: the tablet tile clears the bar for BOTH beats", () => {
    expect(captionMatchScore(TABLET_CAPTION, BEAT3)).toBeGreaterThanOrEqual(0.6);
    expect(captionMatchScore(TABLET_CAPTION, BEAT7)).toBeGreaterThan(captionMatchScore(TABLET_CAPTION, BEAT3));
  });

  it("gives the tablet tile to beat 7 and refuses it to beat 3, even though beat 3 was submitted first", () => {
    const s3 = reg.register(BEAT3);
    const s7 = reg.register(BEAT7);
    expect(tileBelongsToPrompt(TABLET_CAPTION, s3, reg.list())).toBe(false);
    expect(tileBelongsToPrompt(TABLET_CAPTION, s7, reg.list())).toBe(true);
    expect(tileBelongsToPrompt(DIG_CAPTION, s3, reg.list())).toBe(true);
    expect(tileBelongsToPrompt(DIG_CAPTION, s7, reg.list())).toBe(false);
  });

  it("alone, a prompt claims whatever clears the bar — the single-waiter behaviour is unchanged", () => {
    const s3 = reg.register(BEAT3);
    expect(tileBelongsToPrompt(TABLET_CAPTION, s3, reg.list())).toBe(true);
    expect(tileBelongsToPrompt("Red vintage bicycle against a wall", s3, reg.list())).toBe(false);
  });

  it("an exact tie goes to the earlier submission, so a tile is never left unclaimed by both", () => {
    const a = reg.register(BEAT7);
    const b = reg.register(BEAT7);
    expect(tileBelongsToPrompt(TABLET_CAPTION, a, reg.list())).toBe(true);
    expect(tileBelongsToPrompt(TABLET_CAPTION, b, reg.list())).toBe(false);
  });

  it("an ABANDONED prompt still competes for its late tile, so a similar later beat can't take the orphan", () => {
    const s7 = reg.register(BEAT7);
    reg.release(s7, false); // timed out before its tile resolved
    const s3 = reg.register(BEAT3);
    expect(tileBelongsToPrompt(TABLET_CAPTION, s3, reg.list())).toBe(false);
  });

  it("a prompt that CLAIMED leaves the registry and competes no more", () => {
    const s7 = reg.register(BEAT7);
    reg.release(s7, true);
    const s3 = reg.register(BEAT3);
    expect(tileBelongsToPrompt(TABLET_CAPTION, s3, reg.list())).toBe(true);
  });
});

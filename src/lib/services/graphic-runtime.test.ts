import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

/**
 * The pure half of src/graphics/runtime.js — the part that decides WHEN things appear.
 * It runs in the browser, but exports itself through module.exports so these rules can be
 * pinned without a browser: a cueWord enters on its word, everything else is spread over
 * the first 60% of the beat, and typed text follows the narration.
 */
const require = createRequire(import.meta.url);
const GR = require("../../graphics/runtime.js") as {
  normalizeWord(w: string): string;
  cueStart(cue: string, words: W[]): number | null;
  scheduleEntries(items: { cueWord?: string }[], words: W[], durationMs: number, opts?: { windowStartMs?: number; windowEndMs?: number }): number[];
  typingSchedule(tokens: string[], words: W[], durationMs: number): { startMs: number; endMs: number }[];
  highlightMask(tokens: string[], phrases: string[]): boolean[];
  odometerPositions(v: number, n: number): number[];
};
type W = { text: string; startMs: number; endMs: number };

const words: W[] = [
  { text: "The", startMs: 0, endMs: 200 },
  { text: "head", startMs: 250, endMs: 600 },
  { text: "twists,", startMs: 650, endMs: 1100 },
  { text: "and", startMs: 1200, endMs: 1350 },
  { text: "the", startMs: 1400, endMs: 1500 },
  { text: "Head", startMs: 1550, endMs: 1900 },
  { text: "focuses.", startMs: 2000, endMs: 2600 },
];

describe("cueStart", () => {
  it("returns the FIRST occurrence, ignoring case and punctuation", () => {
    expect(GR.cueStart("head", words)).toBe(250);
    expect(GR.cueStart("Twists", words)).toBe(650);
  });
  it("matches a multi-word phrase in order", () => {
    expect(GR.cueStart("the head", words)).toBe(0);
    expect(GR.cueStart("and the head", words)).toBe(1200);
    expect(GR.cueStart("head and", words)).toBeNull();
  });
  it("is null when the word is not spoken", () => {
    expect(GR.cueStart("lithium", words)).toBeNull();
    expect(GR.cueStart("", words)).toBeNull();
  });
});

describe("scheduleEntries", () => {
  it("spreads un-cued items uniformly over the first 60% of the beat", () => {
    expect(GR.scheduleEntries([{}, {}, {}], [], 10_000)).toEqual([0, 2000, 4000]);
  });
  it("puts a cued item on its word's start and leaves the rest in their slots", () => {
    expect(GR.scheduleEntries([{}, { cueWord: "focuses" }, {}], words, 10_000)).toEqual([0, 2000, 4000]);
    expect(GR.scheduleEntries([{ cueWord: "focuses" }, {}], words, 10_000)).toEqual([2000, 3000]);
  });
  it("falls back to the item's own slot when its cue is never said (never to t=0)", () => {
    expect(GR.scheduleEntries([{}, { cueWord: "lithium" }], words, 10_000)).toEqual([0, 3000]);
  });
  it("honours a custom window", () => {
    expect(GR.scheduleEntries([{}, {}], [], 10_000, { windowStartMs: 1000, windowEndMs: 3000 })).toEqual([1000, 2000]);
  });
});

describe("typingSchedule", () => {
  it("types each on-screen word while it is spoken", () => {
    const s = GR.typingSchedule(["HEAD", "TWISTS,"], words, 6000);
    expect(s[0]).toEqual({ startMs: 250, endMs: 600 });
    expect(s[1]).toEqual({ startMs: 650, endMs: 1100 });
  });
  it("interpolates tokens the narration does not say between their neighbours", () => {
    const s = GR.typingSchedule(["head", "REALLY", "twists"], words, 6000);
    expect(s[1].startMs).toBe(600);
    expect(s[1].endMs).toBe(650);
  });
  it("without any match, spreads typing over the first 60% and stays ordered", () => {
    const s = GR.typingSchedule(["ab", "cd"], [], 10_000);
    expect(s[0].startMs).toBe(0);
    expect(s[1].endMs).toBeLessThanOrEqual(6000);
    expect(s[1].startMs).toBeGreaterThan(s[0].startMs);
  });
  it("always finishes by 92% of the beat", () => {
    const late: W[] = [{ text: "late", startMs: 9800, endMs: 9990 }];
    const s = GR.typingSchedule(["late"], late, 10_000);
    expect(s[0].endMs).toBeLessThanOrEqual(9200);
  });
});

describe("odometerPositions", () => {
  it("lands exactly on the digits of an integer, leading zeros included", () => {
    expect(GR.odometerPositions(1234, 4)).toEqual([1, 2, 3, 4]);
    expect(GR.odometerPositions(39000000, 8)).toEqual([3, 9, 0, 0, 0, 0, 0, 0]);
    expect(GR.odometerPositions(42, 5)).toEqual([0, 0, 0, 4, 2]);
  });
  it("turns a higher column only while every column below passes 9→0", () => {
    const p = GR.odometerPositions(199.5, 3);
    expect(p[2]).toBeCloseTo(9.5); // units mid-roll
    expect(p[1]).toBeCloseTo(9.5); // tens carried along
    expect(p[0]).toBeCloseTo(1.5); // hundreds too
    const q = GR.odometerPositions(123.5, 3);
    expect(q).toEqual([1, 2, 3.5]); // units mid-roll, nothing to carry
  });
});

describe("highlightMask", () => {
  it("marks every token of a phrase, normalized", () => {
    expect(GR.highlightMask(["BUILT", "TO", "OUTLAST", "YOU."], ["outlast you"])).toEqual([false, false, true, true]);
  });
  it("does not mark a partial phrase", () => {
    expect(GR.highlightMask(["OUTLAST", "ME"], ["outlast you"])).toEqual([false, false]);
  });
});

import { describe, it, expect } from "vitest";
import { wordsForBeat, graphicBeatFrames } from "./graphic-beat";

describe("wordsForBeat", () => {
  it("keeps the words spoken inside the beat, timed from its start", () => {
    const words = [
      { word: "before", startMs: 900, endMs: 1100 },
      { word: "First", startMs: 2000, endMs: 2300 },
      { word: "second.", startMs: 2400, endMs: 2800 },
      { word: "after", startMs: 5000, endMs: 5200 },
    ];
    expect(wordsForBeat(words, 1500, 5000)).toEqual([
      { text: "First", startMs: 500, endMs: 800 },
      { text: "second.", startMs: 900, endMs: 1300 },
    ]);
  });
});

describe("graphicBeatFrames", () => {
  it("rounds exactly like the compositor, so consecutive beats tile with no lost frame", () => {
    // 0–1033 ms and 1033–2066 ms at 30 fps: 31 + 31 frames = round(2066*30/1000) = 62
    expect(graphicBeatFrames(0, 1033, 30) + graphicBeatFrames(1033, 2066, 30)).toBe(62);
    expect(graphicBeatFrames(1000, 1000, 30)).toBe(1);
  });
});

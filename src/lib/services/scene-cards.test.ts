import { describe, expect, it, vi } from "vitest";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { buildSceneCardFilter, cardFadeSec, type SceneCard } from "./overlay-renderer";

const card = (over: Partial<SceneCard> = {}): SceneCard => ({ pngPath: "/x/c.png", startSec: 1, endSec: 4, fadeIn: true, fadeOut: true, fadeSec: 0.4, x: 100, y: 200, ...over });

describe("buildSceneCardFilter", () => {
  it("draws one card over the base with a fade in and out", () => {
    const f = buildSceneCardFilter("[bs]", [card()], 1, "[v]");
    expect(f).toContain("[1:v]format=rgba,fade=t=in:st=1.000:d=0.400:alpha=1,fade=t=out:st=3.600:d=0.400:alpha=1[sc0]");
    expect(f).toContain("[bs][sc0]overlay=100:200:enable='between(t,1.000,4.000)'[v]");
  });

  it("a card that continues from the previous scene has no second fade-in, one that goes on has no fade-out", () => {
    const f = buildSceneCardFilter("[bs]", [card({ fadeIn: false, fadeOut: false })], 1, "[v]");
    expect(f).not.toContain("fade=");
  });

  it("chains several cards and numbers inputs from the first card input", () => {
    const f = buildSceneCardFilter("[xf]", [card(), card({ startSec: 5, endSec: 6 })], 2, "[v]");
    expect(f).toContain("[2:v]format=rgba");
    expect(f).toContain("[3:v]format=rgba");
    expect(f).toContain("[xf][sc0]overlay=100:200:enable='between(t,1.000,4.000)'[sb0]");
    expect(f).toContain("[sb0][sc1]overlay=100:200:enable='between(t,5.000,6.000)'[v]");
  });

  it("fade length never exceeds half the card's life", () => {
    expect(cardFadeSec(0, 0.2)).toBeLessThanOrEqual(0.1);
  });
});

import { normalizeFallbackQuery } from "./studio-plan";

describe("normalizeFallbackQuery", () => {
  it("keeps a real place/map search that differs from the main query", () => {
    expect(normalizeFallbackQuery(" Kamaing Burma 1944 jungle town aerial ", "Mike Calvert British brigadier Burma 1944 portrait")).toBe("Kamaing Burma 1944 jungle town aerial");
  });
  it("drops empty, one-word, over-long and echoed values", () => {
    expect(normalizeFallbackQuery("", "x y")).toBeUndefined();
    expect(normalizeFallbackQuery("Burma", "x y")).toBeUndefined();
    expect(normalizeFallbackQuery("a b c d e f g h i j", "x y")).toBeUndefined();
    expect(normalizeFallbackQuery("Mike Calvert portrait", "mike calvert PORTRAIT")).toBeUndefined();
    expect(normalizeFallbackQuery(42, "x y")).toBeUndefined();
  });
});

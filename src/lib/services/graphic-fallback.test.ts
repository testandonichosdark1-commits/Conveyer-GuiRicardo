import { describe, it, expect } from "vitest";
import { pickLine, pickHighlights, textGraphicFor } from "./graphic-fallback";

// The real beat that repeated a neighbour's shot in the first graphics run.
const REAL = "I carried one on my belt in that little black holster for most of my 20s, and so did half the guys I worked with.";

describe("pickLine", () => {
  it("prefers a short sentence with a number or a name, copied verbatim", () => {
    expect(pickLine("It was cheap. By 1989, Maglite had a quarter of the market.")).toBe("By 1989, Maglite had a quarter of the market.");
  });
  it("never opens on a conjunction; a too-long line is cut back to a content word", () => {
    // first clause is 16 words, the second opens with "and" → the head, ending on "holster"
    expect(pickLine(REAL)).toBe("I carried one on my belt in that little black holster…");
  });
  it("is null for empty text", () => {
    expect(pickLine("   ")).toBeNull();
  });
});

describe("pickHighlights", () => {
  it("golds numbers and names, else the last two words", () => {
    expect(pickHighlights("By 1989, Maglite had a quarter of the market.")).toEqual(["1989", "Maglite"]);
    expect(pickHighlights("it hasn't mattered in years")).toEqual(["in years"]);
  });
});

describe("textGraphicFor", () => {
  it("makes a valid kinetic_quote by default", () => {
    const g = textGraphicFor(REAL, [undefined, undefined], "arden");
    expect(g?.template).toBe("kinetic_quote");
    expect(g?.theme).toBe("arden");
    expect((g?.data as { highlight: string[] }).highlight).toEqual(["black holster"]);
  });
  it("switches to impact_bars next to a kinetic_quote, gold on the highlighted line", () => {
    const g = textGraphicFor("By 1989, Maglite had a quarter of the market.", ["kinetic_quote", undefined]);
    expect(g?.template).toBe("impact_bars");
    const lines = (g?.data as { lines: { text: string; gold?: boolean }[] }).lines;
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.find((l) => l.gold)?.text).toMatch(/1989/);
  });
});

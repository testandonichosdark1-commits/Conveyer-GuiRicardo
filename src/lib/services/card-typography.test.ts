import { describe, it, expect } from "vitest";
import { buildCardSvg, titleCaseForDisplay, fitTitle, estimateTextWidth } from "./overlay-renderer";
import { PRESTIGE_THEME, DOCUMENTARY_THEME, OVERLAY_THEMES } from "./overlay-themes";
import type { Overlay } from "./studio-plan";

/**
 * Typography regressions found by watching a finished Biltmore video (run d53987a5), all three
 * visible on screen and all three reproduced from the code before being fixed.
 */

const HD = { w: 1920, h: 1080 };
const card = (o: Partial<Overlay>): Overlay => ({ type: "date", title: "1638", ...o });
const titleOf = (svg: string) => svg.match(/<text[^>]*>([^<]*)<\/text>/)?.[1] ?? "";
const titleSizeOf = (svg: string) => Number(svg.match(/font-size="(\d+)"/)?.[1] ?? 0);

describe("item 1 — lining figures, because numerals ARE the card", () => {
  it("no shipped theme asks for a face that defaults to old-style figures", () => {
    // Georgia sets 3 4 5 7 9 below the baseline and 0 1 2 at x-height. Against titleUppercase
    // that produced "4 ACRES" with a small low 4 and "CHRISTMAS 1895" with the 9 and 5 falling
    // through the line. A year stamp is the largest thing on a prestige card — the figure style
    // outranks the face.
    for (const [key, theme] of Object.entries(OVERLAY_THEMES)) {
      expect(theme.fontFamily, key).not.toMatch(/Georgia/i);
    }
  });

  it("the prestige card is still a serif, and the documentary card still a sans", () => {
    expect(PRESTIGE_THEME.fontFamily).toMatch(/serif/);
    expect(PRESTIGE_THEME.fontFamily).not.toMatch(/sans-serif/);
    expect(DOCUMENTARY_THEME.fontFamily).toMatch(/sans-serif/);
  });
});

describe("item 2 — a decade keeps its lowercase suffix", () => {
  it("uppercases the words but not the s in 1930s", () => {
    expect(titleCaseForDisplay("1930s")).toBe("1930s");
    expect(titleCaseForDisplay("the 1890s")).toBe("THE 1890s");
    expect(titleCaseForDisplay("1930s and 1940s")).toBe("1930s AND 1940s");
  });

  it("leaves ordinals alone — 19TH CENTURY is correct in caps", () => {
    expect(titleCaseForDisplay("19th century")).toBe("19TH CENTURY");
  });

  it("does not touch an ordinary word-initial or word-internal S", () => {
    expect(titleCaseForDisplay("Asheville")).toBe("ASHEVILLE");
    expect(titleCaseForDisplay("Estates")).toBe("ESTATES");
    expect(titleCaseForDisplay("Below Stairs")).toBe("BELOW STAIRS");
  });

  it("renders through to the card", () => {
    expect(titleOf(buildCardSvg(card({ title: "1930s" }), HD, PRESTIGE_THEME).svg)).toBe("1930s");
  });
});

describe("item 3 — shrink before cutting", () => {
  // The real budget a 1080p prestige card has for its title: maxWidthFrac 0.7 minus the padding.
  const MAX = 1270;

  it("leaves a title that already fits completely alone", () => {
    const r = fitTitle("1895", 78, MAX, 9);
    expect(r).toEqual({ text: "1895", fontSize: 78, tracking: 9 });
  });

  it("reduces the size instead of truncating", () => {
    const r = fitTitle("ASHEVILLE, NORTH CAROLINA", 78, MAX, 9);
    expect(r.text).toBe("ASHEVILLE, NORTH CAROLINA"); // intact
    expect(r.fontSize).toBeLessThan(78);
  });

  it("shrinks the tracking with the size — otherwise the saving is given back", () => {
    const r = fitTitle("ASHEVILLE, NORTH CAROLINA", 78, MAX, 9);
    expect(r.tracking).toBeLessThanOrEqual(9);
  });

  it("still truncates when even the floor size cannot fit — but only then", () => {
    const r = fitTitle("A".repeat(200), 78, MAX, 9);
    expect(r.text).toMatch(/…$/);
    expect(r.fontSize).toBe(Math.round(78 * 0.72));
  });

  it("never shrinks below the floor", () => {
    expect(fitTitle("A".repeat(200), 78, 10, 9).fontSize).toBe(Math.round(78 * 0.72));
  });

  it("the real card that was cut on screen now survives whole", () => {
    // This is the exact defect: "ASHEVILLE, NORTH CAROL…", a place name severed mid-word.
    const svg = buildCardSvg(
      card({ type: "title", title: "Asheville, North Carolina", subtitle: "The Blue Ridge mountain estate" }),
      HD,
      PRESTIGE_THEME,
    ).svg;
    expect(titleOf(svg)).toBe("ASHEVILLE, NORTH CAROLINA");
    expect(titleOf(svg)).not.toContain("…");
  });

  it("a short title keeps the full display size — shrinking is not applied indiscriminately", () => {
    const big = buildCardSvg(card({ title: "1895" }), HD, PRESTIGE_THEME).svg;
    const long = buildCardSvg(card({ title: "Asheville, North Carolina" }), HD, PRESTIGE_THEME).svg;
    expect(titleSizeOf(big)).toBeGreaterThan(titleSizeOf(long));
    expect(titleSizeOf(big)).toBe(Math.round(HD.h * PRESTIGE_THEME.titleFontFrac));
  });
});

describe("the card box still contains its own text", () => {
  it("keeps padding around an all-caps title at every shipped theme", () => {
    // The old flat 0.58-em estimate under-measured capitals, so the box was built narrower than
    // the text it held and the letters bled to the card edge.
    for (const [key, theme] of Object.entries(OVERLAY_THEMES)) {
      for (const t of ["Asheville, North Carolina", "10,000 Volumes", "Edith Vanderbilt", "1930s"]) {
        const { svg, geo } = buildCardSvg(card({ title: t, subtitle: "a supporting line" }), HD, theme);
        const size = titleSizeOf(svg);
        const text = titleOf(svg);
        const tracking = Number(svg.match(/letter-spacing="(\d+)"/)?.[1] ?? 0);
        // The SAME estimator the layout uses — the assertion is that the box was sized from the
        // same number that positions the glyphs, and still has room for the theme's padding.
        const needed = estimateTextWidth(text, size, tracking);
        const cap = Math.round(HD.w * theme.maxWidthFrac);
        expect(geo.w, `${key}/${t}`).toBeGreaterThanOrEqual(Math.min(needed + 2 * 20, cap));
        expect(geo.x + geo.w, `${key}/${t}`).toBeLessThanOrEqual(HD.w);
      }
    }
  });
});

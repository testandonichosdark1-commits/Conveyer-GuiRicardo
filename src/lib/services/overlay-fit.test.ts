import { describe, it, expect } from "vitest";
import { buildCardSvg, buildFittedCard, measuredTextWidth } from "./overlay-renderer";
import { DOCUMENTARY_THEME, PRESTIGE_THEME } from "./overlay-themes";
import type { Overlay } from "./studio-plan";
import type { OverlayTheme } from "./overlay-themes";

/**
 * The card is sized from an ESTIMATE of its text width, and the estimate cannot know how wide
 * the host's font engine really draws the glyphs: the family is a fontconfig chain resolved on
 * the machine, and the documentary title is weight 800 while the estimator has no notion of
 * weight. Measured, it runs 9–16% low — enough to build a card narrower than its own title and
 * let the SVG viewport cut the tail off. A client reported exactly that: "Venomous Primat".
 *
 * These tests RASTERISE. That is the point — every pure test of this module passes on the
 * broken version, because the arithmetic was self-consistent; only real glyphs disagree.
 */

const DIM = { w: 1920, h: 1080 };

const CASES: Array<{ label: string; overlay: Overlay }> = [
  // The first two are the client's own cards, verbatim.
  { label: "client: Venomous Primate", overlay: { type: "fact", title: "Venomous Primate", subtitle: "The only venomous primate on Earth" } },
  { label: "client: Rabies", overlay: { type: "fact", title: "30% of Rabies Cases", subtitle: "Recorded in North American wildlife" } },
  { label: "short", overlay: { type: "fact", title: "Slow Loris", subtitle: "Nycticebus" } },
  { label: "long title", overlay: { type: "fact", title: "Asheville, North Carolina", subtitle: "A mountain town in the Blue Ridge" } },
  { label: "all caps", overlay: { type: "fact", title: "WORLD WILDLIFE FUND", subtitle: "Founded 1961" } },
  { label: "widest glyphs", overlay: { type: "fact", title: "Mammal Wilderness", subtitle: "Wide glyphs everywhere in this line" } },
  { label: "absurdly long", overlay: { type: "fact", title: "The Extraordinarily Wide Mammalian Wilderness Commission", subtitle: "And a subtitle that also refuses to be short about anything at all" } },
];

/** Space the card set aside for text: its width less the accent bar and both paddings. */
function reservedTextWidth(geo: { w: number }, theme: OverlayTheme): number {
  const pad = Math.max(theme.padMin, Math.round(DIM.h * theme.padFrac));
  const accentW =
    theme.accentFrac <= 0 && theme.accentMin <= 0 ? 0 : Math.max(theme.accentMin, Math.round(DIM.h * theme.accentFrac));
  return geo.w - accentW - 2 * pad;
}

for (const theme of [DOCUMENTARY_THEME, PRESTIGE_THEME]) {
  describe(`${theme.key} card`, () => {
    for (const c of CASES) {
      it(`fits its real glyphs — ${c.label}`, async () => {
        const build = await buildFittedCard(c.overlay, DIM, theme);
        const real = await measuredTextWidth(build);
        expect(real).not.toBeNull();
        expect(real!).toBeLessThanOrEqual(reservedTextWidth(build.geo, theme));
      });
    }

    it("never exceeds the theme's maximum card width", async () => {
      // Widening to fit must not be allowed to push the card past its design limit.
      const max = Math.round(DIM.w * theme.maxWidthFrac);
      for (const c of CASES) {
        const build = await buildFittedCard(c.overlay, DIM, theme);
        expect(build.geo.w).toBeLessThanOrEqual(max);
      }
    });
  });
}

describe("the estimate on its own", () => {
  it("is too narrow for bold type, which is why the fit is measured", async () => {
    // Guards the reason this exists: if the estimator ever becomes accurate, this fails and
    // whoever sees it can decide the measuring pass is no longer earning its keep.
    const overlay: Overlay = { type: "fact", title: "Mammal Wilderness", subtitle: "Wide glyphs everywhere in this line" };
    const estimated = buildCardSvg(overlay, DIM, DOCUMENTARY_THEME);
    const real = await measuredTextWidth(estimated);
    expect(real!).toBeGreaterThan(reservedTextWidth(estimated.geo, DOCUMENTARY_THEME));
  });

  it("is left alone when the caller does not ask for a correction", () => {
    // buildCardSvg stays pure and unchanged at scale 1 — every existing unit test still applies.
    const overlay: Overlay = { type: "fact", title: "Slow Loris", subtitle: "Nycticebus" };
    expect(buildCardSvg(overlay, DIM, DOCUMENTARY_THEME).svg).toBe(
      buildCardSvg(overlay, DIM, DOCUMENTARY_THEME, 1).svg
    );
  });
});

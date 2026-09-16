import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildOverlayFilter, renderOverlayCard, buildOverlayPlan, buildCardSvg, themeForOverlay, DEFAULT_OVERLAY_THEME } from "./overlay-renderer";
import type { OverlayTheme } from "./overlay-renderer";
import { PRESTIGE_THEME } from "./overlay-themes";
import type { Beat, Overlay } from "./studio-plan";

// Silence the pipeline logger (DB-backed) — these are hermetic unit tests.
import { vi } from "vitest";
vi.mock("../logger", () => ({ log: () => {} }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-test-"));
afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const DIM = { w: 1920, h: 1080 };

/** Minimal beat carrying just the fields the renderer reads. */
function beat(index: number, startMs: number, endMs: number, overlay?: Overlay): Beat {
  return {
    index, startMs, endMs, text: "x", layout: "broll", visualQuery: "x", source: "ai",
    ...(overlay ? { overlay } : {}),
  } as Beat;
}

describe("buildOverlayFilter (pure filtergraph)", () => {
  it("returns empty string for no cards", () => {
    expect(buildOverlayFilter([])).toBe("");
  });

  it("chains a single card off the base video into [vout]", () => {
    const f = buildOverlayFilter([{ startSec: 5.2, endSec: 8.4, x: 100, y: 900 }]);
    expect(f).toContain("[1:v]format=rgba");
    expect(f).toContain("fade=t=in:st=5.200");
    expect(f).toContain("fade=t=out:");
    expect(f).toContain("[0:v][ov0]overlay=100:900:enable='between(t,5.200,8.400)'[vout]");
    // A single card must terminate directly in [vout], with no intermediate base pad.
    expect(f).not.toContain("[base0]");
  });

  it("threads multiple cards through intermediate pads, last into [vout]", () => {
    const f = buildOverlayFilter([
      { startSec: 1, endSec: 3, x: 10, y: 20 },
      { startSec: 4, endSec: 6, x: 10, y: 20 },
    ]);
    expect(f).toContain("[0:v][ov0]overlay=10:20:enable='between(t,1.000,3.000)'[base0]");
    expect(f).toContain("[base0][ov1]overlay=10:20:enable='between(t,4.000,6.000)'[vout]");
    expect(f).toContain("[2:v]format=rgba"); // second card is ffmpeg input 2
  });

  it("makes the fade PROPORTIONAL to lifetime, within limits (short snaps, long eases)", () => {
    const dur = (f: string) => Number(f.match(/fade=t=in:st=[\d.]+:d=([\d.]+)/)![1]);
    const short = dur(buildOverlayFilter([{ startSec: 0, endSec: 2, x: 0, y: 0 }])); // 2s → 0.15·2 = 0.30
    const long = dur(buildOverlayFilter([{ startSec: 0, endSec: 10, x: 0, y: 0 }])); // 10s → 1.5, capped 0.60
    expect(short).toBeCloseTo(0.3, 3);
    expect(long).toBeCloseTo(0.6, 3);
    expect(long).toBeGreaterThan(short); // longer overlays fade more smoothly
  });

  it("never lets the two fades exceed the window (both fit within a tiny card)", () => {
    const f = buildOverlayFilter([{ startSec: 0, endSec: 0.3, x: 0, y: 0 }]);
    // fade is capped at dur/2 so fade-in + fade-out always fit.
    const d = Number(f.match(/fade=t=in:st=[\d.]+:d=([\d.]+)/)![1]);
    expect(d).toBeLessThanOrEqual(0.15 + 1e-9);
  });
});

describe("buildCardSvg (documentary template — Stage 1 polish)", () => {
  it("renders a bold, shadowed title and (when present) a subtitle", () => {
    const { svg } = buildCardSvg({ type: "person", title: "Tesla", subtitle: "Inventor" }, DIM);
    expect(svg).toContain('font-weight="800"'); // bolder title
    expect(svg).toContain("paint-order"); // stroke thickens the glyphs
    expect(svg).toContain("fill-opacity=\"0.55\""); // the subtle drop shadow
    // Two title <text> (shadow + fill) and two subtitle <text> (shadow + fill).
    expect((svg.match(/>Tesla</g) || []).length).toBe(2);
    expect((svg.match(/>Inventor</g) || []).length).toBe(2);
  });

  it("omits subtitle elements when there is no subtitle", () => {
    const { svg } = buildCardSvg({ type: "date", title: "1969" }, DIM);
    expect((svg.match(/>1969</g) || []).length).toBe(2); // title shadow + fill only
    expect(svg).toContain("#FFC400"); // yellow accent bar present
  });

  it("has larger padding/subtitle than the frame-fraction floor (grows with height)", () => {
    const small = buildCardSvg({ type: "date", title: "1969", subtitle: "x" }, { w: 640, h: 360 });
    const big = buildCardSvg({ type: "date", title: "1969", subtitle: "x" }, { w: 3840, h: 2160 });
    expect(big.geo.h).toBeGreaterThan(small.geo.h * 4); // sizing scales off height
  });

  it("truncates an over-long TITLE to one line with an ellipsis", () => {
    const longTitle = "The Extraordinarily Long Name Of A Person That Cannot Possibly Fit On One Card Line At All";
    const { svg } = buildCardSvg({ type: "person", title: longTitle }, DIM);
    expect(svg).toContain("…");
    // Title stays a single line (one shadow + one fill copy of the SAME truncated string).
    const fills = svg.match(/fill="#FFFFFF"/g) || [];
    expect(fills.length).toBe(1);
  });

  it("WRAPS a long subtitle to at most theme.subtitleMaxLines and never overflows", () => {
    const longSub = "The Great Wall of China stretches over twenty one thousand kilometers across deserts, mountains and grasslands of the vast northern frontier region beyond the capital, a continuous rampart begun more than two thousand years ago and rebuilt many times across successive imperial dynasties";
    const { svg, geo } = buildCardSvg({ type: "section", title: "#10", subtitle: longSub }, DIM);
    // One fill copy per wrapped subtitle line; capped at the theme max (2).
    const subFills = svg.match(/fill="#ECECEC"/g) || [];
    expect(subFills.length).toBeGreaterThanOrEqual(1);
    expect(subFills.length).toBeLessThanOrEqual(DEFAULT_OVERLAY_THEME.subtitleMaxLines);
    expect(svg).toContain("…"); // ran past the cap → ellipsized, not clipped
    // Card never exceeds the theme's max width.
    expect(geo.w).toBeLessThanOrEqual(Math.round(DIM.w * DEFAULT_OVERLAY_THEME.maxWidthFrac));
    // A multi-line subtitle makes the card taller than a single-line one.
    const single = buildCardSvg({ type: "section", title: "#10", subtitle: "Short" }, DIM);
    expect(geo.h).toBeGreaterThan(single.geo.h);
  });
});

describe("theme selection by overlay type (bigger number/section cards)", () => {
  it("routes section + date cards to the large centred serif PRESTIGE theme", () => {
    expect(themeForOverlay({ type: "section", title: "The Mask" }).key).toBe("prestige");
    expect(themeForOverlay({ type: "date", title: "1969" }).key).toBe("prestige");
  });

  it("keeps person/fact/quote/title lower-thirds on the documentary theme", () => {
    for (const type of ["person", "fact", "quote", "title"] as const) {
      expect(themeForOverlay({ type, title: "x" }).key).toBe("documentary");
    }
  });

  it("PRESTIGE uses lining-figure serif (NO Georgia), uppercased, at the larger title size", () => {
    // Georgia's old-style figures are the exact cause of the small/off-baseline countdown '10'.
    expect(PRESTIGE_THEME.fontFamily).not.toMatch(/georgia/i);
    expect(PRESTIGE_THEME.fontFamily).toMatch(/serif/i);
    expect(PRESTIGE_THEME.titleUppercase).toBe(true);
    expect(PRESTIGE_THEME.titleFontFrac).toBeGreaterThan(DEFAULT_OVERLAY_THEME.titleFontFrac);
    // A two-digit rank renders centred on the prestige card.
    const { svg } = buildCardSvg({ type: "section", title: "#10" }, DIM, PRESTIGE_THEME);
    expect(svg).toContain('text-anchor="middle"');
    expect((svg.match(/>#10</g) || []).length).toBe(2); // shadow + fill, not dropped
  });

  it("made the general documentary title noticeably bigger than the original 0.048", () => {
    expect(DEFAULT_OVERLAY_THEME.titleFontFrac).toBeGreaterThanOrEqual(0.06);
  });
});

describe("OverlayTheme (appearance is data, not hardcoded)", () => {
  it("the default theme drives the documentary look", () => {
    const { svg } = buildCardSvg({ type: "date", title: "1969" }, DIM);
    expect(svg).toContain(`fill="${DEFAULT_OVERLAY_THEME.accentColor}"`); // #FFC400
    expect(svg).toContain(`font-weight="${DEFAULT_OVERLAY_THEME.titleWeight}"`); // 800
  });

  it("a custom theme changes appearance WITHOUT touching the renderer", () => {
    const theme: OverlayTheme = { ...DEFAULT_OVERLAY_THEME, accentColor: "#12AB34", cardColor: "#223344", subtitleMaxLines: 1 };
    const { svg } = buildCardSvg({ type: "section", title: "#1", subtitle: "a very long subtitle that would wrap to two lines under the default theme but must stay one" }, DIM, theme);
    expect(svg).toContain("#12AB34"); // custom accent
    expect(svg).toContain("#223344"); // custom card colour
    expect(svg).not.toContain("#FFC400"); // default accent gone
    const subFills = svg.match(/fill="#ECECEC"/g) || [];
    expect(subFills.length).toBe(1); // subtitleMaxLines:1 honored
  });
});

describe("renderOverlayCard (sharp rasterization)", () => {
  it("writes a transparent PNG with the card drawn (non-empty alpha)", async () => {
    const png = path.join(tmp, "card.png");
    const geo = await renderOverlayCard({ type: "date", title: "1969" }, DIM, png);
    expect(fs.existsSync(png)).toBe(true);
    expect(geo.w).toBeGreaterThan(0);
    expect(geo.h).toBeGreaterThan(0);
    // Lower-third placement: the card sits in the bottom half, inset from the left edge.
    expect(geo.x).toBeGreaterThan(0);
    expect(geo.y).toBeGreaterThan(DIM.h / 2);

    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 10) painted++;
    expect(painted).toBeGreaterThan(0); // the card box + title actually rendered
  });

  it("escapes XML-hostile characters in the title without throwing", async () => {
    const png = path.join(tmp, "escaped.png");
    await expect(
      renderOverlayCard({ type: "quote", title: `A & B < C > "D" 'E'` }, DIM, png)
    ).resolves.toBeTruthy();
    expect(fs.existsSync(png)).toBe(true);
  });

  it("scales geometry off the frame HEIGHT so portrait works the same way", async () => {
    const land = await renderOverlayCard({ type: "date", title: "1969" }, { w: 1920, h: 1080 }, path.join(tmp, "l.png"));
    const port = await renderOverlayCard({ type: "date", title: "1969" }, { w: 1080, h: 1920 }, path.join(tmp, "p.png"));
    // Both produce a valid card in the lower third of their own frame.
    expect(port.y).toBeGreaterThan(1920 / 2);
    expect(land.y).toBeGreaterThan(1080 / 2);
  });
});

describe("buildOverlayPlan (gating + fail-open)", () => {
  it("returns null when no beat carries an overlay", async () => {
    const plan = await buildOverlayPlan([beat(0, 0, 2000), beat(1, 2000, 4000)], DIM, path.join(tmp, "none"), "run");
    expect(plan).toBeNull();
  });

  it("renders one card per overlay beat and returns inputs aligned to the filter", async () => {
    const beats = [
      beat(0, 0, 2000),
      beat(1, 2000, 5000, { type: "person", title: "Nikola Tesla" }),
      beat(2, 5000, 8000),
      beat(3, 8000, 11000, { type: "date", title: "1943" }),
    ];
    const dir = path.join(tmp, "plan");
    const plan = await buildOverlayPlan(beats, DIM, dir, "run");
    expect(plan).not.toBeNull();
    expect(plan!.inputs).toHaveLength(2); // only the two overlay beats
    expect(plan!.inputs.every((p) => fs.existsSync(p))).toBe(true);
    // Windows derive from beat timing, in beat order.
    expect(plan!.filter).toContain("enable='between(t,2.000,5.000)'");
    expect(plan!.filter).toContain("enable='between(t,8.000,11.000)'");
    expect(plan!.filter).toContain("[vout]");
  });

  it("skips a beat whose overlay has an empty title (no card, no crash)", async () => {
    const beats = [beat(0, 0, 2000, { type: "date", title: "" } as Overlay)];
    const plan = await buildOverlayPlan(beats, DIM, path.join(tmp, "empty"), "run");
    expect(plan).toBeNull();
  });

  it("uses the narration SCHEDULE (overlayStartMs/EndMs) over the beat window when present", async () => {
    // Beat spans 10s→35s, but the card is scheduled at the spoken cue 22.0s–24.5s.
    const scheduled = { ...beat(1, 10000, 35000, { type: "section", title: "#5" }), overlayStartMs: 22000, overlayEndMs: 24500 } as Beat;
    const plan = await buildOverlayPlan([scheduled], DIM, path.join(tmp, "sched"), "run");
    expect(plan!.filter).toContain("enable='between(t,22.000,24.500)'"); // the schedule, not 10→35
    expect(plan!.filter).not.toContain("between(t,10.000,35.000)");
  });

  it("falls back to the beat window when no schedule is present (backward compatible)", async () => {
    const plan = await buildOverlayPlan([beat(1, 2000, 5000, { type: "date", title: "1969" })], DIM, path.join(tmp, "fallback"), "run");
    expect(plan!.filter).toContain("enable='between(t,2.000,5.000)'");
  });

  it("Stage 2: renders BOTH the establishing card and the scheduled supporting card, time-separated", async () => {
    const dir = path.join(tmp, "support");
    const b = {
      ...beat(1, 3000, 30000, { type: "section", title: "#5", subtitle: "The Great Wall" }),
      overlayStartMs: 5000, overlayEndMs: 7500,
      supporting: { type: "fact", title: "21,000 km long" } as Overlay,
      supportingStartMs: 9000, supportingEndMs: 11500,
    } as Beat;
    const plan = await buildOverlayPlan([b], DIM, dir, "run");
    expect(plan!.inputs.length).toBe(2); // establishing + supporting
    expect(plan!.inputs.some((p) => /overlay_0001\.png$/.test(p))).toBe(true);
    expect(plan!.inputs.some((p) => /support_0001\.png$/.test(p))).toBe(true);
    expect(plan!.filter).toContain("enable='between(t,5.000,7.500)'");   // establishing window
    expect(plan!.filter).toContain("enable='between(t,9.000,11.500)'");  // supporting window (after a gap)
  });

  it("Stage 2: renders no supporting card when its window was never scheduled (fail-open)", async () => {
    const b = {
      ...beat(1, 3000, 30000, { type: "section", title: "#5", subtitle: "The Great Wall" }),
      overlayStartMs: 5000, overlayEndMs: 7500,
      supporting: { type: "fact", title: "21,000 km long" } as Overlay,
      // supportingStartMs/EndMs intentionally absent → the supporting card is skipped
    } as Beat;
    const plan = await buildOverlayPlan([b], DIM, path.join(tmp, "support-skip"), "run");
    expect(plan!.inputs.length).toBe(1); // establishing only
  });
});

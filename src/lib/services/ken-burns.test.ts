import { describe, it, expect } from "vitest";
import { kenBurnsFilter, parseResolution } from "./ken-burns";

/**
 * These pin the ONE property that silently broke every non-16:9 still for months:
 * `zoompan`'s `s=WxH` stretches its window into that size — it does not letterbox and
 * does not crop. So the frame must already be at the output aspect before zoompan sees
 * it. Measured on a 2:3 portrait photo, the missing crop squashed it by 2.667x; a circle
 * came out an ellipse. Nothing about the output resolution reveals that, which is why it
 * survived so long — so assert the ORDER, not the size.
 */
describe("kenBurnsFilter", () => {
  const filter = (w = 1920, h = 1080) => kenBurnsFilter(w, h, 150, 25, false);

  it("crops to the output aspect BEFORE zoompan", () => {
    const f = filter();
    const cropAt = f.indexOf("crop=");
    const zoomAt = f.indexOf("zoompan=");
    expect(cropAt).toBeGreaterThanOrEqual(0);
    expect(zoomAt).toBeGreaterThan(cropAt);
  });

  it("derives the cover-crop from the target aspect, so no axis is ever stretched", () => {
    // Largest rectangle of the output shape that fits inside the source, centred.
    expect(filter(1920, 1080)).toContain("crop='min(iw,ih*1920/1080)':'min(ih,iw*1080/1920)'");
    // A portrait channel must crop the other way round — not a hardcoded landscape rule.
    expect(filter(1080, 1920)).toContain("crop='min(iw,ih*1080/1920)':'min(ih,iw*1920/1080)'");
  });

  it("sizes the zoompan headroom from the output, not a fixed 8000px", () => {
    // The old chain scaled every source to 8000px wide whatever the channel rendered at,
    // building a 96-megapixel intermediate to feed a 1920x1080 filter.
    expect(filter(1920, 1080)).toContain("scale=5760:-2:flags=lanczos");
    expect(filter(1280, 720)).toContain("scale=3840:-2:flags=lanczos");
    expect(filter()).not.toContain("8000");
  });

  it("keeps the height even, which yuv420p requires", () => {
    expect(filter()).toMatch(/scale=\d+:-2:/);
  });

  it("still spans the zoom across the whole clip at any length", () => {
    // A 20s beat used to hit the cap early and then sit frozen; the step is per-clip.
    const short = kenBurnsFilter(1920, 1080, 100, 25, false);
    const long = kenBurnsFilter(1920, 1080, 500, 25, false);
    const step = (f: string) => Number(f.match(/on\*([\d.]+)/)![1]);
    expect(step(long)).toBeLessThan(step(short));
  });

  it("zooms out when asked", () => {
    expect(kenBurnsFilter(1920, 1080, 150, 25, true)).toContain("z='max(");
    expect(kenBurnsFilter(1920, 1080, 150, 25, false)).toContain("z='min(");
  });
});

describe("parseResolution", () => {
  it("falls back to 1080p for anything unparseable", () => {
    expect(parseResolution("1280x720")).toEqual({ w: 1280, h: 720 });
    expect(parseResolution("1080×1920")).toEqual({ w: 1080, h: 1920 });
    expect(parseResolution("nonsense")).toEqual({ w: 1920, h: 1080 });
    expect(parseResolution(undefined)).toEqual({ w: 1920, h: 1080 });
  });
});

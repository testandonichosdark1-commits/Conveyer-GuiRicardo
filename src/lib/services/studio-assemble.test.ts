import { describe, it, expect, vi } from "vitest";

/**
 * Regression guard for the avatar "blurry mush + head cut off" bug.
 *
 * contentCrop() runs `cropdetect=48:2:0` on the HeyGen clip to strip pillarbox bars.
 * cropdetect returns the bounding box of everything BRIGHTER than the threshold, so on an
 * avatar with a DARK studio background (luma ≈26) it crops away the background and keeps
 * only the FACE — the blur-fill path then blows that sliver up ~4.9x. isPlausibleContentCrop
 * is the accept/reject decision that catches this without touching any filter chain.
 *
 * The numbers below are the two real ones from git archaeology of the commits that
 * introduced and tuned this crop (5973654 / efa1a31), not invented examples.
 *
 * Hermetic: no ffmpeg, no ffprobe, no network. Settings/logger are mocked so importing the
 * module doesn't touch the user's SQLite DB.
 */
vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => undefined }));

import { isPlausibleContentCrop } from "./studio-assemble";

const W = 1920;
const H = 1080;

describe("isPlausibleContentCrop", () => {
  it("accepts the 9:16 talking-photo pillarbox the crop was added for", () => {
    // full source height preserved (bars left+right); area ≈ 31.6% of the frame
    expect(isPlausibleContentCrop("608:1080:656:0", W, H)).toBe(true);
  });

  it("rejects the confirmed client bug — dark background, face-only box", () => {
    // BOTH dimensions shrink ⇒ it cropped into the picture; area ≈ 9.6%
    expect(isPlausibleContentCrop("400:500:760:250", W, H)).toBe(false);
  });

  it("accepts a letterbox (full width, reduced height)", () => {
    expect(isPlausibleContentCrop("1920:810:0:135", W, H)).toBe(true);
  });

  it("rejects a degenerate full-height sliver (area floor)", () => {
    // passes the "keep one full dimension" rule, but 50px wide would be blown up ~38x
    expect(isPlausibleContentCrop("50:1080:900:0", W, H)).toBe(false);
  });

  it("accepts the full frame (no-op crop)", () => {
    expect(isPlausibleContentCrop("1920:1080:0:0", W, H)).toBe(true);
  });

  it("tolerates cropdetect's round=2 shaving a pixel off the full dimension", () => {
    expect(isPlausibleContentCrop("608:1078:656:0", W, H)).toBe(true);
    // ...but 4px short of full height with a narrow width is no longer a pillarbox
    expect(isPlausibleContentCrop("608:1076:656:2", W, H)).toBe(false);
  });

  it("rejects unparseable, empty and malformed strings", () => {
    for (const bad of ["", "   ", "garbage", "608:1080:656", "608:1080:656:0:4", "a:b:c:d", "608x1080"]) {
      expect(isPlausibleContentCrop(bad, W, H)).toBe(false);
    }
  });

  it("rejects non-positive and negative geometry", () => {
    expect(isPlausibleContentCrop("0:1080:0:0", W, H)).toBe(false);
    expect(isPlausibleContentCrop("1920:0:0:0", W, H)).toBe(false);
    expect(isPlausibleContentCrop("-608:1080:656:0", W, H)).toBe(false);
    expect(isPlausibleContentCrop("608:1080:-8:0", W, H)).toBe(false);
  });

  it("rejects a crop that runs outside the source frame", () => {
    expect(isPlausibleContentCrop("1920:1080:100:0", W, H)).toBe(false);
    expect(isPlausibleContentCrop("2048:1080:0:0", W, H)).toBe(false);
    expect(isPlausibleContentCrop("1920:1200:0:0", W, H)).toBe(false);
  });

  it("rejects everything when the source dimensions are unknown", () => {
    expect(isPlausibleContentCrop("608:1080:656:0", 0, 0)).toBe(false);
    expect(isPlausibleContentCrop("608:1080:656:0", -1920, 1080)).toBe(false);
  });

  it("works on a portrait source too (9:16 channel)", () => {
    // letterbox inside 1080x1920: full width kept, area ≈ 31.6%
    expect(isPlausibleContentCrop("1080:608:0:656", 1080, 1920)).toBe(true);
    expect(isPlausibleContentCrop("500:400:250:760", 1080, 1920)).toBe(false);
  });
});

import { describe, it, expect, vi } from "vitest";

/**
 * Three archive-test defects found 2026-11-06 (run 8d724249), each pinned here:
 *  1. a namesake portrait (George Smith the PUBLISHER, d. 1901) accepted for the Assyriologist —
 *     the catalogue text that would have exposed it never reached the scorer;
 *  2. a portrait-format 1850 watercolour cover-cropped into an unrecognisable smear;
 *  3. an AI "1870s newspaper" with an invented, legible masthead and headline.
 */
vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { coverCropLoss, shouldContain, kenBurnsFilter } from "./ken-burns";
import { catalogueText } from "./visual-source";
import { buildPlanPrompt } from "./studio-plan";
import { formatVisualWorld, normalizeVisualWorld } from "./visual-world";

describe("catalogueText — archive metadata the scorer sees", () => {
  it("keeps the facts that expose a namesake (the real Commons record)", () => {
    const t = catalogueText(
      "George Smith, by <a href='x'>John Collier</a> (died 1934), given to the National Portrait Gallery, London in 1911.",
      "Unknown date, before 1901, subject died in 1901"
    );
    expect(t).toContain("subject died in 1901");
    expect(t).not.toContain("<a");
  });
  it("is undefined when there is nothing to say, and capped otherwise", () => {
    expect(catalogueText(undefined, "  ", null)).toBeUndefined();
    expect(catalogueText("x".repeat(1000))!.length).toBe(300);
  });
});

describe("KEN_BURNS_FIT", () => {
  it("measures what a 16:9 cover-crop throws away", () => {
    expect(coverCropLoss(1920, 1080, 1920, 1080)).toBe(0);
    expect(coverCropLoss(709, 852, 1920, 1080)).toBeCloseTo(0.53, 2); // the Nineveh watercolour
    expect(coverCropLoss(3000, 2000, 1920, 1080)).toBeCloseTo(0.16, 2); // a 3:2 painting
  });
  it("auto contains the watercolour but leaves a 3:2 painting and a 16:9 AI still full-frame", () => {
    expect(shouldContain("auto", { w: 709, h: 852 }, 1920, 1080)).toBe(true);
    expect(shouldContain("auto", { w: 3000, h: 2000 }, 1920, 1080)).toBe(false);
    expect(shouldContain("auto", { w: 1376, h: 768 }, 1920, 1080)).toBe(false);
    expect(shouldContain("auto", null, 1920, 1080)).toBe(false); // unreadable size → old behaviour
  });
  it("blank never contains; contain always does", () => {
    expect(shouldContain("", { w: 709, h: 852 }, 1920, 1080)).toBe(false);
    expect(shouldContain("contain", { w: 1920, h: 1080 }, 1920, 1080)).toBe(true);
  });
  it("contain pads to the output aspect instead of cropping, before the zoom", () => {
    const f = kenBurnsFilter(1920, 1080, 90, 30, false, { range: 0.06, contain: true });
    expect(f.startsWith("pad=")).toBe(true);
    expect(f).not.toContain("crop=");
    expect(f.indexOf("pad=")).toBeLessThan(f.indexOf("zoompan="));
  });
  it("without contain the filter is exactly the cover-crop one", () => {
    expect(kenBurnsFilter(1920, 1080, 90, 30, false)).toMatch(/^crop=/);
  });
});

describe("person queries carry a role (archive + visual world only)", () => {
  const chunk = [{ index: 0, text: "In November 1872, a young man named George Smith was sitting in a back room of the British Museum." }];
  it("is in the archive prompt, and absent from the default one", () => {
    expect(buildPlanPrompt(chunk, undefined, "ctx", "", false, "", "archive")).toContain("PERSON RULE");
    expect(buildPlanPrompt(chunk, undefined, "ctx", "", false, "", "")).not.toContain("PERSON RULE");
  });
});

describe("no fabricated documents in AI prompts", () => {
  const chunk = [{ index: 9, text: "That was the part that made the newspapers." }];
  const world = formatVisualWorld(normalizeVisualWorld({
    topic: "George Smith and the Flood Tablet", era: "1870s", region: "London",
    families: ["a", "b", "c", "d", "e"], avoid: [],
  })!);
  it("is in the archive prompt and the visual-world prompt", () => {
    expect(buildPlanPrompt(chunk, undefined, "ctx", "", false, "", "archive")).toContain("NEVER depict a readable document");
    expect(buildPlanPrompt(chunk, undefined, "ctx", "", false, "", "", world)).toContain("NEVER depict a readable document");
  });
  it("leaves the default prompt untouched", () => {
    expect(buildPlanPrompt(chunk, undefined, "ctx", "", false, "", "")).not.toContain("readable document");
  });
});

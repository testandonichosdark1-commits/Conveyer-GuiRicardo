import { describe, it, expect, vi } from "vitest";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { flowModelLabelMatches, chipShowsModel } from "./flow-browser";

/**
 * Live Flow video-model menu, 2026-10-13: items read "volume_up Omni 1.1 Flash",
 * "volume_up Veo 3.1 - Lite", "volume_up Veo 3.1 - Fast" (a Material-icon ligature glued on),
 * and the family select reads "Omni 1.1 Flash arrow_drop_down" when Omni is active.
 */
describe("video model labels with icon ligatures", () => {
  it("matches the configured Veo tier despite the volume_up ligature and the dash", () => {
    expect(flowModelLabelMatches("veo 3.1 fast", "volume_up Veo 3.1 - Fast")).toBe(true);
    expect(flowModelLabelMatches("veo 3.1 lite", "volume_up Veo 3.1 - Lite")).toBe(true);
  });

  it("never matches a different tier or the Omni model", () => {
    expect(flowModelLabelMatches("veo 3.1 fast", "volume_up Veo 3.1 - Lite")).toBe(false);
    expect(flowModelLabelMatches("veo 3.1 fast", "volume_up Omni 1.1 Flash")).toBe(false);
  });

  it("reads the active model off the family select text", () => {
    expect(chipShowsModel("volume_up Veo 3.1 - Fast arrow_drop_down", "veo-3.1-fast")).toBe(true);
    expect(chipShowsModel("Omni 1.1 Flash arrow_drop_down", "veo-3.1-fast")).toBe(false);
  });

  it("still reads the Nano Banana chip as before", () => {
    expect(chipShowsModel("🍌 Nano Banana 2.1 crop_16_9 x1", "nano-banana-2.1")).toBe(true);
    expect(chipShowsModel("🍌 Nano Banana Pro crop_16_9 x1", "nano-banana-2.1")).toBe(false);
  });
});

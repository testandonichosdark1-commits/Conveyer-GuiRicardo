import { describe, it, expect, vi } from "vitest";
vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
import { fitSubjectToSlot } from "./visual-source";

describe("fitSubjectToSlot", () => {
  it("unwraps a 'shot of' description and moves the framing to the end", () => {
    expect(fitSubjectToSlot("An over-the-shoulder shot of the housekeeper in a neat uniform cleaning a modern hotel bathroom. Only her hands and torso are visible as she wipes the vanity."))
      .toBe("the housekeeper in a neat uniform cleaning a modern hotel bathroom, Only her hands and torso are visible as she wipes the vanity, over-the-shoulder shot");
  });
  it("leaves a plain subject alone apart from trailing punctuation", () => {
    expect(fitSubjectToSlot("a worn sponge on a kitchen counter.")).toBe("a worn sponge on a kitchen counter");
  });
  it("handles a bare 'close-up of', a bare 'wide shot', and a leading article", () => {
    expect(fitSubjectToSlot("a close-up of the housekeeper's hands wiping a shelf")).toBe("the housekeeper's hands wiping a shelf, close-up");
    expect(fitSubjectToSlot("A wide shot of a tidy kitchen.")).toBe("a tidy kitchen, wide shot");
    expect(fitSubjectToSlot("The housekeeper wipes a mirror.")).toBe("the housekeeper wipes a mirror");
  });
});

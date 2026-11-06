import { describe, it, expect } from "vitest";
import { GRAPHIC_TEMPLATE_KEYS, GRAPHIC_TEMPLATES, syntheticWords, validateGraphicData } from "./graphic-templates";

describe("graphic template schemas", () => {
  it("every template's bundled sample validates", () => {
    for (const key of GRAPHIC_TEMPLATE_KEYS) {
      expect(validateGraphicData(key, GRAPHIC_TEMPLATES[key].sample).ok, key).toBe(true);
    }
  });

  it("rejects an unknown template", () => {
    const v = validateGraphicData("not_a_template", {});
    expect(v.ok).toBe(false);
  });

  it("rejects unknown keys (strict) — a planner typo must fail, not render half a scene", () => {
    const v = validateGraphicData("kinetic_quote", { text: "Hi", colour: "red" });
    expect(v.ok).toBe(false);
  });

  it("rejects a missing required field and names it", () => {
    const v = validateGraphicData("product_hero", { image: "sample:flashlight" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("title");
  });

  it("rejects an image reference that is neither sample, path, data nor http", () => {
    expect(validateGraphicData("product_hero", { image: "flashlight.png", title: "X" }).ok).toBe(false);
    expect(validateGraphicData("product_hero", { image: "javascript:alert(1)", title: "X" }).ok).toBe(false);
  });

  it("applies defaults", () => {
    const v = validateGraphicData("kinetic_quote", { text: "Something that good gets copied." });
    expect(v.ok && v.data).toMatchObject({ style: "outline-fill", bg: "parchment", highlight: [] });
    const h = validateGraphicData("product_hero", { image: "sample:flashlight", title: "Mini Maglite" });
    expect(h.ok && h.data.bg).toBe("dark");
  });
});

describe("template-specific rules", () => {
  it("accepts a bare string as a stamp", () => {
    const v = validateGraphicData("product_hero", { image: "sample:flashlight", title: "X", stamp: "Sued" });
    expect(v.ok && v.data.stamp).toEqual({ text: "Sued" });
  });
  it("timeline focus must index an event", () => {
    const events = [{ year: 1981, label: "A" }, { year: 1998, label: "B" }];
    expect(validateGraphicData("timeline", { events, focus: 1 }).ok).toBe(true);
    expect(validateGraphicData("timeline", { events, focus: 2 }).ok).toBe(false);
  });
  it("counter takes whole numbers only", () => {
    expect(validateGraphicData("counter", { value: 3.5 }).ok).toBe(false);
    expect(validateGraphicData("counter", { value: 10000 }).ok).toBe(true);
  });
  it("spec anchors stay on the product (0..1)", () => {
    const base = { image: "sample:flashlight", name: "X" };
    expect(validateGraphicData("spec_callouts", { ...base, specs: [{ label: "A", anchor: { x: 1.2, y: 0.5 } }] }).ok).toBe(false);
  });
  it("versus sides validate nested images", () => {
    const side = { name: "A", image: "nope.png" };
    expect(validateGraphicData("versus", { left: side, right: { name: "B" } }).ok).toBe(false);
  });
});

describe("syntheticWords", () => {
  it("spreads the line evenly over the first 85% of the beat", () => {
    const w = syntheticWords("one two three four", 4000);
    expect(w.map((x) => x.text)).toEqual(["one", "two", "three", "four"]);
    expect(w[0].startMs).toBe(0);
    expect(w[3].startMs).toBe(2550);
    expect(w.every((x) => x.endMs > x.startMs)).toBe(true);
  });
  it("is empty for empty narration", () => {
    expect(syntheticWords("   ", 4000)).toEqual([]);
  });
});

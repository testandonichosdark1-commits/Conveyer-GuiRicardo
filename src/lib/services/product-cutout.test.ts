import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { cutoutOnLightBackground, productSlug, parseProductVerdict, layFlatIfUpright } from "./product-cutout";

/**
 * The background removal behind product cut-outs: a product shot on a plain light ground is
 * cut out and trimmed; anything else is refused (null) rather than half-cut.
 */
async function scene(bg: string, rect: { w: number; h: number; color: string } | null, size = 400): Promise<Buffer> {
  const base = sharp({ create: { width: size, height: size, channels: 3, background: bg } });
  if (!rect) return base.png().toBuffer();
  const block = await sharp({ create: { width: rect.w, height: rect.h, channels: 3, background: rect.color } }).png().toBuffer();
  return base.composite([{ input: block, left: Math.round((size - rect.w) / 2), top: Math.round((size - rect.h) / 2) }]).png().toBuffer();
}

describe("cutoutOnLightBackground", () => {
  it("cuts a dark product off a white ground and trims to it", async () => {
    const out = await cutoutOnLightBackground(await scene("#ffffff", { w: 240, h: 80, color: "#30343a" }));
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect(Math.abs(meta.width! - 240)).toBeLessThanOrEqual(2);
    expect(Math.abs(meta.height! - 80)).toBeLessThanOrEqual(2);
    const { data } = await sharp(out!).raw().toBuffer({ resolveWithObject: true });
    expect(data[3 + 4 * 120]).toBe(255); // solid inside
  });

  it("also handles a light-grey studio ground", async () => {
    expect(await cutoutOnLightBackground(await scene("#ececec", { w: 200, h: 120, color: "#8a2b20" }))).not.toBeNull();
  });

  it("refuses a photo whose border is not a light background", async () => {
    expect(await cutoutOnLightBackground(await scene("#3a5f2a", { w: 200, h: 120, color: "#30343a" }))).toBeNull();
  });

  it("refuses an empty white image (nothing to cut) and a product that fills the frame", async () => {
    expect(await cutoutOnLightBackground(await scene("#ffffff", null))).toBeNull();
    expect(await cutoutOnLightBackground(await scene("#ffffff", { w: 392, h: 392, color: "#30343a" }))).toBeNull();
  });
});

describe("debris, verdict, orientation", () => {
  it("drops a logo printed beside the product (separate small island)", async () => {
    const logo = await sharp({ create: { width: 90, height: 20, channels: 3, background: "#222222" } }).png().toBuffer();
    const product = await sharp({ create: { width: 240, height: 80, channels: 3, background: "#30343a" } }).png().toBuffer();
    const img = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#ffffff" } })
      .composite([{ input: product, left: 80, top: 100 }, { input: logo, left: 220, top: 300 }]).png().toBuffer();
    const meta = await sharp((await cutoutOnLightBackground(img))!).metadata();
    expect(Math.abs(meta.width! - 240)).toBeLessThanOrEqual(2); // trimmed to the product alone
    expect(Math.abs(meta.height! - 80)).toBeLessThanOrEqual(2);
  });

  it("accepts only 'the product, alone'", () => {
    expect(parseProductVerdict('{"match": true, "isolated": true, "upright_long_object": false}')).toEqual({ ok: true, layFlat: false });
    expect(parseProductVerdict('{"match": true, "isolated": false, "upright_long_object": true}').ok).toBe(false);
    expect(parseProductVerdict('{"match": false, "isolated": true}').ok).toBe(false);
    expect(parseProductVerdict("garbage").ok).toBe(false);
  });

  it("lays a standing long tool flat, and leaves everything else alone", async () => {
    const tall = await sharp({ create: { width: 100, height: 400, channels: 4, background: "#333333ff" } }).png().toBuffer();
    const flat = await sharp(await layFlatIfUpright(tall, true)).metadata();
    expect([flat.width, flat.height]).toEqual([400, 100]);
    expect((await sharp(await layFlatIfUpright(tall, false)).metadata()).height).toBe(400); // not a long tool
    const squat = await sharp({ create: { width: 200, height: 300, channels: 4, background: "#333333ff" } }).png().toBuffer();
    expect((await sharp(await layFlatIfUpright(squat, true)).metadata()).height).toBe(300); // not clearly portrait
  });
});

describe("productSlug", () => {
  it("is a stable file-safe key", () => {
    expect(productSlug("Mini Maglite")).toBe("mini-maglite");
    expect(productSlug("  Arm & Hammer Super Washing Soda ")).toBe("arm-hammer-super-washing-soda");
    expect(productSlug("Crème Brûlée Torch")).toBe("creme-brulee-torch");
  });
});

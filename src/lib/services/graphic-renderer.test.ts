import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Real Chromium (Playwright's bundled headless build) + real ffmpeg. Proves the two
 * properties the graphic layer stands on: frames are a pure function of (data, words, ms),
 * and a clip has EXACTLY the frame count its duration asks for — the compositor cuts beats
 * by frame count, so one frame short is a visible gap.
 */
let R!: typeof import("./graphic-renderer");
let resolveFfprobe!: () => string;
let tmp = "";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "graphic-render-"));
  process.env.FACELESS_STUDIO_DATA_DIR = tmp;
  const { ensureInit } = await import("../init");
  ensureInit();
  R = await import("./graphic-renderer");
  resolveFfprobe = (await import("../ffmpeg-bin")).resolveFfprobe;
}, 60_000);

afterAll(async () => {
  await R?.closeGraphicBrowser();
});

async function maxPixelDiff(a: Buffer, b: Buffer): Promise<number> {
  const sharp = (await import("sharp")).default;
  const [ra, rb] = await Promise.all([sharp(a).raw().toBuffer(), sharp(b).raw().toBuffer()]);
  expect(ra.length).toBe(rb.length);
  let max = 0;
  for (let i = 0; i < ra.length; i++) max = Math.max(max, Math.abs(ra[i] - rb[i]));
  return max;
}

const quote = { text: "Something that good gets copied.", highlight: ["gets copied"], bg: "dark" };
const words = [
  { text: "Something", startMs: 0, endMs: 300 },
  { text: "that", startMs: 320, endMs: 450 },
  { text: "good", startMs: 470, endMs: 700 },
  { text: "gets", startMs: 720, endMs: 900 },
  { text: "copied.", startMs: 920, endMs: 1300 },
];

describe("graphic renderer", () => {
  it("renders the same frame byte-identically twice (no wall clock)", async () => {
    const input = { template: "kinetic_quote", data: quote, words, durationSec: 2, width: 640, height: 360, atMs: 610 };
    const a = await R.renderGraphicFrame(input);
    const b = await R.renderGraphicFrame(input);
    expect(a.length).toBeGreaterThan(1000);
    expect(Buffer.compare(a, b)).toBe(0);
  }, 60_000);

  it("a frame reached by seeking through earlier times equals a fresh render at that time", async () => {
    // Guards against capturing a stale pose, and against any state leaking between seeks.
    const base = { template: "kinetic_quote", data: quote, words, durationSec: 2, width: 640, height: 360 };
    const [, , walked] = await R.renderGraphicFrames(base, [0, 900, 1400]);
    const fresh = await R.renderGraphicFrame({ ...base, atMs: 1400 });
    expect(Buffer.compare(walked, fresh)).toBe(0);
    const [back] = await R.renderGraphicFrames(base, [1400, 300]).then((f) => [f[1]]);
    const fresh300 = await R.renderGraphicFrame({ ...base, atMs: 300 });
    expect(Buffer.compare(back, fresh300)).toBe(0);

    const hero = { template: "product_hero", data: { image: "sample:flashlight", title: "Mini Maglite", reveal: true, chip: "Same build" }, durationSec: 4, width: 640, height: 360 };
    const [, , heroWalked] = await R.renderGraphicFrames(hero, [0, 3500, 1700]);
    const heroFresh = await R.renderGraphicFrame({ ...hero, atMs: 1700 });
    // Rotated rays + gradient dithering can land 1/255 apart depending on what the compositor
    // cached — invisible and erased by H.264. A stale pose would differ by far more.
    expect(await maxPixelDiff(heroWalked, heroFresh)).toBeLessThanOrEqual(2);
  }, 60_000);

  it("different times give different frames (the timeline actually moves)", async () => {
    const base = { template: "kinetic_quote", data: quote, words, durationSec: 2, width: 640, height: 360 };
    const early = await R.renderGraphicFrame({ ...base, atMs: 100 });
    const late = await R.renderGraphicFrame({ ...base, atMs: 1500 });
    expect(Buffer.compare(early, late)).not.toBe(0);
  }, 60_000);

  it("encodes a silent H.264 clip with exactly round(duration × 30) frames", async () => {
    const out = path.join(tmp, "hero.mp4");
    const r = await R.renderGraphicClip({
      template: "product_hero",
      data: { image: "sample:flashlight", title: "Mini Maglite", overline: "1984" },
      durationSec: 1.2,
      width: 640,
      height: 360,
      outPath: out,
    });
    expect(r.frames).toBe(36);
    const probe = spawnSync(resolveFfprobe(), [
      "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height,nb_read_frames",
      "-of", "json", out,
    ]);
    const streams = JSON.parse(String(probe.stdout)).streams as Array<Record<string, unknown>>;
    expect(streams).toHaveLength(1); // no audio stream
    expect(streams[0]).toMatchObject({ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 640, height: 360 });
    expect(Number(streams[0].nb_read_frames)).toBe(36);
  }, 90_000);

  it("every template renders its bundled sample, start and end differing", async () => {
    const { GRAPHIC_TEMPLATE_KEYS, GRAPHIC_TEMPLATES, syntheticWords } = await import("./graphic-templates");
    for (const key of GRAPHIC_TEMPLATE_KEYS) {
      const t = GRAPHIC_TEMPLATES[key];
      const [first, last] = await R.renderGraphicFrames({
        template: key, data: t.sample, words: syntheticWords(t.sampleNarration, 4000), durationSec: 4, width: 480, height: 270,
      }, [0, 3900]);
      expect(last.length, key).toBeGreaterThan(1000);
      expect(Buffer.compare(first, last), key).not.toBe(0);
    }
  }, 120_000);

  it("resolves nested image refs (versus sides, polaroid photos)", () => {
    const out = R.resolveImages({ left: { image: "sample:phone" }, photos: [{ image: "sample:knife", caption: "x" }] });
    expect(out.left.image).toMatch(/^file:.*phone\.svg$/);
    expect(out.photos[0].image).toMatch(/^file:.*knife\.svg$/);
    expect(out.photos[0].caption).toBe("x");
  });

  it("rejects invalid data before opening a page, and leaves no output file", async () => {
    const out = path.join(tmp, "bad.mp4");
    await expect(R.renderGraphicClip({ template: "kinetic_quote", data: { nope: 1 }, durationSec: 1, outPath: out }))
      .rejects.toBeInstanceOf(R.GraphicRenderError);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("fails clearly when the product image cannot be loaded", async () => {
    await expect(R.renderGraphicFrame({
      template: "product_hero",
      data: { image: "/definitely/not/here.png", title: "X" },
      durationSec: 1,
      atMs: 0,
    })).rejects.toThrow(/image not found/);
  });
});

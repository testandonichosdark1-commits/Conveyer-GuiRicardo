import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * "Is the strip we're about to remove actually a BAR?" — the last guard in contentCrop().
 *
 * Why it exists: on a real client clip (2026-07-29) cropdetect returned
 * crop=1886:1080:0:0 on a clean 1920x1080 HeyGen render. It was shaving 34px off a photo
 * whose right side is a dark corner of a garage — cropdetect's luma threshold cannot tell
 * a dark PICTURE from a black BAR. Losing those 34px made the clip no longer 16:9, so the
 * blur-fill in renderBeat padded it back out with 14px of blurred smear down each side.
 * That smear is what the client reported as "grey lateral spaces".
 *
 * The shape guards can't catch it: that crop keeps the full height AND 98% of the area.
 * Only looking at the removed pixels settles it.
 *
 * These tests build REAL video files with ffmpeg and run the REAL contentCrop path (via
 * renderBeat's caller), so the guard is exercised end-to-end rather than in the abstract.
 * Every "must reject" case is paired with a "must still accept" control — a guard that
 * rejected everything would pass the first half and fail the second.
 */

import { contentCrop, removedStrips, readsAsFlatBar, usesCoverCrop, isPlausibleContentCrop } from "./studio-assemble";

const TMP = path.join(os.tmpdir(), `bar-guard-${process.pid}`);
const FFMPEG = "ffmpeg";

/** A 1920x1080 clip that IS a portrait photo inside genuine black pillarbox bars. */
const PILLARBOXED = path.join(TMP, "pillarboxed.mp4");
/** A 1920x1080 clip that is a full-frame picture whose right edge happens to be dark —
 *  the client's case. Nothing here should ever be cropped. */
const DARK_EDGE = path.join(TMP, "dark-edge.mp4");

/** ffmpeg writes cropdetect + signalstats to STDERR, so both helpers use spawnSync
 *  and read stderr — exactly as the production code does. */
function ffmpegErr(args: string[]): string {
  const r = spawnSync(FFMPEG, args, { encoding: "utf8", stdio: "pipe", timeout: 60000 });
  return ((r.stdout ?? "") as string) + ((r.stderr ?? "") as string);
}

function cropdetectSafe(file: string): string | null {
  const out = ffmpegErr(["-ss", "0.5", "-i", file, "-vf", "cropdetect=48:2:0", "-frames:v", "60", "-an", "-f", "null", "-"]);
  const m = [...out.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)];
  return m.length ? m[m.length - 1][1] : null;
}

function measureStrip(file: string, strip: string): { spread: number; avg: number } | null {
  const out = ffmpegErr(["-ss", "0.5", "-i", file, "-vf", `crop=${strip},signalstats,metadata=print:file=-`, "-frames:v", "3", "-an", "-f", "null", "-"]);
  const mins = [...out.matchAll(/signalstats\.YMIN=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const maxs = [...out.matchAll(/signalstats\.YMAX=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const avgs = [...out.matchAll(/signalstats\.YAVG=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!mins.length || !maxs.length || !avgs.length) return null;
  return { spread: Math.max(...maxs) - Math.min(...mins), avg: Math.max(...avgs) };
}

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  // Genuine pillarbox: a 1080x1080 picture centred on a 1920x1080 black canvas.
  execFileSync(FFMPEG, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1080x1080:rate=25:duration=2",
    "-vf", "pad=1920:1080:420:0:black", "-frames:v", "50",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", PILLARBOXED,
  ], { timeout: 90000 });
  // Full-frame picture, right ~40px darkened into shadow (the client's garage corner).
  // Built from a bright pattern so the dark edge is unambiguously part of the picture.
  execFileSync(FFMPEG, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25:duration=2",
    "-vf", "geq=lum='if(gt(X,1880), 10+8*sin(Y/7), lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)'",
    "-frames:v", "50", "-c:v", "libx264", "-pix_fmt", "yuv420p", DARK_EDGE,
  ], { timeout: 90000 });
}, 180_000);

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("removedStrips", () => {
  it("returns nothing when the crop removes nothing", () => {
    expect(removedStrips("1920:1080:0:0", 1920, 1080)).toEqual([]);
  });

  it("describes a right-side shave (the client's crop)", () => {
    // crop=1886:1080:0:0 on 1920x1080 removes x 1886..1919.
    expect(removedStrips("1886:1080:0:0", 1920, 1080)).toEqual(["34:1080:1886:0"]);
  });

  it("describes both bars of a pillarbox", () => {
    expect(removedStrips("1080:1080:420:0", 1920, 1080)).toEqual(["420:1080:0:0", "420:1080:1500:0"]);
  });

  it("describes letterbox bars", () => {
    expect(removedStrips("1920:800:0:140", 1920, 1080)).toEqual(["1920:140:0:0", "1920:140:0:940"]);
  });

  it("returns nothing for a malformed crop", () => {
    expect(removedStrips("garbage", 1920, 1080)).toEqual([]);
  });
});

describe("readsAsFlatBar", () => {
  it("accepts a flat dark fill", () => {
    expect(readsAsFlatBar(0, 16)).toBe(true); // measured on a real HeyGen pillarbox
  });
  it("rejects picture content", () => {
    expect(readsAsFlatBar(103, 36)).toBe(false); // measured on the client's clip
  });
  it("rejects a flat but BRIGHT strip (a white wall is not a bar)", () => {
    expect(readsAsFlatBar(0, 200)).toBe(false);
  });
});

describe("usesCoverCrop — blur-fill vs cover-crop", () => {
  it("cover-crops a clip our own 4px shave nudged off 16:9", () => {
    // 1920x1080 → crop=iw-8:ih-8 → 1912x1072. Fitting THAT inside the frame is what left
    // a 2px blurred smear top and bottom on every full-screen avatar shot.
    expect(usesCoverCrop(1912, 1072, 1920, 1080)).toBe(true);
  });

  it("cover-crops an exactly-16:9 clip", () => {
    expect(usesCoverCrop(1920, 1080, 1920, 1080)).toBe(true);
  });

  it("CONTROL: still blur-fills a portrait talking-photo — that is what blur-fill is FOR", () => {
    // A 9:16 clip cannot fill 16:9, and cover-cropping it would cut the head off.
    expect(usesCoverCrop(1080, 1920, 1920, 1080)).toBe(false);
    expect(usesCoverCrop(608, 1080, 1920, 1080)).toBe(false);
  });

  it("CONTROL: still blur-fills a square clip", () => {
    expect(usesCoverCrop(1080, 1080, 1920, 1080)).toBe(false);
  });

  it("respects the frame's own shape, not a hardcoded 16:9", () => {
    // A 9:16 channel: a portrait clip now COVERS and a landscape one gets blur-filled.
    expect(usesCoverCrop(1080, 1920, 1080, 1920)).toBe(true);
    expect(usesCoverCrop(1920, 1080, 1080, 1920)).toBe(false);
  });

  it("refuses to decide on nonsense dimensions (falls back to blur-fill)", () => {
    expect(usesCoverCrop(0, 1080, 1920, 1080)).toBe(false);
    expect(usesCoverCrop(1920, 0, 1920, 1080)).toBe(false);
  });
});

describe("the guard on real video files — calling the REAL contentCrop()", () => {
  it("REJECTS the crop when the removed strip is picture (the client's bug)", () => {
    // Precondition: cropdetect must genuinely WANT to crop here, and the old shape-only
    // guards must have waved it through — otherwise this test would pass even with the
    // new guard deleted, and would prove nothing.
    const proposed = cropdetectSafe(DARK_EDGE);
    expect(proposed, "cropdetect should propose a crop on a dark-edged picture").toBeTruthy();
    expect(proposed).not.toBe("1920:1080:0:0");
    expect(isPlausibleContentCrop(proposed!, 1920, 1080), "the OLD guards accept this crop").toBe(true);

    // The shipping function must now refuse it.
    expect(contentCrop(DARK_EDGE)).toBeNull();
  }, 120_000);

  it("CONTROL: still ACCEPTS a genuine pillarbox — the feature must keep working", () => {
    const crop = contentCrop(PILLARBOXED);
    expect(crop, "a real black pillarbox must still be stripped").toBeTruthy();
    // It found the picture inside the bars, not the whole frame.
    expect(crop).not.toBe("1920:1080:0:0");
    expect(isPlausibleContentCrop(crop!, 1920, 1080)).toBe(true);
    for (const s of removedStrips(crop!, 1920, 1080)) {
      const l = measureStrip(PILLARBOXED, s);
      expect(l, `strip ${s} must be measurable`).not.toBeNull();
      expect(readsAsFlatBar(l!.spread, l!.avg), `strip ${s} is a real black bar`).toBe(true);
    }
  }, 120_000);
});

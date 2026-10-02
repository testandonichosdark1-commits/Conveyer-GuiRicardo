import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * Equivalence guard: animateStill must produce the SAME clip as a direct kenBurns call.
 * Real ffmpeg (same convention as studio-assemble-parallel.test.ts), a generated fixture
 * still, no network. Skipped when ffmpeg is not installed.
 */
vi.mock("../settings", () => ({
  getSetting: (key: string) => (key === "VIDEO_FPS" ? "24" : key === "VIDEO_RESOLUTION" ? "320x180" : ""),
}));

import { kenBurns } from "./ken-burns";
import { animateStill } from "./still-animator";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "still-equiv-"));
let haveFfmpeg = true;
const still = path.join(tmp, "portrait.png");

beforeAll(() => {
  // A PORTRAIT still, so the cover-crop to 16:9 is exercised too.
  const r = spawnSync("ffmpeg", ["-f", "lavfi", "-i", "testsrc2=s=240x360:d=1", "-frames:v", "1", "-y", still]);
  haveFfmpeg = r.status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function probe(file: string) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames:format=duration",
    "-of", "json", file,
  ]);
  return JSON.parse(String(r.stdout));
}
const md5 = (f: string) => crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");

describe("animateStill ≡ kenBurns", () => {
  for (const [label, zoomOut, resolution] of [
    ["zoom in, default resolution", false, undefined],
    ["zoom out, explicit resolution", true, "256x144"],
  ] as const) {
    it(`${label}: identical ffprobe and identical bytes`, async () => {
      if (!haveFfmpeg) return;
      const a = path.join(tmp, `direct-${zoomOut}.mp4`);
      const b = path.join(tmp, `seam-${zoomOut}.mp4`);
      kenBurns(still, a, 1.5, zoomOut, resolution);
      await animateStill({ imagePath: still, outPath: b, durationSec: 1.5, zoomOut, resolution });

      const pa = probe(a);
      expect(probe(b)).toEqual(pa);
      expect(pa.streams[0].codec_name).toBe("h264");
      expect(pa.streams[0].nb_read_frames).toBe("36"); // 1.5s × 24fps
      expect(`${pa.streams[0].width}x${pa.streams[0].height}`).toBe(resolution ?? "320x180");
      expect(md5(b)).toBe(md5(a));
    }, 60_000);
  }

  it("an unreadable still fails the same way through both paths", async () => {
    if (!haveFfmpeg) return;
    const bad = path.join(tmp, "not-an-image.png");
    fs.writeFileSync(bad, "this is text");
    let direct: Error | null = null;
    try { kenBurns(bad, path.join(tmp, "x.mp4"), 1, false); } catch (e) { direct = e as Error; }
    expect(direct?.message).toMatch(/^Ken Burns ffmpeg failed/);
    await expect(animateStill({ imagePath: bad, outPath: path.join(tmp, "y.mp4"), durationSec: 1, zoomOut: false }))
      .rejects.toThrow(/^Ken Burns ffmpeg failed/);
  }, 60_000);
});

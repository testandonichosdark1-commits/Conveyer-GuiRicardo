import { describe, it, expect, vi, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Regression guard for the beat-render parallelization in `assembleStudioVideo`.
 *
 * The per-beat loop used to be a plain sequential `for` — one ffmpeg process at a
 * time — which measured at ~27 minutes of wall time for 174 beats on a 10-core
 * machine that sat mostly idle. It is now a `pLimit`-bounded concurrent pass, and the
 * one invariant that must never break under concurrency is ORDER: the concat list
 * must list beats in beat order, never completion order, or the video plays back
 * scrambled. This drives the real function (real ffmpeg — same convention as
 * voiceover-file.test.ts / voiceover-upload.test.ts) rather than re-deriving the
 * ordering logic in a mock, so it actually exercises `pLimit` + real concurrent
 * ffmpeg processes, not just the bookkeeping around them.
 */
vi.mock("../settings", () => ({
  getSetting: (key: string) => (key === "ASSEMBLE_CONCURRENCY" ? "2" : ""),
}));
const logLines: string[] = [];
vi.mock("../logger", () => ({ log: (_r: string, _l: string, msg: string) => { logLines.push(msg); } }));
vi.mock("./audio-loudness", () => ({ masterLoudness: () => undefined }));

import { assembleStudioVideo, type RenderBeat } from "./studio-assemble";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "assemble-parallel-"));
const ffmpeg = "ffmpeg";
let haveFfmpeg = true;
let srcVideo: string;
let voice: string;

beforeAll(() => {
  srcVideo = path.join(tmp, "src.mp4");
  voice = path.join(tmp, "voice.mp3");
  const a = spawnSync(ffmpeg, ["-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10:d=2", "-pix_fmt", "yuv420p", "-y", srcVideo]);
  const b = spawnSync(ffmpeg, ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "3", "-y", voice]);
  haveFfmpeg = a.status === 0 && b.status === 0;
});

function beat(i: number, visualPath: string): RenderBeat {
  return {
    index: i,
    startMs: i * 300,
    endMs: (i + 1) * 300,
    text: `beat ${i}`,
    layout: "broll",
    visualQuery: "",
    source: "ai",
    visualPath,
    avatarClipPath: null,
  };
}

describe("assembleStudioVideo — concurrent beat rendering", () => {
  it("keeps the concat list in beat order under concurrency, and still falls back to a filler on a bad beat", async () => {
    if (!haveFfmpeg) return; // no local ffmpeg — skip rather than fail the suite
    const outDir = fs.mkdtempSync(path.join(tmp, "run-"));
    const beats: RenderBeat[] = [0, 1, 2, 3, 4, 5].map((i) =>
      // Beat 3 points at a file that doesn't exist — must degrade to a black filler,
      // not crash the run or shift every later beat off the timeline.
      beat(i, i === 3 ? path.join(tmp, "does-not-exist.mp4") : srcVideo)
    );

    const finalPath = await assembleStudioVideo("test-run", voice, beats, outDir, "64x64", false, false);
    expect(fs.existsSync(finalPath)).toBe(true);

    const concatTxt = fs.readFileSync(path.join(outDir, "beats", "concat.txt"), "utf-8");
    const names = concatTxt
      .split("\n")
      .filter(Boolean)
      .map((line) => path.basename(line.replace(/^file '/, "").replace(/'$/, "")));
    // Positional naming (beat_0000..beat_0005) IS the order guarantee — pLimit
    // completion order must never change which name lands in which concat slot.
    expect(names).toEqual(["beat_0000.mp4", "beat_0001.mp4", "beat_0002.mp4", "beat_0003.mp4", "beat_0004.mp4", "beat_0005.mp4"]);

    expect(logLines.some((m) => m.includes("Beat 3") && m.includes("FAILED") && m.includes("black filler"))).toBe(true);
  }, 30_000);
});

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * voiceoverFromFile() — the upload-mode half of the voiceover seam.
 *
 * The contract under test is that it yields the SAME `Voiceover` shape as
 * synthesizeVoiceover(), lands the master at the exact filename Resume looks for, and
 * refuses to invent timings.
 *
 * alignWords is mocked (that is the Groq boundary — verified for real in Stage 0), but
 * the ffmpeg transcode and the strict probe run for real against media built at test
 * time, because the filename/duration invariants are precisely what a mock would hide.
 */

const store = vi.hoisted(() => ({ values: {} as Record<string, string> }));
const align = vi.hoisted(() => ({
  words: [] as { word: string; startMs: number; endMs: number }[],
  calls: [] as { path: string; script: string; durationSec: number }[],
}));

vi.mock("../settings", () => ({ getSetting: (k: string) => store.values[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("./audio-loudness", () => ({ masterLoudness: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));
vi.mock("./elevenlabs-voiceover", () => ({
  alignWords: async (_runId: string, p: string, script: string, durationSec: number) => {
    align.calls.push({ path: p, script, durationSec });
    return align.words;
  },
}));

import { voiceoverFromFile } from "./voiceover-file";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vo-file-test-"));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const mediaIt = hasFfmpeg ? it : it.skip;

function makeAudio(name: string, sec: number, extra: string[] = []): string {
  const p = path.join(TMP, name);
  spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${sec}`, ...extra, p], { stdio: "ignore" });
  return p;
}

const WORDS = [
  { word: "Hello", startMs: 0, endMs: 400 },
  { word: "world.", startMs: 400, endMs: 900 },
];

beforeEach(() => {
  store.values = { GROQ_API_KEY: "gsk_test" };
  align.words = WORDS;
  align.calls = [];
});
afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("voiceoverFromFile — the Voiceover contract", () => {
  mediaIt("returns the same shape synthesizeVoiceover does", async () => {
    const out = path.join(TMP, "run1");
    const vo = await voiceoverFromFile("run1", makeAudio("a.mp3", 2), out);
    expect(Object.keys(vo).sort()).toEqual(["durationSec", "filePath", "words"]);
    expect(typeof vo.filePath).toBe("string");
    expect(typeof vo.durationSec).toBe("number");
    expect(Array.isArray(vo.words)).toBe(true);
    expect(vo.words[0]).toEqual({ word: "Hello", startMs: 0, endMs: 400 });
  });

  // The load-bearing invariant: canResumeStudioRun() and resumeStudioPipeline() look for
  // this exact filename. Break it and an upload-sourced run silently stops being resumable.
  mediaIt("ALWAYS writes the master to <outDir>/voiceover.mp3", async () => {
    const out = path.join(TMP, "run2");
    const vo = await voiceoverFromFile("run2", makeAudio("b.wav", 1), out);
    expect(vo.filePath).toBe(path.join(out, "voiceover.mp3"));
    expect(fs.existsSync(vo.filePath)).toBe(true);
    expect(fs.statSync(vo.filePath).size).toBeGreaterThan(0);
  });

  mediaIt("creates the output directory if it does not exist", async () => {
    const out = path.join(TMP, "nested", "deep", "audio");
    await voiceoverFromFile("run3", makeAudio("c.mp3", 1), out);
    expect(fs.existsSync(path.join(out, "voiceover.mp3"))).toBe(true);
  });

  mediaIt("normalizes any input container to mp3 (wav in → mp3 master)", async () => {
    const out = path.join(TMP, "run4");
    const vo = await voiceoverFromFile("run4", makeAudio("d.wav", 1), out);
    const probed = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", vo.filePath], { encoding: "utf8" });
    expect(probed.stdout.trim()).toBe("mp3");
  });

  mediaIt("extracts the audio track from a VIDEO upload", async () => {
    const p = path.join(TMP, "v.mp4");
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", p], { stdio: "ignore" });
    const vo = await voiceoverFromFile("run5", p, path.join(TMP, "run5"));
    expect(vo.durationSec).toBeGreaterThan(1);
    expect(fs.existsSync(vo.filePath)).toBe(true);
  });

  mediaIt("measures duration from the TRANSCODED master, not the source header", async () => {
    const out = path.join(TMP, "run6");
    const vo = await voiceoverFromFile("run6", makeAudio("e.mp3", 3), out);
    expect(vo.durationSec).toBeGreaterThan(2.5);
    expect(vo.durationSec).toBeLessThan(3.6);
    // alignWords must be handed the master path + that same duration.
    expect(align.calls[0].path).toBe(vo.filePath);
    expect(align.calls[0].durationSec).toBe(vo.durationSec);
  });

  mediaIt("passes an EMPTY script to alignWords (there is none to align against)", async () => {
    await voiceoverFromFile("run7", makeAudio("f.mp3", 1), path.join(TMP, "run7"));
    expect(align.calls[0].script).toBe("");
  });
});

describe("voiceoverFromFile — refuses to invent timings", () => {
  mediaIt("throws when transcription yields no words (silence / music / bad key)", async () => {
    align.words = [];
    await expect(voiceoverFromFile("run8", makeAudio("g.mp3", 1), path.join(TMP, "run8"))).rejects.toThrow(
      /No speech was detected/i
    );
  });

  it("fails fast without a Groq key — BEFORE doing any transcode work", async () => {
    store.values = {}; // no GROQ_API_KEY
    const out = path.join(TMP, "run9");
    // A real file that is NOT decodable audio: if the key guard were moved after the
    // transcode we would get "Could not decode" instead, so this pins the ordering.
    const src = path.join(TMP, "present-but-not-audio.mp3");
    fs.writeFileSync(src, "x");
    await expect(voiceoverFromFile("run9", src, out)).rejects.toThrow(/Groq API key/i);
    // Nothing was written and no transcription was attempted.
    expect(fs.existsSync(path.join(out, "voiceover.mp3"))).toBe(false);
    expect(align.calls).toHaveLength(0);
  });

  it("throws a clear error when the source file is missing", async () => {
    await expect(
      voiceoverFromFile("run10", path.join(TMP, "nope.mp3"), path.join(TMP, "run10"))
    ).rejects.toThrow(/not found on disk/i);
  });

  mediaIt("throws when the source is not decodable audio", async () => {
    const bad = path.join(TMP, "bad.mp3");
    fs.writeFileSync(bad, "not audio at all");
    await expect(voiceoverFromFile("run11", bad, path.join(TMP, "run11"))).rejects.toThrow(/Could not decode/i);
  });
});

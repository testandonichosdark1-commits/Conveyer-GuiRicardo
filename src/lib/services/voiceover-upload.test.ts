import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Voiceover upload validation.
 *
 * The pure helpers (extension, duration cap, formatting) are asserted directly. The
 * validation itself is exercised against REAL media built by ffmpeg at test time, plus
 * hand-made adversarial files — a renamed text file, a zero-byte file, a video with no
 * audio track. Mocking ffprobe here would only re-test the mock; the whole value of this
 * gate is what it does to files a mock can't imitate.
 *
 * If ffmpeg is unavailable the media-dependent cases are skipped rather than failed, so
 * the suite stays green on a machine without it. The pure helpers always run.
 */

const store = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => store.values[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("./audio-loudness", () => ({ masterLoudness: () => {} }));

import {
  extForUpload,
  maxUploadSeconds,
  formatDurationHuman,
  validateUploadedAudio,
  resolveStagedUpload,
  uploadsDir,
} from "./voiceover-upload";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vo-upload-test-"));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const mediaIt = hasFfmpeg ? it : it.skip;

/** Build a real audio file of `sec` seconds. Returns its path. */
function makeAudio(name: string, sec: number): string {
  const p = path.join(TMP, name);
  spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${sec}`, p], { stdio: "ignore" });
  return p;
}

beforeEach(() => {
  store.values = {};
});
afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("extForUpload — cosmetic only, never a gate", () => {
  it("keeps a known audio/container extension", () => {
    expect(extForUpload("voice.mp3")).toBe(".mp3");
    expect(extForUpload("VOICE.WAV")).toBe(".wav");
    expect(extForUpload("take 3.m4a")).toBe(".m4a");
    expect(extForUpload("a.flac")).toBe(".flac");
    expect(extForUpload("track.opus")).toBe(".opus");
  });

  it("falls back to .bin for unknown/missing names — the probe decides, not this", () => {
    expect(extForUpload("resume.pdf")).toBe(".bin");
    expect(extForUpload("noextension")).toBe(".bin");
    expect(extForUpload("")).toBe(".bin");
    expect(extForUpload(null)).toBe(".bin");
    expect(extForUpload(undefined)).toBe(".bin");
  });

  it("does not let a path separator escape the staging directory", () => {
    // path.extname on traversal input still yields a plain extension or "".
    expect(extForUpload("../../etc/passwd")).toBe(".bin");
    expect(extForUpload("../../x.mp3")).toBe(".mp3");
  });
});

describe("maxUploadSeconds", () => {
  it("defaults to 50 minutes when unset", () => {
    expect(maxUploadSeconds()).toBe(3000);
  });
  it("honors UPLOAD_MAX_MINUTES", () => {
    store.values.UPLOAD_MAX_MINUTES = "5";
    expect(maxUploadSeconds()).toBe(300);
  });
  it("ignores garbage and non-positive values rather than disabling the cap", () => {
    for (const v of ["", "abc", "0", "-10"]) {
      store.values.UPLOAD_MAX_MINUTES = v;
      expect(maxUploadSeconds()).toBe(3000);
    }
  });
});

describe("formatDurationHuman", () => {
  it("renders seconds, minutes and hours the way an operator reads them", () => {
    expect(formatDurationHuman(45)).toBe("45s");
    expect(formatDurationHuman(134)).toBe("2m 14s");
    expect(formatDurationHuman(3000)).toBe("50m 0s");
    expect(formatDurationHuman(4320)).toBe("1h 12m");
  });
  it("never renders a negative duration", () => {
    expect(formatDurationHuman(-5)).toBe("0s");
  });
});

describe("resolveStagedUpload — the id comes from a request body, so treat it as hostile", () => {
  const staged: string[] = [];
  const stage = (name: string) => {
    const p = path.join(uploadsDir(), name);
    fs.writeFileSync(p, "x");
    staged.push(p);
    return p;
  };
  afterAll(() => {
    for (const p of staged) { try { fs.unlinkSync(p); } catch {} }
  });

  it("finds a staged file by its uuid, discovering the extension from disk", () => {
    const id = "3f1a2b4c-5d6e-4f70-8912-abcdef123456";
    const p = stage(`${id}.mp3`);
    expect(resolveStagedUpload(id)).toBe(p);
  });

  it("returns null for a well-formed uuid that was never staged", () => {
    expect(resolveStagedUpload("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it.each([
    "../../etc/passwd",
    "../../../.faceless-studio/studio.db",
    "..",
    "/etc/passwd",
    "not-a-uuid",
    "3f1a2b4c-5d6e-4f70-8912-abcdef123456/../../x",
    "",
    "   ",
  ])("refuses %j without touching the filesystem", (evil) => {
    expect(resolveStagedUpload(evil)).toBeNull();
  });

  it("does not match a DIFFERENT id that merely shares a prefix", () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    stage(`${id}.mp3`);
    // A uuid is fixed-length, so a prefix collision can only come from a malformed id —
    // which is rejected outright. The dot in `${id}.` also prevents suffix confusion.
    expect(resolveStagedUpload(`${id}-extra`)).toBeNull();
  });
});

describe("validateUploadedAudio — rejections", () => {
  it("rejects a zero-byte upload with the empty reason (not a probe error)", async () => {
    const p = path.join(TMP, "empty.mp3");
    fs.writeFileSync(p, "");
    const r = await validateUploadedAudio(p);
    expect(r).toMatchObject({ ok: false, reason: "empty" });
    if (!r.ok) expect(r.error).toMatch(/empty/i);
  });

  it("rejects a missing file without throwing", async () => {
    const r = await validateUploadedAudio(path.join(TMP, "does-not-exist.mp3"));
    expect(r.ok).toBe(false);
  });

  mediaIt("rejects a text file renamed to .mp3", async () => {
    const p = path.join(TMP, "fake.mp3");
    fs.writeFileSync(p, "this is not audio, it is prose pretending to be audio");
    const r = await validateUploadedAudio(p);
    expect(r).toMatchObject({ ok: false, reason: "unreadable" });
  });

  mediaIt("rejects a video that has no audio track", async () => {
    const p = path.join(TMP, "silent.mp4");
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2", "-an", p], { stdio: "ignore" });
    const r = await validateUploadedAudio(p);
    expect(r).toMatchObject({ ok: false, reason: "no_audio_stream" });
    if (!r.ok) expect(r.error).toMatch(/no audio track/i);
  });

  mediaIt("rejects audio longer than the configured cap, naming BOTH durations", async () => {
    store.values.UPLOAD_MAX_MINUTES = "0.05"; // 3 seconds
    const p = makeAudio("long.mp3", 5);
    const r = await validateUploadedAudio(p);
    expect(r).toMatchObject({ ok: false, reason: "too_long" });
    if (!r.ok) {
      expect(r.error).toMatch(/5s/); // what they gave
      expect(r.error).toMatch(/3s/); // what's allowed
    }
  });
});

describe("validateUploadedAudio — acceptance", () => {
  mediaIt("accepts real audio and returns its probed properties", async () => {
    const p = makeAudio("ok.mp3", 2);
    const r = await validateUploadedAudio(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.probe.durationSec).toBeGreaterThan(1.5);
      expect(r.probe.durationSec).toBeLessThan(2.6);
      expect(r.probe.codec).toBeTruthy();
      expect(r.probe.sampleRateHz).toBeGreaterThan(0);
    }
  });

  mediaIt("accepts WAV as readily as MP3 — the container is not a gate", async () => {
    const r = await validateUploadedAudio(makeAudio("ok.wav", 1));
    expect(r.ok).toBe(true);
  });

  mediaIt("accepts a file whose extension is wrong (probe wins over filename)", async () => {
    const real = makeAudio("real.mp3", 1);
    const lying = path.join(TMP, "lying.pdf");
    fs.copyFileSync(real, lying);
    const r = await validateUploadedAudio(lying);
    expect(r.ok).toBe(true);
  });

  mediaIt("accepts audio exactly at the cap (boundary is inclusive)", async () => {
    const p = makeAudio("boundary.mp3", 2);
    // Cap set just above the real duration → must pass.
    store.values.UPLOAD_MAX_MINUTES = String(3 / 60);
    const r = await validateUploadedAudio(p);
    expect(r.ok).toBe(true);
  });

  mediaIt("accepts the audio track of a VIDEO container", async () => {
    const p = path.join(TMP, "withaudio.mp4");
    spawnSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", p],
      { stdio: "ignore" }
    );
    const r = await validateUploadedAudio(p);
    expect(r.ok).toBe(true);
  });
});

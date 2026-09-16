import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for probeAudioStrict() — the VALIDATING probe.
 *
 * The whole point of this helper is that it rejects what probeDurationSafe() accepts:
 * safe-probe answers `size / 16000` for a corrupt file and never throws, which is right
 * for a mid-render pipeline but would let a renamed PDF through an upload gate.
 *
 * fluent-ffmpeg is mocked so every ffprobe outcome (error, no streams, silent video,
 * numeric-string fields, absent duration) is reproducible without shipping fixture media
 * or depending on a working ffprobe binary in CI.
 */

const probe = vi.hoisted(() => ({
  // what the fake ffprobe callback yields: [err, data]
  err: null as unknown,
  data: {} as unknown,
  throwSync: false,
  calls: [] as string[],
}));

vi.mock("fluent-ffmpeg", () => {
  const ffmpeg = {
    ffprobe: (file: string, cb: (err: unknown, data: unknown) => void) => {
      probe.calls.push(file);
      if (probe.throwSync) throw new Error("spawn ENOENT");
      cb(probe.err, probe.data);
    },
    setFfmpegPath: () => {},
    setFfprobePath: () => {},
  };
  return { default: ffmpeg };
});
vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("./audio-loudness", () => ({ masterLoudness: () => {} }));
// resolveFfprobe returning a bare name keeps ensureFfmpegPaths from touching the filesystem.
vi.mock("../ffmpeg-bin", () => ({ resolveFfmpeg: () => "ffmpeg", resolveFfprobe: () => "ffprobe" }));

import { probeAudioStrict, AudioProbeError, probeDurationSafe } from "./video-assemble";

const audioStream = { codec_type: "audio", codec_name: "mp3", sample_rate: 44100, channels: 2 };

beforeEach(() => {
  probe.err = null;
  probe.throwSync = false;
  probe.calls = [];
  probe.data = { streams: [audioStream], format: { duration: 125.5 } };
});

describe("probeAudioStrict — happy path", () => {
  it("returns duration plus the audio stream's real properties", async () => {
    const r = await probeAudioStrict("/tmp/voice.mp3");
    expect(r).toEqual({ durationSec: 125.5, codec: "mp3", sampleRateHz: 44100, channels: 2 });
  });

  it("probes the exact path it was given", async () => {
    await probeAudioStrict("/tmp/some file with spaces.m4a");
    expect(probe.calls).toEqual(["/tmp/some file with spaces.m4a"]);
  });

  it("accepts the audio track of a VIDEO container (extension proves nothing)", async () => {
    probe.data = {
      streams: [{ codec_type: "video", codec_name: "h264" }, { ...audioStream, codec_name: "aac" }],
      format: { duration: 42 },
    };
    const r = await probeAudioStrict("/tmp/clip.mp4");
    expect(r.durationSec).toBe(42);
    expect(r.codec).toBe("aac");
  });

  it("normalizes numeric-STRING ffprobe fields (build-dependent)", async () => {
    probe.data = {
      streams: [{ codec_type: "audio", codec_name: "flac", sample_rate: "48000", channels: "1" }],
      format: { duration: "9.75" },
    };
    const r = await probeAudioStrict("/tmp/a.flac");
    expect(r.durationSec).toBe(9.75);
    expect(r.sampleRateHz).toBe(48000);
    expect(r.channels).toBe(1);
  });

  it("reports null (not a wrong number) when stream metadata is absent", async () => {
    probe.data = { streams: [{ codec_type: "audio" }], format: { duration: 5 } };
    const r = await probeAudioStrict("/tmp/a.wav");
    expect(r).toEqual({ durationSec: 5, codec: null, sampleRateHz: null, channels: null });
  });
});

describe("probeAudioStrict — rejections (each carries a machine-readable reason)", () => {
  it("'unreadable' when ffprobe errors (corrupt file / not media)", async () => {
    probe.err = new Error("Invalid data found when processing input");
    await expect(probeAudioStrict("/tmp/notreally.mp3")).rejects.toThrow(AudioProbeError);
    await expect(probeAudioStrict("/tmp/notreally.mp3")).rejects.toMatchObject({ reason: "unreadable" });
  });

  it("'unreadable' when the ffprobe binary itself cannot be spawned", async () => {
    probe.throwSync = true; // a synchronous throw must not escape unwrapped
    await expect(probeAudioStrict("/tmp/a.mp3")).rejects.toMatchObject({ reason: "unreadable" });
  });

  it("'no_audio_stream' for a silent video", async () => {
    probe.data = { streams: [{ codec_type: "video", codec_name: "h264" }], format: { duration: 30 } };
    await expect(probeAudioStrict("/tmp/silent.mp4")).rejects.toMatchObject({ reason: "no_audio_stream" });
  });

  it("'no_audio_stream' when there are no streams at all", async () => {
    probe.data = { streams: [], format: { duration: 30 } };
    await expect(probeAudioStrict("/tmp/empty.mp3")).rejects.toMatchObject({ reason: "no_audio_stream" });
  });

  it("'no_audio_stream' when ffprobe omits the streams array entirely", async () => {
    probe.data = { format: { duration: 30 } };
    await expect(probeAudioStrict("/tmp/weird.mp3")).rejects.toMatchObject({ reason: "no_audio_stream" });
  });

  // These are the cases probeDurationSafe silently papers over with a size estimate.
  it.each([
    ["missing duration", { duration: undefined }],
    ["non-numeric duration", { duration: "N/A" }],
    ["zero duration", { duration: 0 }],
    ["negative duration", { duration: -3 }],
    ["Infinity (live stream)", { duration: Infinity }],
  ])("'no_duration' for %s — never a file-size guess", async (_label, format) => {
    probe.data = { streams: [audioStream], format };
    await expect(probeAudioStrict("/tmp/a.mp3")).rejects.toMatchObject({ reason: "no_duration" });
  });

  it("'no_duration' when format is missing altogether", async () => {
    probe.data = { streams: [audioStream] };
    await expect(probeAudioStrict("/tmp/a.mp3")).rejects.toMatchObject({ reason: "no_duration" });
  });

  it("checks the audio stream BEFORE the duration (most specific message wins)", async () => {
    probe.data = { streams: [{ codec_type: "video" }], format: {} }; // both would fail
    await expect(probeAudioStrict("/tmp/a.mp4")).rejects.toMatchObject({ reason: "no_audio_stream" });
  });

  it("throws a named, catchable error carrying a human-readable message", async () => {
    probe.data = { streams: [{ codec_type: "video" }], format: { duration: 1 } };
    const e = await probeAudioStrict("/tmp/a.mp4").catch((x) => x);
    expect(e).toBeInstanceOf(AudioProbeError);
    expect(e.name).toBe("AudioProbeError");
    expect(e.message).toMatch(/no audio track/i);
  });
});

describe("probeDurationSafe is UNCHANGED by this stage", () => {
  it("still never throws, and still estimates instead of failing", async () => {
    // The exact input that makes the strict probe reject must still resolve here.
    probe.err = new Error("Invalid data found when processing input");
    await expect(probeAudioStrict("/tmp/x.mp3")).rejects.toThrow();
    // statSync on a nonexistent path also fails → the final `return 1` guard.
    await expect(probeDurationSafe("/tmp/definitely-missing-file.mp3")).resolves.toBe(1);
  });

  it("the two helpers disagree by design on a corrupt file", async () => {
    probe.err = new Error("moov atom not found");
    const strict = await probeAudioStrict("/tmp/broken.mp4").then(() => "resolved", () => "rejected");
    const safe = await probeDurationSafe("/tmp/broken.mp4").then(() => "resolved", () => "rejected");
    expect(strict).toBe("rejected");
    expect(safe).toBe("resolved");
  });
});

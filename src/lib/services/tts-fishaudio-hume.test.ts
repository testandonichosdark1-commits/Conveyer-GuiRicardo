import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Fish Audio + Hume AI voiceover providers: request shape (auth, where the model goes,
 * where the voice goes), the per-channel voice override, the shared synchronous-TTS
 * transport's failure modes, and — the part a wrong assumption would silently get wrong —
 * each provider's BILLING UNIT.
 *
 * `fetch` and `fs` are stubbed throughout; no network, no disk, no DB.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../ffmpeg-bin", () => ({ resolveFfmpeg: () => "ffmpeg" }));
vi.mock("./video-assemble", () => ({ probeDurationSafe: async () => 12.5 }));
vi.mock("./labs69", () => ({ createTtsJob: vi.fn(), pollJob: vi.fn(), downloadJob: vi.fn() }));
vi.mock("./elevenlabs-voices", () => ({ isVoiceRejection: () => false, classifyVoiceError: async (m: string) => m }));
// noteCreditExhausted transitively pulls in run-lifecycle → db (a real SQLite open) — this
// file's whole point is "no disk, no DB", so it is mocked like every other side effect here.
vi.mock("./credit-exhaustion", () => ({ noteCreditExhausted: vi.fn(() => false) }));

const written: { path: string; bytes: number }[] = [];
vi.mock("node:fs", () => ({
  default: {
    writeFileSync: (p: string, b: Buffer) => written.push({ path: p, bytes: (b as Buffer).length }),
    unlinkSync: () => {},
  },
}));

const recordFishAudio = vi.fn();
const recordHume = vi.fn();
vi.mock("./cost-ledger", () => ({
  recordAi84: vi.fn(),
  recordFishAudio: (...a: unknown[]) => recordFishAudio(...a),
  recordHume: (...a: unknown[]) => recordHume(...a),
  // dispatchTts now meters the five TTS providers that previously recorded nothing.
  // This mock is exhaustive by necessity: a missing export throws at call time, not
  // at import, so it would surface as a confusing failure inside an unrelated test.
  recordTtsChars: vi.fn(),
  recordElevenlabs: vi.fn(),
}));

import { synthesizeFullScript } from "./tts";

/** A minimal but VALID mp3 body: an ID3 header is one of the two legal openings. */
function mp3Bytes(size = 64): Buffer {
  const b = Buffer.alloc(size);
  b.write("ID3", 0, "ascii");
  return b;
}
function audioResponse(buf: Buffer = mp3Bytes()): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "audio/mpeg" : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as Response;
}
function errorResponse(status: number, body: string, retryAfter?: string): Response {
  return {
    ok: false,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
    text: async () => body,
  } as unknown as Response;
}
/** A 200 whose body is JSON — an error served with the wrong status. */
function jsonAt200(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => body,
  } as unknown as Response;
}

function headersOf(mock: ReturnType<typeof vi.fn>, n = 0): Record<string, string> {
  return (mock.mock.calls[n][1] as RequestInit).headers as Record<string, string>;
}
function bodyOf(mock: ReturnType<typeof vi.fn>, n = 0) {
  return JSON.parse((mock.mock.calls[n][1] as RequestInit).body as string);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  written.length = 0;
  recordFishAudio.mockClear();
  recordHume.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const run = (provider: string, text = "Hello world.") =>
  synthesizeFullScript("run-1", text, "/tmp/vo.mp3", { provider });

describe("Fish Audio voiceover provider", () => {
  beforeEach(() => {
    settings.FISHAUDIO_API_KEY = "fk-test";
    settings.FISHAUDIO_VOICE_ID = "802e3bc2b27e49c2995d23ef70e6ac89";
  });

  it("posts to /v1/tts with Bearer auth, the voice as reference_id and mp3 output", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await run("fishaudio");

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.fish.audio/v1/tts");
    expect(headersOf(fetchMock).Authorization).toBe("Bearer fk-test");
    const body = bodyOf(fetchMock);
    expect(body.reference_id).toBe("802e3bc2b27e49c2995d23ef70e6ac89");
    expect(body.text).toBe("Hello world.");
    expect(body.format).toBe("mp3");
    expect(written).toHaveLength(1);
  });

  it("sends the backend model as an HTTP HEADER, never as a body field", async () => {
    // Fish selects the model via the `model` header; in the body it is silently ignored
    // and the account quietly stays on the default model.
    settings.FISHAUDIO_MODEL = "s1";
    fetchMock.mockResolvedValue(audioResponse());
    await run("fishaudio");

    expect(headersOf(fetchMock).model).toBe("s1");
    expect(bodyOf(fetchMock).model).toBeUndefined();
  });

  it("defaults the model to s2.1-pro and omits prosody when no speed is configured", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await run("fishaudio");
    expect(headersOf(fetchMock).model).toBe("s2.1-pro");
    expect(bodyOf(fetchMock).prosody).toBeUndefined();
  });

  it("sends a configured speed under prosody", async () => {
    settings.TTS_SPEED = "0.93";
    fetchMock.mockResolvedValue(audioResponse());
    await run("fishaudio");
    expect(bodyOf(fetchMock).prosody).toEqual({ speed: 0.93 });
  });

  it("lets a channel's voice override the global setting", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await synthesizeFullScript("run-1", "Hi.", "/tmp/vo.mp3", {
      provider: "fishaudio",
      voiceOverride: "channel-voice-id",
    });
    expect(bodyOf(fetchMock).reference_id).toBe("channel-voice-id");
  });

  it("METERS UTF-8 BYTES, not characters — the unit Fish actually bills", async () => {
    // Cyrillic is 2 bytes/char: metering `text.length` would under-report by half.
    fetchMock.mockResolvedValue(audioResponse());
    const text = "Привет"; // 6 characters, 12 UTF-8 bytes
    await run("fishaudio", text);
    expect(recordFishAudio).toHaveBeenCalledWith("run-1", 12);
    expect(recordFishAudio).not.toHaveBeenCalledWith("run-1", 6);
  });

  it("names the failure: bad key (401) and empty balance (402) are distinguishable", async () => {
    fetchMock.mockResolvedValue(errorResponse(401, JSON.stringify({ status: 401, message: "No permission" })));
    await expect(run("fishaudio")).rejects.toThrow(/Fish Audio rejected the API key.*FISHAUDIO_API_KEY/s);

    fetchMock.mockResolvedValue(errorResponse(402, JSON.stringify({ status: 402, message: "No payment" })));
    await expect(run("fishaudio")).rejects.toThrow(/Fish Audio has no credit left/);
  });

  it("explains a deleted/unavailable voice instead of echoing a status code", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, JSON.stringify({ message: "model not found" })));
    await expect(run("fishaudio")).rejects.toThrow(/could not find the voice "802e3bc2/);
  });

  it("refuses to run without a key or without a voice, naming the setting to fix", async () => {
    delete settings.FISHAUDIO_API_KEY;
    await expect(run("fishaudio")).rejects.toThrow(/FISHAUDIO_API_KEY is not set/);
    settings.FISHAUDIO_API_KEY = "fk-test";
    delete settings.FISHAUDIO_VOICE_ID;
    await expect(run("fishaudio")).rejects.toThrow(/No Fish Audio voice available/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Hume AI voiceover provider", () => {
  beforeEach(() => {
    settings.HUME_API_KEY = "hume-test";
    settings.HUME_VOICE_ID = "9e068547-5ba4-4c8e-8e03-69282a008f04";
  });

  it("posts to /v0/tts/file with the X-Hume-Api-Key header and the voice on the first utterance", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await run("hume");

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.hume.ai/v0/tts/file");
    expect(headersOf(fetchMock)["X-Hume-Api-Key"]).toBe("hume-test");
    const body = bodyOf(fetchMock);
    expect(body.utterances[0].voice).toEqual({ id: "9e068547-5ba4-4c8e-8e03-69282a008f04" });
    expect(body.utterances[0].text).toBe("Hello world.");
    expect(body.format).toEqual({ type: "mp3" });
  });

  it("stores a BARE voice id with no provider — the form that resolves for both HUME_AI and CUSTOM_VOICE", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await run("hume");
    expect(bodyOf(fetchMock).utterances[0].voice.provider).toBeUndefined();
    expect(bodyOf(fetchMock).utterances[0].voice.name).toBeUndefined();
  });

  it("omits `version` unless the operator pinned one, so Octave-2 voices keep working by default", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await run("hume");
    expect(bodyOf(fetchMock).version).toBeUndefined();

    fetchMock.mockClear();
    settings.HUME_VERSION = "2";
    fetchMock.mockResolvedValue(audioResponse());
    await run("hume");
    expect(bodyOf(fetchMock).version).toBe("2");
  });

  it("ignores a junk HUME_VERSION rather than sending an invalid enum", async () => {
    settings.HUME_VERSION = "octave-9";
    fetchMock.mockResolvedValue(audioResponse());
    await run("hume");
    expect(bodyOf(fetchMock).version).toBeUndefined();
  });

  it("clamps speed into Hume's supported range", async () => {
    settings.TTS_SPEED = "0.5"; // below Hume's 0.75 floor
    fetchMock.mockResolvedValue(audioResponse());
    await run("hume");
    expect(bodyOf(fetchMock).utterances[0].speed).toBe(0.75);
  });

  it("meters characters — Hume's billing unit", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await run("hume", "Привет");
    expect(recordHume).toHaveBeenCalledWith("run-1", 6);
  });

  it("turns an Octave version mismatch into an actionable message", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(400, JSON.stringify({ message: "voice is not compatible with octave 1" }))
    );
    await expect(run("hume")).rejects.toThrow(/Octave-2 voices only work with HUME_VERSION = 2/);
  });

  it("names a bad key instead of a bare status", async () => {
    fetchMock.mockResolvedValue(errorResponse(401, "unauthorized"));
    await expect(run("hume")).rejects.toThrow(/Hume rejected the API key.*HUME_API_KEY/s);
  });

  it("refuses to run without a key or without a voice", async () => {
    delete settings.HUME_API_KEY;
    await expect(run("hume")).rejects.toThrow(/HUME_API_KEY is not set/);
    settings.HUME_API_KEY = "hume-test";
    delete settings.HUME_VOICE_ID;
    await expect(run("hume")).rejects.toThrow(/No Hume voice available/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("shared synchronous-TTS transport", () => {
  beforeEach(() => {
    settings.FISHAUDIO_API_KEY = "fk-test";
    settings.FISHAUDIO_VOICE_ID = "v1";
  });

  it("rejects an empty audio body instead of writing a 0-byte voiceover", async () => {
    fetchMock.mockResolvedValue(audioResponse(Buffer.alloc(0)));
    await expect(run("fishaudio")).rejects.toThrow(/empty audio response/);
    expect(written).toHaveLength(0);
  });

  it("rejects a body that is not MP3, so a corrupt file can't become a plausible duration", async () => {
    // probeDurationSafe ESTIMATES from file size when ffprobe fails, so garbage bytes
    // would otherwise sail through as a real duration and desync every beat.
    fetchMock.mockResolvedValue(audioResponse(Buffer.from("not audio at all!!")));
    await expect(run("fishaudio")).rejects.toThrow(/not valid MP3 audio/);
    expect(written).toHaveLength(0);
  });

  it("surfaces an error that arrived with a 200 status and a JSON body", async () => {
    fetchMock.mockResolvedValue(jsonAt200('{"message":"quota exceeded"}'));
    await expect(run("fishaudio")).rejects.toThrow(/instead of audio.*quota exceeded/s);
  });

  it("retries a 429 honoring Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(errorResponse(429, "slow down", "1")).mockResolvedValue(audioResponse());
    const p = run("fishaudio");
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toMatchObject({ durationSec: 12.5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx and gives up with a named error after 4 attempts", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(errorResponse(503, "upstream down"));
    const p = run("fishaudio");
    const assertion = expect(p).rejects.toThrow(/Fish Audio TTS 503/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries a network fault and reports it as a network error, not a generic failure", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const p = run("fishaudio");
    const assertion = expect(p).rejects.toThrow(/Fish Audio TTS network error: ECONNRESET/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it("does NOT retry a permanent 4xx", async () => {
    fetchMock.mockResolvedValue(errorResponse(401, "nope"));
    await expect(run("fishaudio")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("existing providers are unaffected", () => {
  it("still rejects an unknown provider name", async () => {
    await expect(run("not-a-provider")).rejects.toThrow(/Unknown TTS provider: not-a-provider/);
  });

  it("routes elevenlabs through its own path, untouched by the new transport", async () => {
    settings.ELEVENLABS_API_KEY = "el-key";
    // The legacy ElevenLabs branch writes whatever bytes come back — no MP3 sniffing,
    // no retry wrapper — so a plain 200 with a body still succeeds exactly as before.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as Response);
    await expect(run("elevenlabs")).resolves.toMatchObject({ durationSec: 12.5 });
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.elevenlabs.io");
  });
});

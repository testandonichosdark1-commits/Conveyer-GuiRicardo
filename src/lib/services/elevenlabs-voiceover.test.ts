import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Unit tests for the ElevenLabs voiceover resilience layer (retry + classifier).
 * The module's heavy/DB-touching imports are mocked so the test is hermetic; only
 * `pLimit` (pure) stays real so the concurrency wrapper actually runs.
 */
const settings: Record<string, string> = { ELEVENLABS_RETRIES: "3", ELEVENLABS_CONCURRENCY: "5" };
const logCalls = vi.hoisted(() => [] as { level: string; message: string }[]);
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));
vi.mock("../logger", () => ({
  log: (_runId: string, level: string, message: string) => logCalls.push({ level, message }),
}));
vi.mock("./cost-ledger", () => ({ recordElevenlabs: () => {} }));
vi.mock("./tts", () => ({ synthesizeFullScript: async () => ({}) }));
vi.mock("./video-assemble", () => ({ probeDurationSafe: async () => 1 }));
vi.mock("../ffmpeg-bin", () => ({ resolveFfmpeg: () => "ffmpeg" }));

import { isTransientElevenLabsError, elevenlabsSynthesize } from "./elevenlabs-voiceover";

function res(opts: { ok: boolean; status?: number; json?: unknown; text?: string }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

describe("isTransientElevenLabsError", () => {
  it("treats 429 (concurrency cap) and 5xx as transient", () => {
    expect(isTransientElevenLabsError("ElevenLabs 429: too_many_concurrent_requests")).toBe(true);
    expect(isTransientElevenLabsError('ElevenLabs 500: {"detail":{"code":"service_unavailable"}}')).toBe(true);
    expect(isTransientElevenLabsError("ElevenLabs 503: unavailable")).toBe(true);
  });
  it("treats other 4xx (bad key/voice/quota) as permanent", () => {
    expect(isTransientElevenLabsError("ElevenLabs 401: unauthorized")).toBe(false);
    expect(isTransientElevenLabsError("ElevenLabs 400: bad request")).toBe(false);
    expect(isTransientElevenLabsError("ElevenLabs 422: quota_exceeded")).toBe(false);
  });
  it("treats timeouts and network drops as transient", () => {
    expect(isTransientElevenLabsError("ElevenLabs timeout after 120s")).toBe(true);
    expect(isTransientElevenLabsError("fetch failed")).toBe(true);
    expect(isTransientElevenLabsError("ECONNRESET")).toBe(true);
  });
  it("treats an unrecognized error as permanent (fail fast)", () => {
    expect(isTransientElevenLabsError("Unexpected end of JSON input")).toBe(false);
  });
});

describe("elevenlabsSynthesize (retry loop)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries a transient 500 and then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n < 2 ? res({ ok: false, status: 500, text: "service_unavailable" }) : res({ ok: true, json: { audio_base64: "abc" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = elevenlabsSynthesize("http://x", "{}", "key", "run", "chunk 1/1");
    await vi.runAllTimersAsync(); // advance through the backoff sleep
    const out = await p;
    expect(out.audio_base64).toBe("abc");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails fast on a permanent 401 without retrying", async () => {
    const fetchMock = vi.fn(async () => res({ ok: false, status: 401, text: "unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(elevenlabsSynthesize("http://x", "{}", "key", "run", "chunk 1/1")).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on a permanent error
  });

  it("throws after exhausting retries on a sustained transient failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => res({ ok: false, status: 503, text: "unavailable" }));
    vi.stubGlobal("fetch", fetchMock);
    const p = elevenlabsSynthesize("http://x", "{}", "key", "run", "chunk 1/1");
    const assertion = expect(p).rejects.toThrow(/503/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4); // ELEVENLABS_RETRIES=3 → 1 + 3 attempts
  });

  it("logs queue waits when a request has to wait for a busy slot (concurrency 1)", async () => {
    settings.ELEVENLABS_CONCURRENCY = "1"; // force the second request to queue
    logCalls.length = 0;
    let release: (r: Response) => void = () => {};
    const gate = new Promise<Response>((res) => { release = res; });
    let call = 0;
    const fetchMock = vi.fn((): Promise<Response> => {
      call++;
      return call === 1 ? gate : Promise.resolve(res({ ok: true, json: { audio_base64: "b" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const a = elevenlabsSynthesize("http://x", "{}", "k", "run", "A"); // holds the only slot
    const b = elevenlabsSynthesize("http://x", "{}", "k", "run", "B"); // must wait
    // Release A after a short real delay so B's measured wait is > the log threshold.
    setTimeout(() => release(res({ ok: true, json: { audio_base64: "a" } })), 150);
    await Promise.all([a, b]);

    const msgs = logCalls.map((l) => l.message);
    expect(msgs).toContain("ElevenLabs queue: waiting for available slot...");
    expect(msgs.some((m) => /^ElevenLabs queue: waited \d+\.\d+s before sending request\.$/.test(m))).toBe(true);
    settings.ELEVENLABS_CONCURRENCY = "5"; // restore for any later tests
  });
});

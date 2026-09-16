import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * AI84 voiceover provider — the transport invariants that two real failed runs exposed,
 * plus the request shape and the voice-rejection message.
 *
 * The three load-bearing ones, each tied to money or to a lost run:
 *   1. a transport fault while POLLING must NOT destroy a job we already paid for
 *      (a real run created a ~950-credit job, then died 78s later on `fetch failed`),
 *   2. the billable create POST must NOT be re-sent after OUR OWN timeout (double-bill),
 *   3. credits are metered when they are SPENT — at create — not after a successful
 *      download, or every failed run silently under-reports AI84 spend.
 *
 * `fetch` and `fs` are stubbed throughout; no network, no disk, no DB. Fake timers drive
 * the 3s poll interval and the transport's backoff.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../ffmpeg-bin", () => ({ resolveFfmpeg: () => "ffmpeg" }));
vi.mock("./video-assemble", () => ({ probeDurationSafe: async () => 12.5 }));
vi.mock("./labs69", () => ({ createTtsJob: vi.fn(), pollJob: vi.fn(), downloadJob: vi.fn() }));
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

const recordAi84 = vi.fn();
vi.mock("./cost-ledger", () => ({
  recordAi84: (...a: unknown[]) => recordAi84(...a),
  recordFishAudio: vi.fn(),
  recordHume: vi.fn(),
}));

import { synthesizeFullScript } from "./tts";

// ---------- response builders (shapes copied from the live API, 2026-08-12) ----------

/** Create returns 201 (not 200) with job_id + task_id + the credits it just charged. */
function createOk(jobId = "job-1", credits = 950): Response {
  return {
    ok: true,
    status: 201,
    headers: { get: () => null },
    json: async () => ({ success: true, job_id: jobId, task_id: "t-1", status: "queued", credit_cost: credits }),
  } as unknown as Response;
}
function pollJob(job: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ success: true, job }),
  } as unknown as Response;
}
function audioOk(size = 64): Response {
  const b = Buffer.alloc(size);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
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

/** What OUR timeout ceiling produces when it fires (the name is what isOurAbort reads). */
const timeoutError = () => new DOMException("operation timed out", "TimeoutError");
/** What Node's fetch produces on a network fault: generic message, real code in `cause`. */
function connError(code = "ECONNRESET"): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}

const posts = (m: ReturnType<typeof vi.fn>) =>
  m.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  settings.AI84_API_KEY = "ai84-key";
  settings.AI84_VOICE_ID = "yFgkuUnlOWx3k7ezUZQm";
  written.length = 0;
  recordAi84.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Drive a run to completion under fake timers (3s poll interval + transport backoff). */
async function runAi84(text = "Hello world.", voiceOverride?: string, modelOverride?: string) {
  vi.useFakeTimers();
  const p = synthesizeFullScript("run-1", text, "/tmp/vo.mp3", {
    provider: "ai84",
    voiceOverride,
    modelOverride,
  }).then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e })
  );
  await vi.runAllTimersAsync();
  return p;
}

describe("AI84 — surviving the network", () => {
  it("keeps polling through a transport fault instead of losing a job already paid for", async () => {
    // The exact shape of the real failure: create succeeds and bills ~950 credits, then a
    // poll dies with `fetch failed` / ECONNRESET. The job is still running on AI84's side.
    fetchMock
      .mockResolvedValueOnce(createOk())
      .mockRejectedValueOnce(connError())
      .mockRejectedValueOnce(connError())
      .mockRejectedValueOnce(connError())
      .mockRejectedValueOnce(connError())
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn.ai84.pro/a.mp3", credit_cost: 950 }))
      .mockResolvedValueOnce(audioOk());

    const r = await runAi84();

    expect(r.ok).toBe(true);
    expect(written).toHaveLength(1);
    // And the paid-for job was never re-created while recovering.
    expect(posts(fetchMock)).toHaveLength(1);
  });

  it("does NOT re-send the billable create POST after our own timeout", async () => {
    // A re-send could create — and charge for — a SECOND job we never saw the reply to.
    fetchMock.mockRejectedValue(timeoutError());

    const r = await runAi84();

    expect(r.ok).toBe(false);
    expect(posts(fetchMock)).toHaveLength(1);
  });

  it("DOES re-send the create when the socket never opened (no job can exist yet)", async () => {
    fetchMock
      .mockRejectedValueOnce(connError("ECONNREFUSED"))
      .mockResolvedValueOnce(createOk())
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 950 }))
      .mockResolvedValueOnce(audioOk());

    const r = await runAi84();

    expect(r.ok).toBe(true);
    expect(posts(fetchMock)).toHaveLength(2);
  });

  it("honors Retry-After on a 429 create without billing twice", async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, "slow down", "2"))
      .mockResolvedValueOnce(createOk("job-9", 950))
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 950 }))
      .mockResolvedValueOnce(audioOk());

    const r = await runAi84();

    expect(r.ok).toBe(true);
    expect(recordAi84).toHaveBeenCalledTimes(1);
    expect(recordAi84).toHaveBeenCalledWith("run-1", 950);
  });
});

describe("AI84 — metering credits when they are spent", () => {
  it("records the create charge even when the job then fails", async () => {
    // AI84 bills on create. Recording only after a successful download made /costs
    // understate AI84 by every failed run — both of the real ones, in fact.
    fetchMock
      .mockResolvedValueOnce(createOk("job-2", 950))
      .mockResolvedValueOnce(
        pollJob({
          status: "failed",
          errorMessageKey: "internal.VOICE_NOT_FOUND_LOCAL",
          errorMessage: "This voice is not available, please choose another one.",
        })
      );

    const r = await runAi84();

    expect(r.ok).toBe(false);
    expect(recordAi84).toHaveBeenCalledWith("run-1", 950);
    expect(written).toHaveLength(0);
  });

  it("records only the positive delta when the final cost is higher, and never double-counts", async () => {
    fetchMock
      .mockResolvedValueOnce(createOk("job-3", 900))
      .mockResolvedValueOnce(pollJob({ status: "processing" }))
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 950 }))
      .mockResolvedValueOnce(audioOk());

    await runAi84();

    expect(recordAi84.mock.calls).toEqual([
      ["run-1", 900],
      ["run-1", 50],
    ]);
  });

  it("never invents a credit-back when the final cost is lower", async () => {
    fetchMock
      .mockResolvedValueOnce(createOk("job-4", 950))
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 10 }))
      .mockResolvedValueOnce(audioOk());

    await runAi84();

    expect(recordAi84.mock.calls).toEqual([["run-1", 950]]);
  });
});

describe("AI84 — request shape", () => {
  it("posts to /v2/text-to-speech/async with xi-api-key and nested voice_settings", async () => {
    settings.AI84_MODEL = "eleven_turbo_v2_5";
    settings.TTS_SPEED = "5"; // out of range — must clamp to AI84's 0.5–2
    fetchMock
      .mockResolvedValueOnce(createOk())
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 1 }))
      .mockResolvedValueOnce(audioOk());

    await runAi84();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.ai84.pro/v2/text-to-speech/async");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("ai84-key");
    const body = JSON.parse(init.body as string);
    expect(body.voice_id).toBe("yFgkuUnlOWx3k7ezUZQm");
    expect(body.model_id).toBe("eleven_turbo_v2_5");
    expect(body.output_format).toBe("mp3_44100_128");
    expect(body.voice_settings.speed).toBe(2);
    // Auth travels on the poll and the id is URL-encoded into the path.
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.ai84.pro/v2/text-to-speech/async/job-1");
  });

  it("sends EXACTLY these keys on the ElevenLabs engine — pinned against drift", async () => {
    // The shape every AI84 install has been sending since the provider was added. The
    // MiniMax work is not a reason for a single key here to change: adding one risks a
    // rejection, dropping one silently changes how existing runs sound or are priced.
    settings.TTS_STYLE = "0.4";
    settings.TTS_STABILITY = "0.6";
    settings.TTS_SIMILARITY_BOOST = "0.7";
    settings.TTS_USE_SPEAKER_BOOST = "1";
    fetchMock
      .mockResolvedValueOnce(createOk())
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 1 }))
      .mockResolvedValueOnce(audioOk());

    await runAi84();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(Object.keys(body).sort()).toEqual(
      ["model_id", "output_format", "text", "voice_id", "voice_settings"].sort()
    );
    expect(Object.keys(body.voice_settings).sort()).toEqual(
      ["similarity_boost", "speed", "stability", "style", "use_speaker_boost"].sort()
    );
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.ai84.pro/v2/text-to-speech/async");
  });

  it("lets a channel voice override the global AI84_VOICE_ID", async () => {
    fetchMock
      .mockResolvedValueOnce(createOk())
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 1 }))
      .mockResolvedValueOnce(audioOk());

    await runAi84("Hello world.", "user_7744_voice_1786013694967");

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).voice_id).toBe("user_7744_voice_1786013694967");
  });
});

describe("AI84 — voice rejection message", () => {
  /** The verbatim failure from the client's run, and the id that produced it. */
  async function rejectedRun(voiceOverride?: string) {
    fetchMock.mockResolvedValueOnce(createOk("job-5", 950)).mockResolvedValueOnce(
      pollJob({
        status: "failed",
        errorMessageKey: "internal.VOICE_NOT_FOUND_LOCAL",
        errorMessage: "This voice is not available, please choose another one.",
      })
    );
    const r = await runAi84("Hello world.", voiceOverride);
    expect(r.ok).toBe(false);
    return (r as { e: Error }).e.message;
  }

  it("names the FULL voice id and the setting that holds it", async () => {
    settings.AI84_VOICE_ID = "user_7744_voice_1786013694967";
    const msg = await rejectedRun();

    // The whole id — the old log truncated it to 8 chars, which is why a real ticket
    // could not be diagnosed from the run log at all.
    expect(msg).toContain("user_7744_voice_1786013694967");
    expect(msg).toContain("AI84_VOICE_ID");
    // AI84's own words are preserved, not swallowed.
    expect(msg).toContain("This voice is not available");
  });

  it("points at the CHANNEL field when that is where the id came from", async () => {
    const msg = await rejectedRun("user_7744_voice_1786013694967");

    expect(msg).toMatch(/channel/i);
    expect(msg).not.toContain("AI84_VOICE_ID in /settings");
  });

  it("never blames ElevenLabs settings for an AI84 failure", async () => {
    // classifyVoiceError would send an AI84 key to api.elevenlabs.io and then tell the
    // operator to fix ELEVENLABS_VOICE_ID — a setting with nothing to do with this run.
    settings.AI84_VOICE_ID = "user_7744_voice_1786013694967";
    const msg = await rejectedRun();

    expect(msg).not.toContain("ELEVENLABS_VOICE_ID");
    expect(msg).not.toMatch(/ElevenLabs account/i);
  });

  it("flags an id that isn't even ElevenLabs-shaped, but only as an extra sentence", async () => {
    // An id of no recognised form: the shape hint is all we can honestly offer.
    settings.AI84_VOICE_ID = "not-a-known-id-form";
    expect(await rejectedRun()).toMatch(/20 letters\/digits/);

    // A well-shaped id that AI84 still rejects must NOT get the shape hint — the id form
    // is not the problem there, and a wrong guess must never misdirect the operator.
    recordAi84.mockClear();
    settings.AI84_VOICE_ID = "yFgkuUnlOWx3k7ezUZQm";
    expect(await rejectedRun()).not.toMatch(/20 letters\/digits/);
  });

  it("names the REAL cause when a cloned voice was sent to the ElevenLabs engine", async () => {
    // The client's exact case. The provider only says "choose another one"; the actionable
    // fact is that the MODEL has to change, not the voice — cloned voices live on MiniMax.
    settings.AI84_VOICE_ID = "user_7744_voice_1786013694967";
    settings.AI84_MODEL = "eleven_multilingual_v2";
    const msg = await rejectedRun();

    expect(msg).toMatch(/cloned voices only exist on AI84's MiniMax engine/);
    expect(msg).toMatch(/speech-2\.8-hd/);
    // The vague shape hint must give way to the precise cause, not stack on top of it.
    expect(msg).not.toMatch(/20 letters\/digits/);
  });

  it("does NOT call a valid MiniMax cloned voice 'not ElevenLabs-shaped'", async () => {
    // The regression this guards: on the MiniMax engine `user_…_voice_…` is CORRECT, so
    // both the shape hint and the mismatch advisory would be confidently wrong.
    settings.AI84_VOICE_ID = "user_7744_voice_1786013694967";
    settings.AI84_MODEL = "speech-2.8-hd";
    const msg = await rejectedRun();

    expect(msg).not.toMatch(/20 letters\/digits/);
    expect(msg).not.toMatch(/cloned voices only exist/);
    // MiniMax rejects an unknown voice before billing — say so, the operator's first
    // question is whether the failed attempt cost money.
    expect(msg).toMatch(/Nothing was charged for this attempt/);
  });
});

describe("AI84 — a per-run model", () => {
  /** MiniMax create answers 200 with no task_id (duplicated locally — see the block below). */
  const createOk200 = () =>
    ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true, job_id: "mm-1", status: "queued", credit_cost: 5 }),
    }) as unknown as Response;

  it("routes to MiniMax on the run's model even when the GLOBAL setting says ElevenLabs", async () => {
    // This is what makes two videos with different voices possible at the same time:
    // the run carries its own engine instead of racing the shared setting.
    settings.AI84_MODEL = "eleven_multilingual_v2";
    settings.AI84_VOICE_ID = "user_7744_voice_1786013694967";
    fetchMock
      .mockResolvedValueOnce(createOk200())
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 5 }))
      .mockResolvedValueOnce(audioOk());

    await runAi84("Hello world.", undefined, "speech-2.8-hd");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.ai84.pro/v1/minimax/text-to-speech/async");
    const body = JSON.parse(init.body as string);
    expect(body.model_id).toBe("speech-2.8-hd");
    expect(body.canonical_voice_id).toBe("user_7744_voice_1786013694967");
  });

  it("without an override the request is byte-identical to before — the regression guard", async () => {
    settings.AI84_MODEL = "eleven_multilingual_v2";
    fetchMock
      .mockResolvedValueOnce(createOk())
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 1 }))
      .mockResolvedValueOnce(audioOk());

    await runAi84();

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.ai84.pro/v2/text-to-speech/async");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body).toHaveProperty("voice_id");
    expect(body).not.toHaveProperty("canonical_voice_id");
  });

  it("ignores a blank override rather than sending an empty model", async () => {
    settings.AI84_MODEL = "eleven_multilingual_v2";
    fetchMock
      .mockResolvedValueOnce(createOk())
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 1 }))
      .mockResolvedValueOnce(audioOk());

    await runAi84("Hello world.", undefined, "   ");

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model_id).toBe("eleven_multilingual_v2");
  });
});

describe("AI84 — the MiniMax engine", () => {
  /** MiniMax create answers 200 (not 201) and carries no task_id. */
  function createOkMinimax(jobId = "mm-1", credits = 5): Response {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true, job_id: jobId, status: "queued", queued_at: "t", credit_cost: credits }),
    } as unknown as Response;
  }

  beforeEach(() => {
    settings.AI84_MODEL = "speech-2.8-hd";
    settings.AI84_VOICE_ID = "user_7744_voice_1786013694967";
  });

  it("posts to the MiniMax route with canonical_voice_id and flat speed", async () => {
    settings.TTS_SPEED = "1.1";
    // ElevenLabs-only tuning is set, and must NOT leak into the MiniMax body.
    settings.TTS_STYLE = "0.5";
    settings.TTS_STABILITY = "0.5";
    settings.TTS_SIMILARITY_BOOST = "0.5";
    settings.TTS_USE_SPEAKER_BOOST = "1";
    fetchMock
      .mockResolvedValueOnce(createOkMinimax())
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 5 }))
      .mockResolvedValueOnce(audioOk());

    await runAi84();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.ai84.pro/v1/minimax/text-to-speech/async");
    const body = JSON.parse(init.body as string);
    expect(body.canonical_voice_id).toBe("user_7744_voice_1786013694967");
    expect(body.speed).toBe(1.1);
    expect(body.model_id).toBe("speech-2.8-hd");
    // The whole point of two separate builders: no ElevenLabs field may appear here.
    expect(body).not.toHaveProperty("voice_id");
    expect(body).not.toHaveProperty("voice_settings");
    expect(body).not.toHaveProperty("style");
    expect(body).not.toHaveProperty("stability");
    expect(body).not.toHaveProperty("similarity_boost");
    expect(body).not.toHaveProperty("use_speaker_boost");
  });

  it("polls a MiniMax job on the SHARED v2 endpoint, and reads job_id without task_id", async () => {
    // This is what makes the whole design one code path: AI84 serves both kinds of job
    // through the same v2 poll, so nothing after create is duplicated.
    fetchMock
      .mockResolvedValueOnce(createOkMinimax("mm-42"))
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 5 }))
      .mockResolvedValueOnce(audioOk());

    const r = await runAi84();

    expect(r.ok).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.ai84.pro/v2/text-to-speech/async/mm-42");
    expect(written).toHaveLength(1);
  });

  it("meters the create charge on a 200 response, exactly as it does on 201", async () => {
    fetchMock
      .mockResolvedValueOnce(createOkMinimax("mm-2", 5))
      .mockResolvedValueOnce(pollJob({ status: "done", audioUrl: "https://cdn/a.mp3", credit_cost: 5 }))
      .mockResolvedValueOnce(audioOk());

    await runAi84();

    expect(recordAi84.mock.calls).toEqual([["run-1", 5]]);
  });

  it("does not bill, and does not retry, when create rejects the voice with 404", async () => {
    // MiniMax rejects an unknown voice before creating anything — no credits, one POST.
    fetchMock.mockResolvedValueOnce(
      errorResponse(404, '{"success":false,"error":"Voice not found","error_code":"VOICE_NOT_FOUND"}')
    );

    const r = await runAi84();

    expect(r.ok).toBe(false);
    expect((r as { e: Error }).e.message).toContain("user_7744_voice_1786013694967");
    expect(recordAi84).not.toHaveBeenCalled();
    expect(posts(fetchMock)).toHaveLength(1);
  });

  it("still refuses to re-send the billable create after our own timeout", async () => {
    fetchMock.mockRejectedValue(timeoutError());
    const r = await runAi84();
    expect(r.ok).toBe(false);
    expect(posts(fetchMock)).toHaveLength(1);
  });
});

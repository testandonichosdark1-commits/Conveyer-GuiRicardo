import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * ai33.pro voiceover provider — the request shape, the money, and the failure messages.
 *
 * ai33 is the first provider here whose contract could NOT be probed live (keys are issued
 * only to donors; the API document is behind Cloudflare + a login). These tests are what
 * stands in for that probe: they pin that the transport invariants two real AI84 failures
 * bought us are honoured here too, and that the parts we could not verify degrade into an
 * actionable message rather than a silent wrong result.
 *
 * The load-bearing ones:
 *   1. a transport fault while POLLING must not destroy a job already paid for,
 *   2. the billable create POST must not be re-sent after OUR OWN timeout,
 *   3. credits are recorded wherever they appear — at create OR on completion — because
 *      which of the two ai33 uses is one of the unverified facts,
 *   4. an unreadable payload comes back QUOTED, since the first real run is the probe.
 *
 * `fetch` and `fs` are stubbed; no network, no disk, no DB. Fake timers drive the 3s poll.
 * Relative imports on purpose: the `@/` alias is a Next path vitest does not resolve.
 */

const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));

const logs: { level: string; message: string }[] = [];
vi.mock("../logger", () => ({
  log: (_r: string, level: string, message: string) => logs.push({ level, message }),
}));
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

const recordAi33 = vi.fn();
vi.mock("./cost-ledger", () => ({
  recordAi33: (...a: unknown[]) => recordAi33(...a),
  recordAi84: vi.fn(),
  recordFishAudio: vi.fn(),
  recordHume: vi.fn(),
}));

import { synthesizeFullScript, __resetAi33UnbilledNotice } from "./tts";

// ---------- response builders ----------

function jsonOk(payload: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    headers: { get: () => null },
    json: async () => payload,
  } as unknown as Response;
}
function audioOk(size = 64, contentType = "audio/mpeg"): Response {
  const b = Buffer.alloc(size);
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null) },
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
const urls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => String(c[0]));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  settings.AI33_API_KEY = "ai33-key";
  settings.AI33_VOICE_ID = "edge:en-US-GuyNeural";
  written.length = 0;
  logs.length = 0;
  recordAi33.mockClear();
  __resetAi33UnbilledNotice();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function runAi33(text = "Hello world.", voiceOverride?: string) {
  vi.useFakeTimers();
  const p = synthesizeFullScript("run-1", text, "/tmp/vo.mp3", { provider: "ai33", voiceOverride }).then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e })
  );
  await vi.runAllTimersAsync();
  return p;
}

/** The happy path in the documented shape: create → one poll → download. */
function happyPath(credits: number | null = 120) {
  fetchMock
    .mockResolvedValueOnce(jsonOk({ task_id: "t-1", status: "queued" }))
    .mockResolvedValueOnce(
      jsonOk({ status: "done", audio_url: "https://cdn.openspeaker.ai/a.mp3", ...(credits === null ? {} : { credit_cost: credits }) })
    )
    .mockResolvedValueOnce(audioOk());
}

describe("ai33 — the request it sends", () => {
  it("creates, polls and downloads, writing the audio once", async () => {
    happyPath();
    const r = await runAi33();
    expect(r.ok).toBe(true);
    expect(written).toEqual([{ path: "/tmp/vo.mp3", bytes: 64 }]);
    expect(urls(fetchMock)[0]).toBe("https://api.openspeaker.ai/v3/text-to-speech");
    expect(urls(fetchMock)[1]).toBe("https://api.openspeaker.ai/v1/task/t-1");
  });

  it("sends the voice id VERBATIM, engine prefix and all", async () => {
    // The engine lives inside the id — that is the whole reason ai33 needs no engine
    // setting. Rewriting or stripping the id here would put the decision back in two places.
    happyPath();
    await runAi33();
    const body = JSON.parse(String(posts(fetchMock)[0][1]!.body));
    expect(body.voice_id).toBe("edge:en-US-GuyNeural");
    expect(body.text).toBe("Hello world.");
    expect(Object.keys(body).sort()).toEqual(["speed", "text", "voice_id"]);
  });

  it("authenticates with xi-api-key, not a Bearer token", async () => {
    happyPath();
    await runAi33();
    const headers = posts(fetchMock)[0][1]!.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("ai33-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("clamps speed to ai33's documented 0.5–1.5, which is NARROWER than AI84's", async () => {
    settings.TTS_SPEED = "2.0";
    happyPath();
    await runAi33();
    expect(JSON.parse(String(posts(fetchMock)[0][1]!.body)).speed).toBe(1.5);
  });

  it("honours AI33_BASE_URL, and tolerates a trailing slash", async () => {
    settings.AI33_BASE_URL = "https://api.ai33.pro/";
    happyPath();
    await runAi33();
    expect(urls(fetchMock)[0]).toBe("https://api.ai33.pro/v3/text-to-speech");
  });

  it("a channel voice wins over the global setting", async () => {
    happyPath();
    await runAi33("Hi.", "clone:my-voice");
    expect(JSON.parse(String(posts(fetchMock)[0][1]!.body)).voice_id).toBe("clone:my-voice");
  });

  it("refuses with no voice at all, before spending anything", async () => {
    settings.AI33_VOICE_ID = "";
    const r = await runAi33();
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ai33 — surviving the network", () => {
  it("keeps polling through a transport fault instead of losing a job already paid for", async () => {
    // The exact shape of a real AI84 failure: create succeeds and bills, then a poll dies
    // with `fetch failed`. The job is still running on the provider's side.
    fetchMock
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1" }))
      .mockRejectedValueOnce(connError())
      .mockRejectedValueOnce(connError())
      .mockRejectedValueOnce(connError())
      .mockRejectedValueOnce(connError())
      .mockResolvedValueOnce(jsonOk({ status: "done", audio_url: "https://cdn/a.mp3", credit_cost: 120 }))
      .mockResolvedValueOnce(audioOk());

    const r = await runAi33();

    expect(r.ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(posts(fetchMock)).toHaveLength(1); // never re-created
  });

  it("does NOT re-send the billable create POST after our own timeout", async () => {
    // A re-send could create — and charge for — a SECOND job whose reply we never saw.
    fetchMock.mockRejectedValue(timeoutError());
    const r = await runAi33();
    expect(r.ok).toBe(false);
    expect(posts(fetchMock)).toHaveLength(1);
  });

  it("DOES re-send the create when the socket never opened (no job can exist yet)", async () => {
    fetchMock
      .mockRejectedValueOnce(connError("ECONNREFUSED"))
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1" }))
      .mockResolvedValueOnce(jsonOk({ status: "done", audio_url: "https://cdn/a.mp3" }))
      .mockResolvedValueOnce(audioOk());
    const r = await runAi33();
    expect(r.ok).toBe(true);
    expect(posts(fetchMock)).toHaveLength(2);
  });

  it("honors Retry-After on a 429 create without billing twice", async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, "slow down", "2"))
      .mockResolvedValueOnce(jsonOk({ task_id: "t-9" }))
      .mockResolvedValueOnce(jsonOk({ status: "done", audio_url: "https://cdn/a.mp3" }))
      .mockResolvedValueOnce(audioOk());
    const r = await runAi33();
    expect(r.ok).toBe(true);
    expect(posts(fetchMock)).toHaveLength(2);
  });

  it("treats a 5xx while polling as 'still running'", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1" }))
      .mockResolvedValueOnce(errorResponse(503, "upstream"))
      .mockResolvedValueOnce(jsonOk({ status: "done", audio_url: "https://cdn/a.mp3" }))
      .mockResolvedValueOnce(audioOk());
    const r = await runAi33();
    expect(r.ok).toBe(true);
  });
});

describe("ai33 — the money, which is not hedged", () => {
  it("records credits reported at CREATE (AI84's billing moment)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1", credit_cost: 120 }))
      .mockResolvedValueOnce(jsonOk({ status: "done", audio_url: "https://cdn/a.mp3", credit_cost: 120 }))
      .mockResolvedValueOnce(audioOk());

    await runAi33();

    // Charged once for 120 — the create charge plus a ZERO delta, not a second 120.
    expect(recordAi33.mock.calls).toEqual([["run-1", 120]]);
  });

  it("records credits reported only on COMPLETION (the other possible billing moment)", async () => {
    // Which of the two ai33 uses is unverified, so both must land the same total.
    happyPath(120);
    await runAi33();
    expect(recordAi33.mock.calls).toEqual([["run-1", 120]]);
  });

  it("records a POSITIVE delta when the final figure is higher than the estimate", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1", credit_cost: 100 }))
      .mockResolvedValueOnce(jsonOk({ status: "done", audio_url: "https://cdn/a.mp3", credit_cost: 130 }))
      .mockResolvedValueOnce(audioOk());
    await runAi33();
    expect(recordAi33.mock.calls).toEqual([["run-1", 100], ["run-1", 30]]);
  });

  it("never invents a refund when the final figure is LOWER", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1", credit_cost: 100 }))
      .mockResolvedValueOnce(jsonOk({ status: "done", audio_url: "https://cdn/a.mp3", credit_cost: 40 }))
      .mockResolvedValueOnce(audioOk());
    await runAi33();
    expect(recordAi33.mock.calls).toEqual([["run-1", 100]]);
  });

  it("says out loud when NO credit figure came back, rather than reporting €0.00 of spend", async () => {
    // A confident zero over a whole run's narration is the reporting failure this codebase
    // treats as its worst. The video still ships; only the cost is unrecorded.
    happyPath(null);
    const r = await runAi33();
    expect(r.ok).toBe(true);
    expect(recordAi33).not.toHaveBeenCalled();
    const warn = logs.filter((l) => l.level === "warn" && l.message.includes("no credit figure"));
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toContain("t-1"); // the task id support would need
  });

  it("says it once per run, not once per chunk of a long script", async () => {
    // A long script is synthesized in several calls; a line each would bury the fact.
    happyPath(null);
    await runAi33();
    fetchMock.mockClear();
    happyPath(null);
    await runAi33();
    expect(logs.filter((l) => l.message.includes("no credit figure"))).toHaveLength(1);
  });
});

describe("ai33 — failures an operator can act on", () => {
  it("quotes the raw payload when the create reply has no task id", async () => {
    // The first real run IS the probe we could not perform — this line is what it buys.
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, ticket: "abc-123" }));
    const r = await runAi33();
    expect(r.ok).toBe(false);
    expect((r as { e: Error }).e.message).toContain("ticket");
    expect((r as { e: Error }).e.message).toContain("abc-123");
  });

  it("quotes the payload when a finished task carries no audio URL", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1" }))
      .mockResolvedValueOnce(jsonOk({ status: "completed", link: "s3://bucket/a.mp3" }));
    const r = await runAi33();
    expect(r.ok).toBe(false);
    expect((r as { e: Error }).e.message).toContain("s3://bucket/a.mp3");
  });

  it("refuses a download that served a page instead of audio", async () => {
    // The tolerant URL reading accepts a bare `url` as its last resort, so a self-link on
    // an unknown payload shape is possible. Writing that as "audio" would not fail loudly —
    // it would become a silently wrong duration, and every beat timing derives from it.
    fetchMock
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1" }))
      .mockResolvedValueOnce(jsonOk({ status: "done", url: "https://api.openspeaker.ai/v1/task/t-1" }))
      .mockResolvedValueOnce(audioOk(2048, "text/html; charset=utf-8"));
    const r = await runAi33();
    expect(r.ok).toBe(false);
    expect((r as { e: Error }).e.message).toContain("text/html");
    expect(written).toHaveLength(0);
  });

  it("names the voice, the field, and the engine-prefix rule when a voice is rejected", async () => {
    settings.AI33_VOICE_ID = "en-US-GuyNeural"; // bare — names no engine, and ai33 has six
    fetchMock
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1" }))
      .mockResolvedValueOnce(jsonOk({ status: "failed", error: "This voice is not available, please choose another one" }));

    const r = await runAi33();

    expect(r.ok).toBe(false);
    const msg = (r as { e: Error }).e.message;
    expect(msg).toContain("en-US-GuyNeural"); // the FULL id, never truncated
    expect(msg).toContain("AI33_VOICE_ID"); // the field that holds it
    expect(msg).toContain("carries no engine"); // the actual cause
    expect(msg).toContain("please choose another one"); // ai33's own words, preserved
  });

  it("does not accuse an already-qualified id of missing its engine", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1" }))
      .mockResolvedValueOnce(jsonOk({ status: "failed", error: "voice not found" }));
    const r = await runAi33();
    expect((r as { e: Error }).e.message).not.toContain("carries no engine");
  });

  it("says which field to fix when the channel's voice is the one that failed", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ task_id: "t-1" }))
      .mockResolvedValueOnce(jsonOk({ status: "failed", error: "voice not found" }));
    const r = await runAi33("Hi.", "vbee:nope");
    expect((r as { e: Error }).e.message).toContain("channel");
  });

  it("refuses with no API key, before any request", async () => {
    settings.AI33_API_KEY = "";
    const r = await runAi33();
    expect(r.ok).toBe(false);
    expect((r as { e: Error }).e.message).toContain("AI33_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

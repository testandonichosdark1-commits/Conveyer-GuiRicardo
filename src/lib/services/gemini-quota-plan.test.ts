import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WordTiming } from "./elevenlabs-voiceover";

/**
 * The client failure, reproduced through the REAL planner.
 *
 * A client turned the text mode ON, their Gemini key was out of quota, and they received a video
 * with zero cards. Nothing in the run said why: the ~170 individual 429s were each reported as a
 * local, recoverable-sounding fallback, and the run finished "done". These tests drive the actual
 * planBeats() path with the actual 429 body Google returned, and assert the run now states both
 * the cause (once) and the consequence.
 */

const captured = vi.hoisted(() => ({ lines: [] as { level: string; message: string }[] }));
const settingsStub = vi.hoisted(() => ({ overrides: {} as Record<string, string> }));

vi.mock("../settings", () => ({ getSetting: (k: string) => settingsStub.overrides[k] ?? "" }));
vi.mock("../logger", () => ({
  log: (_runId: string, level: string, message: string) => {
    captured.lines.push({ level, message });
  },
}));
vi.mock("./cost-ledger", () => ({ recordGemini: () => {} }));

const { planBeats } = await import("./studio-plan");
const { __resetGeminiQuotaNotice } = await import("./gemini-quota");

const w = (word: string, startMs: number, endMs: number): WordTiming => ({ word, startMs, endMs });
const NARRATION: WordTiming[] = [
  w("welcome", 0, 500), w("to", 500, 900), w("the", 900, 1200), w("greatest", 1200, 2000), w("ancient", 2000, 2800), w("wonders.", 2800, 4000),
  w("number", 5000, 5500), w("ten", 5500, 6000), w("is", 6000, 6300), w("the", 6300, 6600), w("great", 6600, 7200), w("wall.", 7200, 9000),
  w("it", 10000, 10400), w("stretches", 10400, 11200), w("thousands", 11200, 12200), w("of", 12200, 12500), w("miles.", 12500, 14000),
];

/** Byte-for-byte the body Google returned to the client, as our layer surfaces it. */
const QUOTA_BODY = JSON.stringify({
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Generate Content API requests' and limit 'Requests per day'",
    status: "RESOURCE_EXHAUSTED",
  },
});

const find = (needle: string) => captured.lines.filter((l) => l.message.includes(needle));

// The retry loop backs off 4s then 8s between attempts, per chunk — 12 real seconds of doing
// nothing, in a suite that otherwise runs in milliseconds. Fake ONLY setTimeout (the sleep
// callGemini uses) and drain it from a real setInterval, so the waits collapse while every
// await in the production path still resolves in its normal order.
let pump: ReturnType<typeof setInterval>;

beforeEach(() => {
  captured.lines.length = 0;
  __resetGeminiQuotaNotice();
  settingsStub.overrides = { GOOGLE_API_KEY: "test-key" };
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  pump = setInterval(() => vi.advanceTimersByTime(30_000), 1);
});

afterEach(() => {
  clearInterval(pump);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  settingsStub.overrides = {};
});

async function planWithQuotaExhausted(overlays: boolean) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(QUOTA_BODY, { status: 429 })));
  return planBeats(NARRATION, {
    secondsPerVisual: 4, avatarPercent: 0, realPercent: 100, hasAvatar: false,
    runId: "run", overlays, title: "Top 10 Ancient Wonders",
  });
}

describe("a run whose Gemini key is out of quota", () => {
  it("states the cause ONCE, as an error, naming the key to fix", async () => {
    await planWithQuotaExhausted(true);
    const notice = find("GEMINI UNAVAILABLE");
    expect(notice).toHaveLength(1); // every chunk 429s; the operator is told once
    expect(notice[0].level).toBe("error");
    expect(notice[0].message).toContain("GOOGLE_API_KEY");
  });

  it("states the consequence the operator actually complained about — no cards", async () => {
    const beats = await planWithQuotaExhausted(true);
    expect(beats.some((b) => b.overlay)).toBe(false); // the client's outcome, reproduced
    const warn = find("Text cards were requested");
    expect(warn).toHaveLength(1);
    expect(warn[0].level).toBe("warn");
    expect(warn[0].message).toContain("out of quota"); // blames the quota, not the feature
  });

  it("still delivers a usable plan — reporting must not break the run", async () => {
    const beats = await planWithQuotaExhausted(true);
    expect(beats.length).toBeGreaterThan(1);
    for (const b of beats) expect(typeof b.visualQuery).toBe("string");
  });

  it("says nothing about cards when the operator never asked for them", async () => {
    // Overlays OFF is the default path; a quota wall there costs footage quality, not cards.
    await planWithQuotaExhausted(false);
    expect(find("Text cards were requested")).toHaveLength(0);
    expect(find("GEMINI UNAVAILABLE")).toHaveLength(1); // the cause is still reported
  });
});

describe("a healthy run", () => {
  it("stays silent — no quota error, no missing-cards warning", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(
        [0, 1, 2, 3, 4, 5].map((i) => ({ index: i, visual_query: `query ${i}`, ai_media: "image", overlay: { type: "section", title: "the great wall" } }))
      ) }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }), { status: 200 })));
    const beats = await planBeats(NARRATION, {
      secondsPerVisual: 4, avatarPercent: 0, realPercent: 100, hasAvatar: false,
      runId: "run-ok", overlays: true, title: "Top 10 Ancient Wonders",
    });
    expect(beats.some((b) => b.overlay)).toBe(true);
    expect(find("GEMINI UNAVAILABLE")).toHaveLength(0);
    expect(find("Text cards were requested")).toHaveLength(0);
  });
});

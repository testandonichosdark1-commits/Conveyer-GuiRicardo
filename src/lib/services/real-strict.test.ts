import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";

/**
 * Real Footage Strict Mode ("Real footage only") — the guarantee is 0 AI-generated media.
 *
 * That guarantee is STRUCTURAL, not score-based: acquireVisual must never reach its
 * acquireAi() call for a strict beat. These tests pin exactly that, by starving every
 * provider (empty pool) — the worst case, where the old code would fall straight to AI —
 * and asserting strict throws instead, so the pipeline reuses a neighbouring real visual.
 *
 * The "accept a below-bar candidate" rung can't be unit-tested here: materialize() does a
 * real download + ffprobe/ffmpeg integrity probe. It's covered by the end-to-end check
 * (FINAL SOURCE RATIO → actual_ai=0) instead.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));

vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { acquireVisual, broadenQuery } from "./visual-source";
import type { Beat } from "./studio-plan";

const RUN = "real-strict-run";
const OUT = path.join(os.tmpdir(), `real-strict-${process.pid}.mp4`);

function beat(): Beat {
  return {
    index: 0,
    startMs: 0,
    endMs: 4000,
    text: "a nondescript widget on a bench",
    layout: "broll",
    visualQuery: "nondescript widget bench",
    source: "real",
  } as Beat;
}

/** Every provider answers "nothing found" — the pool is empty on every attempt. */
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  Object.assign(SETTINGS, {
    FOOTAGE_SOURCES: "pexels",
    PEXELS_API_KEY: "test-key",
    REAL_MATCH_THRESHOLD: "85",
    REAL_MEDIA: "auto",
    YT_DLP_ENABLED: "0", // keep the YouTube rung out of the unit test
    GOOGLE_API_KEY: "", // lexical scoring; no Gemini call
    AI_PROVIDER: "kie",
    KIE_API_KEY: "test-key",
  });
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ videos: [], photos: [], hits: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Drive the strict path past its bounded wait-and-retry without waiting in real time. */
async function runStrictStarved(): Promise<Error> {
  vi.useFakeTimers();
  const p = acquireVisual(RUN, beat(), OUT, new Set(), { strictReal: true }).then(
    () => null,
    (e: Error) => e
  );
  await vi.advanceTimersByTimeAsync(60_000);
  const err = await p;
  vi.useRealTimers();
  if (!err) throw new Error("expected acquireVisual to throw in strict mode");
  return err;
}

describe("Real footage only — never generates AI", () => {
  it("throws instead of falling back to AI when no real media is reachable", async () => {
    const err = await runStrictStarved();
    expect(err.message).toMatch(/Real-footage-only/);
    // The load-bearing assertion: no AI provider was ever contacted.
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /kie|labs69|magnific/i.test(u))).toBe(false);
  });

  it("retries once before giving up (a starved pool is usually a rate-limit spike)", async () => {
    await runStrictStarved();
    // Two full ladders ran, so pexels was searched on both passes — not a single give-up.
    const pexelsCalls = fetchSpy.mock.calls.filter((c) => /pexels/i.test(String(c[0]))).length;
    expect(pexelsCalls).toBeGreaterThan(1);
  });

  it("default (Allow AI fallback) is unchanged — still routes to AI", async () => {
    // No strictReal → the same starved beat must reach acquireAi. We only assert that it
    // GETS there: letting acquireAi finish would run kie's real retry/poll loops. The
    // promise is parked (kie will fail against the stub) — the fetch is the evidence.
    const parked = acquireVisual(RUN, beat(), OUT, new Set(), {}).catch(() => null);
    await vi.waitFor(
      () => expect(fetchSpy.mock.calls.some((c) => /kie/i.test(String(c[0])))).toBe(true),
      { timeout: 4000 }
    );
    void parked;
  });

  // The audit found REAL_MATCH_THRESHOLD does not gate real acceptance (it is a boolean in
  // disguise: >0 = Gemini scoring on, 0 = accept-all). Strict mode must NOT inherit that
  // defect — its guarantee is control-flow, not score. If someone later couples strict to
  // this setting, one of these fails.
  it.each(["85", "0"])("guarantee holds regardless of REAL_MATCH_THRESHOLD=%s", async (threshold) => {
    SETTINGS.REAL_MATCH_THRESHOLD = threshold;
    const err = await runStrictStarved();
    expect(err.message).toMatch(/Real-footage-only/);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => /kie|labs69|magnific/i.test(u))).toBe(false);
  });
});

describe("broadenQuery — strict-only level 3", () => {
  it("collapses to the single most salient token", () => {
    expect(broadenQuery("Rwanda genocide memorial site", 3)).toBe("Rwanda");
  });

  it("is a no-op for an already-single-token query (retry is then skipped)", () => {
    expect(broadenQuery("Rwanda", 3)).toBe("Rwanda");
  });

  it("leaves the existing levels untouched", () => {
    const q = "Rwanda genocide memorial site";
    expect(broadenQuery(q, 0)).toBe(q); // level 0 = verbatim
    expect(broadenQuery(q, 1)).not.toBe(""); // level 1/2 unchanged by this patch
    expect(broadenQuery(q, 2)).not.toBe("");
  });
});

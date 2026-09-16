import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";

/**
 * The stock-surrender gate.
 *
 * The defect: "stock does not have this" was decided from a SINGLE gather, on attempt 0 —
 * the planner's own query, which is the most abstract of the three the broaden ladder will
 * try. Attempts 1 and 2 existed but could never run for these beats, so the judgement was
 * made on the worst of the three phrasings and the beat went straight to paid generation.
 *
 * The fix is not to remove the gate — it is what keeps hopeless queries from grinding
 * through three fan-outs — but to require more evidence before it fires.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("./cost-ledger", () => {
  const noop = () => {};
  return {
    recordStoryblocksDownload: noop, recordGoogleCseQuery: noop, recordGemini: noop,
    recordKieImage: noop, recordKieVeo: noop, recordLabs69: noop, recordLabs69Image: noop,
    recordMagnificImage: noop, recordMagnificVideo: noop, recordHiggsfieldImage: noop,
    recordHiggsfieldVideo: noop, recordRunwareImage: noop,
  };
});

import { acquireVisual, __testing, type ProviderHit } from "./visual-source";
import type { Beat } from "./studio-plan";

const { weakPoolVerdict } = __testing;

/** An openverse still: no video, weight -2, so heuristicScore is -1 → a "weak" pool. */
const weakPool: ProviderHit[] = [
  { kind: "image", provider: "openverse", url: "https://e.test/f/a.jpg", dedupeId: "openverse:a", thumbUrl: "https://e.test/t/a.jpg" },
];
/** A pexels video: the pool is not weak the moment any video is present. */
const strongPool: ProviderHit[] = [
  { kind: "video", provider: "pexels", url: "https://e.test/f/b.mp4", dedupeId: "pexels:b", thumbUrl: "https://e.test/t/b.jpg" },
];

describe("weakPoolVerdict", () => {
  const base = { attempt: 0, weakSoFar: true, strict: false, entityProtected: false, pool: weakPool };

  it("broadens rather than surrendering on the planner's first query", () => {
    expect(weakPoolVerdict(base)).toBe("broaden");
  });

  it("gives up only once a broadened attempt is ALSO weak", () => {
    expect(weakPoolVerdict({ ...base, attempt: 1 })).toBe("route-ai");
    expect(weakPoolVerdict({ ...base, attempt: 2 })).toBe("route-ai");
  });

  it("does not give up when an earlier attempt found a strong pool", () => {
    // Broadening deliberately makes a query vaguer, so a weak pool that FOLLOWS a strong one
    // says something about the broadened phrasing, not about stock's coverage.
    expect(weakPoolVerdict({ ...base, attempt: 1, weakSoFar: false })).toBe("score");
  });

  it("never fires for a strong pool, at any attempt", () => {
    expect(weakPoolVerdict({ ...base, pool: strongPool })).toBe("score");
    expect(weakPoolVerdict({ ...base, attempt: 2, pool: strongPool })).toBe("score");
  });

  it("never fires in strict mode, where giving up would mean AI", () => {
    expect(weakPoolVerdict({ ...base, strict: true })).toBe("score");
    expect(weakPoolVerdict({ ...base, attempt: 1, strict: true })).toBe("score");
  });

  it("never fires for a beat naming a specific subject", () => {
    expect(weakPoolVerdict({ ...base, entityProtected: true })).toBe("score");
    expect(weakPoolVerdict({ ...base, attempt: 1, entityProtected: true })).toBe("score");
  });
});

describe("acquireReal — a weak pool earns a second query", () => {
  const OUT = path.join(os.tmpdir(), `weak-${process.pid}.mp4`);
  let urls: string[];

  beforeEach(() => {
    for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
    Object.assign(SETTINGS, {
      FOOTAGE_SOURCES: "openverse", // image-only, low weight → every pool is "weak"
      GOOGLE_API_KEY: "",
      REAL_MATCH_THRESHOLD: "85",
      REAL_MEDIA: "auto",
      YT_DLP_ENABLED: "0",
      TOPIC_POOL: "0",
      AI_PROVIDER: "kie",
      KIE_API_KEY: "", // unconfigured → the AI rung fails immediately instead of retrying
    });
    urls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String((input as { url?: string })?.url ?? input);
        urls.push(url);
        if (url.includes("api.openverse.org")) {
          // Off-topic on purpose: nothing here can clear a bar, so the ONLY question the
          // test asks is how many times the ladder was willing to look.
          return new Response(
            JSON.stringify({
              results: [{ id: "a", url: "https://e.test/f/a.jpg", thumbnail: "https://e.test/t/a.jpg", foreign_landing_url: "https://ov.test/kitchen-sink" }],
            }),
            { status: 200 }
          );
        }
        return new Response("no", { status: 404 });
      }) as unknown as typeof fetch
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("searches again on a broadened query instead of routing to AI on the first look", async () => {
    const beat = {
      index: 0,
      startMs: 0,
      endMs: 4000,
      text: "old rusty metal gears turning slowly in a workshop",
      layout: "broll",
      // Lowercase and generic: no capital letter, so the entity protection does not apply
      // and the gate is genuinely live. It also has to be a query broadenQuery actually
      // CHANGES (it leads with descriptors) — otherwise the retry is skipped as a duplicate
      // and this would measure the deduper, not the gate.
      visualQuery: "aerial view rusty industrial gears turning slowly workshop",
      source: "real",
    } as Beat;

    vi.useFakeTimers();
    const p = acquireVisual("weak-run", beat, OUT, new Set(), {}).catch(() => null);
    await vi.advanceTimersByTimeAsync(120_000);
    await p;
    vi.useRealTimers();

    const searches = urls.filter((u) => u.includes("api.openverse.org"));
    expect(searches.length).toBeGreaterThanOrEqual(2);
    // ...and the broadened attempt really was a DIFFERENT query, not a repeat.
    expect(new Set(searches).size).toBeGreaterThanOrEqual(2);
  });
});

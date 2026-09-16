import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";

/**
 * The reserve tier — candidates the pre-Gemini cut set aside, spent before the beat gives up.
 *
 * The defect: an attempt gathers up to SOURCE_POOL_MAX candidates but can only send
 * MAX_GEMINI_CANDIDATES to the scorer. The remainder were discarded outright, so a beat could
 * go and pay for AI generation while a matching real clip it had already fetched sat unused
 * in memory. That is the same class as the "duplicate became the last resort rather than the
 * first" fix, one step earlier in the path.
 *
 * The reserve is deliberately NOT a relaxation of the bar: it is what the cut judged weakest,
 * so admitting anything that merely exists would trade a generated image for a bad real one.
 * A candidate still has to match the query, on the lexical bars the pipeline already trusts
 * whenever Gemini is unavailable.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
// Metering writes to the real SQLite ledger; these tests are about routing, not cost.
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

const { reserveCandidates } = __testing;

const QUERY = "colosseum aerial rome";

function hit(provider: string, kind: "video" | "image", id: string, slug: string): ProviderHit {
  return {
    kind,
    provider,
    url: `https://e.test/f/${id}.${kind === "video" ? "mp4" : "jpg"}`,
    dedupeId: id,
    sourceUrl: `https://e.test/p/${slug}`,
    thumbUrl: `https://e.test/t/${id}.jpg`,
  };
}

describe("reserveCandidates", () => {
  it("admits a held-back candidate that matches the scene", () => {
    const match = hit("archive", "image", "archive:1", "colosseum-aerial-rome");
    expect(reserveCandidates([match], QUERY, new Set()).map((c) => c.hit)).toEqual([match]);
  });

  it("rejects a held-back candidate that matches nothing", () => {
    // The whole point: the bar is not lowered, so an irrelevant real clip does NOT
    // displace AI generation.
    const miss = hit("archive", "image", "archive:2", "kitchen-sink-tap-water");
    expect(reserveCandidates([miss], QUERY, new Set())).toEqual([]);
  });

  it("orders admitted candidates by rankKey, preferring video and stronger sources", () => {
    const still = hit("wikimedia", "image", "wikimedia:1", "colosseum-aerial-rome");
    const video = hit("pexels", "video", "pexels:1", "colosseum-aerial-rome");
    expect(reserveCandidates([still, video], QUERY, new Set()).map((c) => c.hit.dedupeId)).toEqual([
      "pexels:1",
      "wikimedia:1",
    ]);
  });

  it("never re-offers a candidate another beat already took", () => {
    const taken = hit("archive", "image", "archive:3", "colosseum-aerial-rome");
    expect(reserveCandidates([taken], QUERY, new Set([taken.dedupeId]))).toEqual([]);
  });

  it("holds a video to the video bar and a still to the stricter image bar", () => {
    // A 2-of-3 token match scores ~86.7 with the leading-token boost: enough for a video
    // (65) and for an image (80) — but a bare 1-of-3 match clears neither.
    const weakVideo = hit("pexels", "video", "pexels:2", "rome");
    const weakStill = hit("wikimedia", "image", "wikimedia:2", "rome");
    expect(reserveCandidates([weakVideo, weakStill], QUERY, new Set())).toEqual([]);
  });
});

/**
 * Route-level: the reserve must actually be REACHED before the beat routes to AI.
 *
 * Asserted on the download ATTEMPT, not on success — materialize() does a real download plus
 * an ffprobe integrity pass, which real-strict.test.ts already documents as untestable at
 * unit level. The attempt is the whole claim: before this change no held-back candidate was
 * ever requested, because it had been discarded.
 */
describe("acquireReal — the reserve is spent before AI", () => {
  const OUT = path.join(os.tmpdir(), `reserve-${process.pid}.mp4`);
  let fetchSpy: ReturnType<typeof vi.fn>;
  let urls: string[];

  /** Fifteen candidates across three sources, ALL matching the query equally. The cut keeps
   *  ten on provenance (5 pexels videos + 5 wikimedia stills) and holds the openverse stills
   *  back — matching, usable, and previously thrown away. */
  const n = (i: number) => String(i);
  beforeEach(() => {
    for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
    Object.assign(SETTINGS, {
      FOOTAGE_SOURCES: "pexels,wikimedia,openverse",
      PEXELS_API_KEY: "test-key",
      GOOGLE_API_KEY: "test-key", // required for the prefilter to run at all
      REAL_MATCH_THRESHOLD: "85",
      REAL_MEDIA: "auto",
      YT_DLP_ENABLED: "0",
      AI_PROVIDER: "kie",
      KIE_API_KEY: "test-key",
      TOPIC_POOL: "0",
    });
    urls = [];
    fetchSpy = vi.fn(async (input: unknown) => {
      const url = String((input as { url?: string })?.url ?? input);
      urls.push(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

      if (url.includes("api.pexels.com")) {
        return json({
          videos: Array.from({ length: 5 }, (_, i) => ({
            id: i,
            duration: 20,
            image: `https://e.test/t/pexels${i}.jpg`,
            url: `https://www.pexels.com/video/colosseum-aerial-rome-${n(i)}/`,
            video_files: [{ file_type: "video/mp4", height: 1080, width: 1920, link: `https://e.test/f/pexels${i}.mp4` }],
          })),
        });
      }
      if (url.includes("commons.wikimedia.org")) {
        return json({
          query: {
            pages: Object.fromEntries(
              Array.from({ length: 5 }, (_, i) => [
                n(i),
                {
                  title: `File:Colosseum aerial rome ${i}.jpg`,
                  imageinfo: [
                    {
                      mime: "image/jpeg",
                      url: `https://e.test/f/wiki${i}.jpg`,
                      thumburl: `https://e.test/t/wiki${i}.jpg`,
                      descriptionurl: `https://commons.wikimedia.org/wiki/colosseum-aerial-rome-${n(i)}`,
                    },
                  ],
                },
              ])
            ),
          },
        });
      }
      if (url.includes("api.openverse.org")) {
        return json({
          results: Array.from({ length: 5 }, (_, i) => ({
            id: `ov${i}`,
            url: `https://e.test/f/openverse${i}.jpg`,
            thumbnail: `https://e.test/t/openverse${i}.jpg`,
            foreign_landing_url: `https://openverse.test/colosseum-aerial-rome-${n(i)}`,
          })),
        });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        // Everything the scorer sees is judged unusable, so the beat would otherwise go to AI.
        const scores = Array.from({ length: 10 }, (_, i) => ({ i, score: 10 }));
        return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(scores) }] } }], usageMetadata: {} });
      }
      if (url.startsWith("https://e.test/t/")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      // Candidate downloads (including the held-back ones) and anything else: fail fast.
      return new Response("no", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests a held-back openverse candidate that the cut never scored", async () => {
    const beat = {
      index: 0,
      startMs: 0,
      endMs: 4000,
      text: "the colosseum seen from above",
      layout: "broll",
      visualQuery: QUERY,
      source: "real",
    } as Beat;

    // strictReal drives the same ladder but forbids AI, so the run ends in a throw instead
    // of hanging in the generator's retry/backoff. The reserve sits before every strict-only
    // rung, so this exercises exactly the branch under test. Fake timers skip the bounded
    // waits (download backoff, the strict re-try pause) without waiting in real time.
    vi.useFakeTimers();
    const p = acquireVisual("reserve-run", beat, OUT, new Set(), { strictReal: true }).catch(() => null);
    await vi.advanceTimersByTimeAsync(120_000);
    await p;
    vi.useRealTimers();

    const heldBack = urls.filter((u) => u.startsWith("https://e.test/f/openverse"));
    expect(heldBack.length).toBeGreaterThan(0);
  });
});

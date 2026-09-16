import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

/**
 * Storyblocks provider — the pure logic, plus the multi-key rotation.
 *
 * The three behaviours worth pinning are the ones that were MEASURED against the live
 * API rather than read in docs, because they are the reasons this provider is written
 * the way it is:
 *   1. the video search answers a long query with a ~32-item off-topic pool, never zero;
 *   2. that pool is capped, so it can be told apart from a genuinely small real result;
 *   3. two common words are answered honestly, and a rare word is not.
 * Every "must reject" case below is paired with a "must accept" control, so a guard that
 * simply rejected everything would fail the second half.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import {
  pickDownloadUrl,
  parseKeyPairs,
  signedUrl,
  toShortQuery,
  looksLikeFallback,
  storyblocksSearch,
  beginStoryblocksRun,
  reserveDownload,
  __testing,
  __runBudget,
} from "./storyblocks";

beforeEach(() => {
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  __testing.keyPool.keys = [];
  __testing.keyPool.cursor = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseKeyPairs — several accounts, one pair per line", () => {
  it("parses one pair", () => {
    expect(parseKeyPairs("pub1:priv1")).toEqual([{ pub: "pub1", priv: "priv1" }]);
  });

  it("parses several pairs and trims whitespace", () => {
    expect(parseKeyPairs("  pub1:priv1  \n pub2:priv2 \n")).toEqual([
      { pub: "pub1", priv: "priv1" },
      { pub: "pub2", priv: "priv2" },
    ]);
  });

  it("splits on the FIRST colon only, so a private key may contain colons", () => {
    expect(parseKeyPairs("pub:a:b:c")).toEqual([{ pub: "pub", priv: "a:b:c" }]);
  });

  it("drops malformed lines instead of producing a half-key", () => {
    // A pair with no colon cannot be signed with, and a silent half-key would fail
    // every request with an opaque HMAC error.
    expect(parseKeyPairs("nokeyhere\npub2:priv2\n:onlypriv\npub3:")).toEqual([{ pub: "pub2", priv: "priv2" }]);
  });

  it("is empty for an empty setting", () => {
    expect(parseKeyPairs("")).toEqual([]);
    expect(parseKeyPairs("   \n  ")).toEqual([]);
  });
});

describe("signedUrl", () => {
  it("signs the RESOURCE PATH with secret+expires, matching the live API contract", () => {
    // Reproduces the recipe independently rather than re-calling the function, so a
    // change to the algorithm fails here rather than silently 400ing in production.
    const url = new URL(signedUrl("PUB", "SECRET", "/api/v2/videos/search", { keywords: "x" }, 1_000_000));
    const expires = url.searchParams.get("EXPIRES")!;
    const expected = crypto.createHmac("sha256", `SECRET${expires}`).update("/api/v2/videos/search").digest("hex");
    expect(url.searchParams.get("HMAC")).toBe(expected);
    expect(url.searchParams.get("APIKEY")).toBe("PUB");
    expect(url.origin + url.pathname).toBe("https://api.storyblocks.com/api/v2/videos/search");
  });

  it("keeps EXPIRES inside the API's 36-hour ceiling", () => {
    const url = new URL(signedUrl("P", "S", "/api/v2/videos/search", {}, 1_000_000));
    const ahead = Number(url.searchParams.get("EXPIRES")) - 1_000_000;
    expect(ahead).toBeGreaterThan(0);
    expect(ahead).toBeLessThan(36 * 3600);
  });

  it("CONTROL: a different secret produces a different signature", () => {
    const a = new URL(signedUrl("P", "S1", "/api/v2/videos/search", {}, 1_000_000)).searchParams.get("HMAC");
    const b = new URL(signedUrl("P", "S2", "/api/v2/videos/search", {}, 1_000_000)).searchParams.get("HMAC");
    expect(a).not.toBe(b);
  });
});

describe("toShortQuery — the measured 2-word rule", () => {
  it("reduces a long planner query to its last two content words", () => {
    // Measured: the long form returns a 31-item off-topic pool; "engine bay" returns 327.
    expect(toShortQuery("Cummins 12 valve diesel engine bay close up")).toBe("engine bay");
  });

  it("drops the brand and the number", () => {
    // "Cummins" alone returns four clips of people surnamed Cummings — worse than useless.
    expect(toShortQuery("Cummins 12 valve diesel engine bay close up")).not.toContain("cummins");
    expect(toShortQuery("Cummins 12 valve diesel engine bay close up")).not.toContain("12");
  });

  it("keeps the head of the noun phrase, not the adjectives", () => {
    expect(toShortQuery("dried mummified spiders inside mud dauber nest")).toBe("dauber nest");
  });

  it("can be asked for a single word", () => {
    expect(toShortQuery("man walking through snowy forest at dusk", 1)).toBe("dusk");
  });

  it("returns empty when there is nothing but noise", () => {
    expect(toShortQuery("the a of in on at")).toBe("");
    expect(toShortQuery("")).toBe("");
  });
});

describe("looksLikeFallback — telling the off-topic pool from a real small result", () => {
  it("flags the measured fallback shape (small total, page came back short)", () => {
    expect(looksLikeFallback(32, 32, 50)).toBe(true);
    expect(looksLikeFallback(31, 31, 50)).toBe(true);
  });

  it("CONTROL: does NOT flag a big genuine result", () => {
    expect(looksLikeFallback(327, 50, 50)).toBe(false);
    expect(looksLikeFallback(10000, 50, 50)).toBe(false);
  });

  it("CONTROL: does NOT flag a genuinely small result that FILLED its page", () => {
    // A real rare subject with 30 clips fills a 30-slot page; the fallback never fills one.
    expect(looksLikeFallback(30, 30, 30)).toBe(false);
  });

  it("does not flag an honest zero — that is a real answer, not a fallback", () => {
    expect(looksLikeFallback(0, 0, 50)).toBe(false);
  });

  it("refuses to judge when we did not ask for more than the cap", () => {
    // Without asking for >34 there is no way to see the cap, so it must not guess.
    expect(looksLikeFallback(32, 32, 20)).toBe(false);
  });
});

describe("the run download budget", () => {
  it("0 means NO limit — the default, so an on-by-default source is not silently dead", () => {
    SETTINGS.STORYBLOCKS_MAX_DOWNLOADS_PER_RUN = "0";
    beginStoryblocksRun();
    for (let i = 0; i < 500; i++) expect(reserveDownload()).toBe(true);
  });

  it("an unset setting behaves the same as 0", () => {
    beginStoryblocksRun();
    expect(reserveDownload()).toBe(true);
  });

  it("allows exactly the cap, then refuses", () => {
    SETTINGS.STORYBLOCKS_MAX_DOWNLOADS_PER_RUN = "3";
    beginStoryblocksRun();
    expect([reserveDownload(), reserveDownload(), reserveDownload()]).toEqual([true, true, true]);
    expect(reserveDownload()).toBe(false);
    expect(__runBudget.used()).toBe(3);
  });

  it("resets between runs so budget cannot leak", () => {
    SETTINGS.STORYBLOCKS_MAX_DOWNLOADS_PER_RUN = "2";
    beginStoryblocksRun();
    reserveDownload();
    reserveDownload();
    expect(reserveDownload()).toBe(false);
    beginStoryblocksRun();
    expect(reserveDownload()).toBe(true);
  });
});

describe("storyblocksSearch — rotation and failure behaviour", () => {
  function stubFetch(handler: (url: string) => { status?: number; body?: unknown }) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        calls.push(url);
        const r = handler(url);
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
      }) as unknown as typeof fetch
    );
    return calls;
  }
  const realPage = { total_results: 300, results: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, title: `clip ${i}` })) };

  it("returns [] with no keys configured, without calling the API", () => {
    const calls = stubFetch(() => ({ body: realPage }));
    SETTINGS.STORYBLOCKS_MAX_DOWNLOADS_PER_RUN = "5";
    beginStoryblocksRun();
    return storyblocksSearch("diesel engine bay").then((r) => {
      expect(r).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  it("returns hits from the first key", async () => {
    SETTINGS.STORYBLOCKS_API_KEYS = "pubA:privA";
    SETTINGS.STORYBLOCKS_MAX_DOWNLOADS_PER_RUN = "5";
    beginStoryblocksRun();
    const calls = stubFetch(() => ({ body: realPage }));
    const r = await storyblocksSearch("diesel engine bay");
    expect(r.length).toBe(50);
    expect(calls[0]).toContain("APIKEY=pubA");
    expect(r[0].downloadUrl).toContain("/stock-item/download/1");
  });

  it("ROTATES to the second key after the first is denied", async () => {
    SETTINGS.STORYBLOCKS_API_KEYS = "pubA:privA\npubB:privB";
    SETTINGS.STORYBLOCKS_MAX_DOWNLOADS_PER_RUN = "5";
    beginStoryblocksRun();
    const calls = stubFetch((url) => (url.includes("APIKEY=pubA") ? { status: 429 } : { body: realPage }));

    const first = await storyblocksSearch("diesel engine bay");
    expect(first).toEqual([]); // key A denied, this beat yields nothing
    const second = await storyblocksSearch("diesel engine bay");
    expect(second.length).toBe(50); // ...and the next beat is served by key B
    expect(calls.some((c) => c.includes("APIKEY=pubB"))).toBe(true);
  });

  it("CONTROL: does NOT park a key on an auth error — that is our bug, not exhaustion", async () => {
    SETTINGS.STORYBLOCKS_API_KEYS = "pubA:privA";
    SETTINGS.STORYBLOCKS_MAX_DOWNLOADS_PER_RUN = "5";
    beginStoryblocksRun();
    stubFetch(() => ({ status: 403, body: { errors: "HMAC header is invalid" } }));
    await storyblocksSearch("diesel engine bay");
    expect(__testing.keyPool.keys[0].exhaustedUntilMs).toBeNull();
  });

  it("discards a fallback pool and retries on ONE word", async () => {
    SETTINGS.STORYBLOCKS_API_KEYS = "pubA:privA";
    SETTINGS.STORYBLOCKS_MAX_DOWNLOADS_PER_RUN = "5";
    beginStoryblocksRun();
    const fallback = { total_results: 32, results: Array.from({ length: 32 }, (_, i) => ({ id: 900 + i, title: "junk" })) };
    const calls = stubFetch((url) => (url.includes("keywords=engine+bay") ? { body: fallback } : { body: realPage }));

    const r = await storyblocksSearch("Cummins 12 valve diesel engine bay close up");
    expect(calls.length).toBe(2); // two words, then one
    expect(calls[1]).toContain("keywords=bay");
    expect(r.length).toBe(50); // the one-word retry was honest
    expect(r.every((h) => h.id < 900)).toBe(true); // and none of the junk leaked through
  });

  it("de-duplicates ids repeated within one page", async () => {
    SETTINGS.STORYBLOCKS_API_KEYS = "pubA:privA";
    SETTINGS.STORYBLOCKS_MAX_DOWNLOADS_PER_RUN = "5";
    beginStoryblocksRun();
    stubFetch(() => ({ body: { total_results: 300, results: [{ id: 7 }, { id: 7 }, { id: 8 }] } }));
    const r = await storyblocksSearch("diesel engine bay");
    expect(r.map((h) => h.id)).toEqual([7, 8]);
  });

  it("returns [] when the budget is already spent, without calling the API", async () => {
    SETTINGS.STORYBLOCKS_API_KEYS = "pubA:privA";
    SETTINGS.STORYBLOCKS_MAX_DOWNLOADS_PER_RUN = "1";
    beginStoryblocksRun();
    reserveDownload(); // spend it
    const calls = stubFetch(() => ({ body: realPage }));
    expect(await storyblocksSearch("diesel engine bay")).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The download manifest. THIS SHAPE IS REAL — captured from a live, billed call on
 * 2026-07-31; only the URLs are replaced, because the originals carry an expiring
 * signature. The download endpoint returns this JSON, never the clip itself, which is why
 * materialize() has to exchange it for a CDN link before handing anything to the downloader.
 */
const MANIFEST = {
  MOV: { _2160p: "https://cdn.example/mov_2160p.file", _1080p: "https://cdn.example/mov_1080p.file" },
  MP4: { _2160p: "https://cdn.example/mp4_2160p.file", _1080p: "https://cdn.example/mp4_1080p.file", _720p: "https://cdn.example/mp4_720p.file" },
};

describe("pickDownloadUrl — choosing a file from the real manifest", () => {
  it("prefers MP4 over MOV — the compositor re-encodes to h264 and MOV entries are far larger", () => {
    expect(pickDownloadUrl(MANIFEST, 1080)).toBe(MANIFEST.MP4._1080p);
  });

  it("takes the SMALLEST resolution that still covers the frame, not the biggest available", () => {
    // 720 is covered by 720p; grabbing 2160p would download ~4x the bytes for nothing.
    expect(pickDownloadUrl(MANIFEST, 720)).toBe(MANIFEST.MP4._720p);
    expect(pickDownloadUrl(MANIFEST, 1080)).toBe(MANIFEST.MP4._1080p);
    expect(pickDownloadUrl(MANIFEST, 2160)).toBe(MANIFEST.MP4._2160p);
  });

  it("falls back to the largest available when nothing covers the frame", () => {
    expect(pickDownloadUrl({ MP4: { _720p: "https://cdn.example/a", _1080p: "https://cdn.example/b" } }, 4320))
      .toBe("https://cdn.example/b");
  });

  it("uses MOV when that is all there is", () => {
    expect(pickDownloadUrl({ MOV: MANIFEST.MOV }, 1080)).toBe(MANIFEST.MOV._1080p);
  });

  it("handles a format we have never seen rather than giving up", () => {
    expect(pickDownloadUrl({ WEBM: { _1080p: "https://cdn.example/w" } }, 1080)).toBe("https://cdn.example/w");
  });

  it("CONTROL: returns null for anything that is not a usable manifest", () => {
    expect(pickDownloadUrl(null, 1080)).toBeNull();
    expect(pickDownloadUrl({}, 1080)).toBeNull();
    expect(pickDownloadUrl({ MP4: {} }, 1080)).toBeNull();
    expect(pickDownloadUrl({ MP4: { _1080p: "not-a-url" } }, 1080)).toBeNull();
    expect(pickDownloadUrl({ MP4: { weird: "https://cdn.example/x" } }, 1080)).toBeNull();
  });
});

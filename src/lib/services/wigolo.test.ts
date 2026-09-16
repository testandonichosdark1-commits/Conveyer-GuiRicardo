import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The wigolo footage source — an OPTIONAL, opt-in provider of open-web photographs.
 *
 * Two things these tests exist to hold down:
 *
 *  1. The response mapping, pinned against a payload captured verbatim from a live daemon
 *     (2026-08-10). The API names its fields in a way that is easy to get backwards — in
 *     `results[]` the key `url` is the PAGE and `image_url` is the FILE, while the very same
 *     payload's `images[]` array uses `url` for the FILE. Swapping them hands the downloader
 *     an HTML document and strips the descriptive slug the scorer reads.
 *  2. Failure isolation. Every way wigolo can fail must leave by throwing, because that is
 *     what gatherCandidates already treats as "this source found nothing" — a stopped or
 *     misconfigured daemon has to degrade the candidate pool, never break a run.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { __testing } from "./visual-source";

const { wigoloSearch, gatherCandidates, PROVIDER_WEIGHT, PREFILTER_PROVIDER_WEIGHT, PROVIDERS } = __testing;

const RUN = "wigolo-test-run";
const DAEMON = "http://127.0.0.1:3477";

/**
 * Captured verbatim from `POST /v1/search {category:"images"}` on a live daemon.
 * Trimmed to two results plus the `images[]` array; nothing was renamed or reshaped.
 *
 * The second result is the load-bearing one: its PAGE is `…/premium-ai-image/…` while its
 * FILE is `…/premium-photo/….jpg`. A generated picture labelled on only one of the two URLs
 * is exactly the case that motivated checking both.
 */
const REAL_RESPONSE = {
  results: [
    {
      title: "Abandoned Lighthouse on a Rocky Coast in Stormy Weather Stock Photo ...",
      url: "https://www.dreamstime.com/abandoned-lighthouse-rocky-coast-stormy-weather-image350019698",
      snippet: "Bing",
      relevance_score: 1,
      image_url: "https://thumbs.dreamstime.com/b/abandoned-lighthouse-rocky-coast-350019698.jpg",
      thumbnail_url: "https://tse3.mm.bing.net/th/id/OIP.7E8AnnfXH-5zmsseqeA5YwHaE7?r=0&pid=Api",
      width: 800,
      height: 533,
    },
    {
      title: "Premium AI Image | Derelict lighthouse on a rocky coast",
      url: "https://www.freepik.com/premium-ai-image/derelict-lighthouse-rocky-coast_82444433.htm",
      snippet: "Bing",
      relevance_score: 0.94,
      image_url: "https://img.freepik.com/premium-photo/derelict-lighthouse-rocky-coast_1060272-3397.jpg?w=996",
      thumbnail_url: "https://tse1.mm.bing.net/th/id/OIP.dYYigTp4XqKK90vl4GXSYgHaHa?r=0&pid=Api",
      width: 996,
      height: 996,
    },
  ],
  images: [
    {
      // NOTE the inversion: here `url` is the FILE and the page is `source_url`.
      url: "https://thumbs.dreamstime.com/b/abandoned-lighthouse-rocky-coast-350019698.jpg",
      source_url: "https://www.dreamstime.com/abandoned-lighthouse-rocky-coast-stormy-weather-image350019698",
      thumbnail_url: "https://tse3.mm.bing.net/th/id/OIP.7E8AnnfXH-5zmsseqeA5YwHaE7?r=0&pid=Api",
      width: 800,
      height: 533,
    },
  ],
};

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

let fetchSpy: ReturnType<typeof vi.fn>;

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
}

beforeEach(() => {
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  Object.assign(SETTINGS, { WIGOLO_URL: DAEMON, WIGOLO_MIN_PX: "0" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("wigolo — response mapping", () => {
  it("maps image_url to the download URL and url to the source PAGE", async () => {
    stubFetch(() => ok(REAL_RESPONSE));
    const hits = await wigoloSearch("abandoned lighthouse", RUN);

    expect(hits).toHaveLength(1); // the AI-labelled second result is dropped, see below
    expect(hits[0]).toMatchObject({
      kind: "image",
      url: "https://thumbs.dreamstime.com/b/abandoned-lighthouse-rocky-coast-350019698.jpg",
      sourceUrl: "https://www.dreamstime.com/abandoned-lighthouse-rocky-coast-stormy-weather-image350019698",
      thumbUrl: "https://tse3.mm.bing.net/th/id/OIP.7E8AnnfXH-5zmsseqeA5YwHaE7?r=0&pid=Api",
      license: "Web (user responsibility)",
    });
  });

  it("never emits a video candidate — wigolo has no video surface to displace stock with", async () => {
    stubFetch(() => ok(REAL_RESPONSE));
    const hits = await wigoloSearch("anything", RUN);
    expect(hits.every((h) => h.kind === "image")).toBe(true);
  });

  it("falls back to the file URL when a hit carries no thumbnail", async () => {
    stubFetch(() => ok({ results: [{ url: "https://p.example/page", image_url: "https://cdn.example/a.jpg" }] }));
    const [hit] = await wigoloSearch("q", RUN);
    expect(hit.thumbUrl).toBe("https://cdn.example/a.jpg");
  });

  it("sends the configured blocklist as exclude_domains", async () => {
    SETTINGS.WIGOLO_EXCLUDE_DOMAINS = "alamy.com, gettyimages.com";
    stubFetch(() => ok({ results: [] }));
    await wigoloSearch("q", RUN);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    // Page domains, not image CDNs — the daemon matches exclude_domains against the page.
    expect(body.exclude_domains).toEqual(["alamy.com", "gettyimages.com"]);
    expect(body.category).toBe("images");
  });

  it("omits the Authorization header when no token is configured, and sends a bearer when one is", async () => {
    stubFetch(() => ok({ results: [] }));
    await wigoloSearch("q", RUN);
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("Authorization");

    SETTINGS.WIGOLO_API_TOKEN = "s3cret";
    await wigoloSearch("q", RUN);
    const headers = (fetchSpy.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer s3cret");
  });
});

describe("wigolo — dedupe identity", () => {
  /**
   * The used-clip filter is keyed on dedupeId, so the id has to depend on the picture and
   * nothing else. Deriving it from the rank would make one photo two different candidates
   * across two searches and let it fill two shots in the same video.
   */
  it("gives one picture the same dedupeId regardless of its position in the results", async () => {
    const file = "https://cdn.example/photo.jpg";
    stubFetch(() => ok({ results: [{ image_url: file, url: "https://p/1" }] }));
    const [first] = await wigoloSearch("q", RUN);

    stubFetch(() =>
      ok({
        results: [
          { image_url: "https://cdn.example/other-1.jpg", url: "https://p/a" },
          { image_url: "https://cdn.example/other-2.jpg", url: "https://p/b" },
          { image_url: file, url: "https://p/1" },
        ],
      })
    );
    const third = (await wigoloSearch("q", RUN))[2];

    expect(third.dedupeId).toBe(first.dedupeId);
  });

  it("does not collide for two files sharing a long path prefix", async () => {
    const prefix = "https://static.example.com/system/resources/previews/054/361/546/non_2x/";
    stubFetch(() =>
      ok({
        results: [
          { image_url: `${prefix}fierce-wild-animal-growling-in-the-wilderness.jpg`, url: "https://p/1" },
          { image_url: `${prefix}fierce-wild-animal-growling-at-dusk-second.jpg`, url: "https://p/2" },
        ],
      })
    );
    const hits = await wigoloSearch("q", RUN);
    expect(hits[0].dedupeId).not.toBe(hits[1].dedupeId);
  });
});

describe("wigolo — filtering", () => {
  it("drops AI-labelled results even when only the PAGE url carries the marker", async () => {
    stubFetch(() => ok(REAL_RESPONSE));
    const hits = await wigoloSearch("abandoned lighthouse", RUN);
    expect(hits.map((h) => h.url)).not.toContain(
      "https://img.freepik.com/premium-photo/derelict-lighthouse-rocky-coast_1060272-3397.jpg?w=996"
    );
  });

  it("drops AI-labelled results when only the FILE url carries the marker", async () => {
    stubFetch(() =>
      ok({ results: [{ image_url: "https://cdn.example/ai-generated-close-up.jpg", url: "https://page.example/x" }] })
    );
    expect(await wigoloSearch("q", RUN)).toHaveLength(0);
  });

  it("drops undersized pictures on either dimension", async () => {
    SETTINGS.WIGOLO_MIN_PX = "700";
    stubFetch(() =>
      ok({
        results: [
          { image_url: "https://cdn/ok.jpg", url: "https://p/1", width: 800, height: 800 },
          { image_url: "https://cdn/narrow.jpg", url: "https://p/2", width: 400, height: 900 },
          { image_url: "https://cdn/short.jpg", url: "https://p/3", width: 900, height: 400 },
        ],
      })
    );
    const hits = await wigoloSearch("q", RUN);
    expect(hits.map((h) => h.url)).toEqual(["https://cdn/ok.jpg"]);
  });
});

describe("wigolo — failure modes", () => {
  it("is inert with no daemon address configured, without touching the network", async () => {
    SETTINGS.WIGOLO_URL = "";
    stubFetch(() => ok({ results: [] }));
    expect(await wigoloSearch("q", RUN)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws when the daemon is not running", async () => {
    stubFetch(() => {
      const e = new TypeError("fetch failed");
      (e as TypeError & { cause?: { code: string } }).cause = { code: "ECONNREFUSED" };
      throw e;
    });
    await expect(wigoloSearch("q", RUN)).rejects.toThrow(/fetch failed/);
  });

  it("throws when the request is aborted by the timeout", async () => {
    stubFetch(() => {
      throw new DOMException("This operation was aborted", "AbortError");
    });
    await expect(wigoloSearch("q", RUN)).rejects.toThrow(/aborted/i);
  });

  /**
   * A rejected request arrives as an HTTP RESPONSE carrying {ok:false, error, error_reason},
   * not as a thrown fetch error. Without the resp.ok branch it would parse as an empty result
   * set and read as "the source found nothing" — sending anyone debugging it the wrong way.
   */
  it("surfaces a 400 with the daemon's own error text", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ ok: false, error: "Schema validation failed at /category", error_reason: "invalid_input" }),
          { status: 400 }
        )
    );
    await expect(wigoloSearch("q", RUN)).rejects.toThrow(/Schema validation failed/);
  });

  it("names the token explicitly on a 401 instead of looking like an empty source", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: "Missing or invalid bearer token", error_reason: "unauthorized" }), {
          status: 401,
        })
    );
    await expect(wigoloSearch("q", RUN)).rejects.toThrow(/WIGOLO_API_TOKEN/);
  });

  it("returns nothing rather than throwing when the payload has no results array", async () => {
    stubFetch(() => ok({ ok: true }));
    expect(await wigoloSearch("q", RUN)).toEqual([]);
    stubFetch(() => ok({ results: "not-an-array" }));
    expect(await wigoloSearch("q", RUN)).toEqual([]);
  });

  it("skips malformed entries instead of failing the whole search", async () => {
    stubFetch(() =>
      ok({ results: [{ url: "https://p/1" }, null, { image_url: 42 }, { image_url: "https://cdn/good.jpg" }] })
    );
    const hits = await wigoloSearch("q", RUN);
    expect(hits.map((h) => h.url)).toEqual(["https://cdn/good.jpg"]);
  });
});

describe("wigolo — isolation from the other sources", () => {
  /**
   * The whole point of the feature being optional: a totally broken wigolo must cost the run
   * nothing. gatherCandidates already wraps each provider, and this pins that the guarantee
   * survives having wigolo in the list.
   */
  it("a failing wigolo leaves the other providers' candidates intact", async () => {
    SETTINGS.FOOTAGE_SOURCES = "pexels,wigolo";
    SETTINGS.PEXELS_API_KEY = "test-key";
    stubFetch((url) => {
      if (url.includes("127.0.0.1:3477")) throw new TypeError("fetch failed");
      return ok({
        videos: [
          {
            id: 111,
            duration: 12,
            url: "https://www.pexels.com/video/a-tiger-111/",
            image: "https://images.pexels.com/videos/111/poster.jpg",
            user: { name: "Someone" },
            video_files: [{ link: "https://player.pexels.com/111.mp4", width: 1920, height: 1080, quality: "hd", file_type: "video/mp4" }],
          },
        ],
      });
    });

    const pool = await gatherCandidates(RUN, "a tiger pacing", 8, new Set<string>());
    expect(pool.map((h) => h.provider)).toEqual(["pexels"]);
    expect(pool[0].url).toBe("https://player.pexels.com/111.mp4");
  });
});

describe("wigolo — ranking priority", () => {
  /**
   * An unlisted provider scores 0 in both tables, which would rank wigolo third — above
   * wikimedia, openverse, web and archive — purely because nobody wrote a line for it. It is
   * the same kind of source as `web`, so it carries the same weight, and the ordering of the
   * providers that already existed is untouched.
   */
  it("carries an explicit weight equal to the web source in both tables", () => {
    for (const table of [PROVIDER_WEIGHT, PREFILTER_PROVIDER_WEIGHT]) {
      expect(table.wigolo).toBeDefined();
      expect(table.wigolo).toBe(table.web);
    }
  });

  it("does not outrank any stock source", () => {
    for (const table of [PROVIDER_WEIGHT, PREFILTER_PROVIDER_WEIGHT]) {
      expect(table.wigolo).toBeLessThan(table.pexels);
      expect(table.wigolo).toBeLessThan(table.pixabay);
      expect(table.wigolo).toBeLessThan(table.wikimedia);
      expect(table.wigolo).toBeLessThan(table.openverse);
    }
  });

  it("leaves the pre-existing providers' weights exactly as they were", () => {
    expect(PROVIDER_WEIGHT).toMatchObject({ pexels: 4, pixabay: 2, youtube: 1, wikimedia: -1, openverse: -2, web: -3, archive: -4 });
    expect(PREFILTER_PROVIDER_WEIGHT).toMatchObject({ pexels: 4, pixabay: 2, youtube: 1, wikimedia: -1, openverse: -2, web: -3, archive: -4 });
  });

  it("is registered in the provider registry", () => {
    expect(typeof PROVIDERS.wigolo).toBe("function");
  });
});

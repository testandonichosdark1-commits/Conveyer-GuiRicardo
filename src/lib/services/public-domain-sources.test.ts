import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The public-domain sources must NEVER pass on an item that is not public domain / CC0 —
 * that guarantee is the whole reason they exist (a monetized channel, no licence, no claims).
 * Each test feeds a mixed payload in the provider's real shape and checks only free items survive.
 */
const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));

import { europeanaSearch, flickrSearch, smithsonianSearch, nasaSearch, dvidsSearch } from "./public-domain-sources";

function stubFetch(routes: (url: string) => unknown) {
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
    const body = routes(String(u));
    return body === undefined ? new Response("nf", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(settings)) delete settings[k];
});

describe("keyed sources without a key", () => {
  it("return nothing and make no request", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await smithsonianSearch("x")).toEqual([]);
    expect(await europeanaSearch("x")).toEqual([]);
    expect(await flickrSearch("x")).toEqual([]);
    expect(await dvidsSearch("x")).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("licence filters", () => {
  it("Smithsonian keeps only CC0 images", async () => {
    settings.SMITHSONIAN_API_KEY = "k";
    const row = (idsId: string, access: string) => ({
      title: idsId,
      content: { descriptiveNonRepeating: { record_ID: idsId, online_media: { media: [{ type: "Images", idsId, usage: { access } }] } } },
    });
    stubFetch(() => ({ response: { rows: [row("A", "CC0"), row("B", "Usage conditions apply")] } }));
    const hits = await smithsonianSearch("locomotive");
    expect(hits.map((h) => h.dedupeId)).toEqual(["smithsonian:A"]);
    expect(hits[0].url).toContain("max=1920");
  });

  it("Europeana keeps only Public Domain Mark / CC0, and only mp4 videos", async () => {
    settings.EUROPEANA_API_KEY = "k";
    stubFetch((u) => {
      const video = u.includes("TYPE%3AVIDEO");
      return {
        success: true,
        items: video
          ? [
              { id: "/v/1", type: "VIDEO", rights: ["http://creativecommons.org/publicdomain/mark/1.0/"], edmIsShownBy: ["https://x/a.mp4"] },
              { id: "/v/2", type: "VIDEO", rights: ["http://creativecommons.org/publicdomain/mark/1.0/"], edmIsShownBy: ["https://x/a.ogv"] },
            ]
          : [
              { id: "/i/1", type: "IMAGE", rights: ["http://creativecommons.org/publicdomain/zero/1.0/"], edmIsShownBy: ["https://x/1.jpg"] },
              { id: "/i/2", type: "IMAGE", rights: ["http://creativecommons.org/licenses/by/4.0/"], edmIsShownBy: ["https://x/2.jpg"] },
              { id: "/i/3", type: "IMAGE", rights: ["http://rightsstatements.org/vocab/InC/1.0/"], edmIsShownBy: ["https://x/3.jpg"] },
            ],
      };
    });
    const hits = await europeanaSearch("locomotive");
    expect(hits.map((h) => `${h.kind}:${h.dedupeId}`).sort()).toEqual(["image:europeana:/i/1", "video:europeana:/v/1"]);
  });

  it("Flickr asks only for licences 7/9/10 and drops anything else it returns", async () => {
    settings.FLICKR_API_KEY = "k";
    let asked = "";
    stubFetch((u) => {
      asked = u;
      return {
        stat: "ok",
        photos: {
          photo: [
            { id: "1", owner: "o", license: "9", url_l: "https://f/1.jpg" },
            { id: "2", owner: "o", license: "4", url_l: "https://f/2.jpg" }, // CC BY — needs attribution
            { id: "3", owner: "o", license: "7", url_l: "https://f/3.jpg" },
            { id: "4", owner: "o", license: "10" }, // no large size → skipped
          ],
        },
      };
    });
    const hits = await flickrSearch("lighthouse");
    expect(new URL(asked).searchParams.get("license")).toBe("7,9,10");
    expect(hits.map((h) => h.dedupeId)).toEqual(["flickr:1", "flickr:3"]);
  });
});

describe("NASA", () => {
  it("drops long webcasts and keeps short clips and photos", async () => {
    stubFetch((u) => {
      if (u.includes("media_type=image"))
        return { collection: { items: [{ data: [{ nasa_id: "IMG1", media_type: "image", title: "Launch" }], links: [{ href: "https://n/IMG1~large.jpg", rel: "alternate" }] }] } };
      if (u.includes("media_type=video"))
        return {
          collection: {
            items: [
              { data: [{ nasa_id: "SHORT", media_type: "video" }], links: [] },
              { data: [{ nasa_id: "LONG", media_type: "video" }], links: [] },
            ],
          },
        };
      if (u.includes("SHORT/metadata.json")) return { "QuickTime:Duration": "0:01:45" };
      if (u.includes("LONG/metadata.json")) return { "QuickTime:Duration": "0:49:07" };
      return undefined;
    });
    const hits = await nasaSearch("shuttle");
    expect(hits.map((h) => `${h.kind}:${h.dedupeId}`).sort()).toEqual(["image:nasa:IMG1", "video:nasa:SHORT"]);
    expect(hits.find((h) => h.kind === "video")!.url).toMatch(/SHORT~large\.mp4$/);
  });
});

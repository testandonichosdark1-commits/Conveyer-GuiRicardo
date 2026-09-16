import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Avatar V capability, as the live HeyGen API actually behaves.
 *
 * Two properties are pinned throughout:
 *
 *  1. `supported_api_engines` is the ONLY source of availability. HeyGen's docs say
 *     Avatar V is Digital-Twin-only; the live API accepts it for ordinary photo avatars,
 *     so nothing here filters by avatar_type. Availability is per-avatar.
 *  2. It is never inferred and never assumed. A missing/unknown array means NOT supported —
 *     the safe direction, since guessing "yes" means a 400 on every beat mid-run.
 */

const store = vi.hoisted(() => ({
  get: null as unknown,
  err: null as Error | null,
  pages: null as unknown[] | null,
  urls: [] as string[],
}));
vi.mock("../settings", () => ({ getSetting: () => "test-key" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("./heygen-client", () => ({
  heygenGet: async (url: string) => {
    store.urls.push(url);
    if (store.err) throw store.err;
    if (store.pages) return store.pages.shift() ?? { data: [] };
    return store.get;
  },
  heygenPost: async () => ({}),
  heygenDelete: async () => {},
  uploadAsset: async () => ({ id: "a" }),
  uploadTalkingPhoto: async () => ({ talking_photo_id: "t" }),
}));

import { listAvatarVCompatibleAvatars, checkAvatarVSupport } from "./heygen-avatar";

/** Shaped from a REAL /v3/avatars/looks item observed on a live account. */
const WITH_V = {
  id: "87a11dc1f4bc44a1acd918371f5ee616",
  name: "Photo Avatar",
  avatar_type: "photo_avatar",
  preview_image_url: "https://files2.heygen.ai/x.png",
  status: "completed",
  supported_api_engines: ["avatar_v", "avatar_iv", "avatar_iii"],
};
const WITHOUT_V = { ...WITH_V, id: "da5db49f883945ed96662efe041335b4", supported_api_engines: ["avatar_iv", "avatar_iii"] };

beforeEach(() => {
  store.get = null;
  store.err = null;
  store.pages = null;
  store.urls = [];
});

describe("listAvatarVCompatibleAvatars", () => {
  it("offers only avatars that report avatar_v", async () => {
    store.get = { data: [WITH_V, WITHOUT_V], has_more: false };
    const out = await listAvatarVCompatibleAvatars();
    expect(out).toEqual([{ id: WITH_V.id, name: "Photo Avatar", previewUrl: "https://files2.heygen.ai/x.png" }]);
  });

  it("does NOT filter by avatar_type — Avatar V is an engine, not an avatar type", async () => {
    // The docs claim digital_twin only; the live API grants it to photo_avatar. Filtering
    // by type here would hide every avatar that actually works.
    store.get = { data: [WITH_V], has_more: false };
    expect(await listAvatarVCompatibleAvatars()).toHaveLength(1);
    expect(store.urls[0]).not.toContain("avatar_type");
    expect(store.urls[0]).toContain("ownership=private");
  });

  it("treats a missing or non-array engines field as NOT supported (never assume)", async () => {
    store.get = { data: [{ id: "a", name: "n" }, { id: "b", name: "n", supported_api_engines: "avatar_v" }], has_more: false };
    expect(await listAvatarVCompatibleAvatars()).toEqual([]);
  });

  it("returns an empty list for an account with no compatible avatars (not an error)", async () => {
    store.get = { data: [WITHOUT_V], has_more: false };
    expect(await listAvatarVCompatibleAvatars()).toEqual([]);
  });

  it("reads the live envelope shape and never throws on a non-array", async () => {
    store.get = { data: null };
    expect(await listAvatarVCompatibleAvatars()).toEqual([]);
    store.get = {};
    expect(await listAvatarVCompatibleAvatars()).toEqual([]);
  });

  /** Confirmed live: limit=2 → has_more:true + an opaque cursor; token= advances the page. */
  describe("pagination", () => {
    it("follows next_token to the end, filtering each page", async () => {
      store.pages = [
        { data: [WITH_V, WITHOUT_V], has_more: true, next_token: "tok_2" },
        { data: [{ ...WITH_V, id: "lk_3" }], has_more: false },
      ];
      const out = await listAvatarVCompatibleAvatars();
      expect(out.map((a) => a.id)).toEqual([WITH_V.id, "lk_3"]);
      expect(store.urls).toHaveLength(2);
    });

    it("asks for the max page size and threads the cursor", async () => {
      store.pages = [
        { data: [WITH_V], has_more: true, next_token: "tok_2" },
        { data: [], has_more: false },
      ];
      await listAvatarVCompatibleAvatars();
      expect(store.urls[0]).toContain("limit=50");
      expect(store.urls[0]).not.toContain("token=");
      expect(store.urls[1]).toContain("token=tok_2");
    });

    it("stops when has_more is true but no cursor is returned (never loops forever)", async () => {
      // The live API OMITS next_token entirely on the last page — docs say string|null.
      store.pages = [{ data: [WITH_V], has_more: true }];
      expect(await listAvatarVCompatibleAvatars()).toHaveLength(1);
      expect(store.urls).toHaveLength(1);
    });

    it("says so rather than silently truncating if the page guard trips", async () => {
      store.pages = Array.from({ length: 25 }, () => ({ data: [WITH_V], has_more: true, next_token: "t" }));
      await expect(listAvatarVCompatibleAvatars()).rejects.toThrow(/too many to list/i);
    });
  });
});

describe("checkAvatarVSupport — the server-side gate", () => {
  it("confirms support for a compatible avatar", async () => {
    store.get = { data: WITH_V };
    expect(await checkAvatarVSupport(WITH_V.id)).toEqual({ ok: true, supported: true });
  });

  it("reports an incompatible avatar as unsupported rather than erroring", async () => {
    store.get = { data: WITHOUT_V };
    expect(await checkAvatarVSupport(WITHOUT_V.id)).toEqual({ ok: true, supported: false });
  });

  it("accepts a photo_avatar — never gates on avatar_type", async () => {
    store.get = { data: { ...WITH_V, avatar_type: "photo_avatar" } };
    expect((await checkAvatarVSupport(WITH_V.id)).supported).toBe(true);
  });

  it("does NOT fail open on a network error", async () => {
    // Unlike the type-hint check in verifyHeygenAvatar, a wrong answer here 400s on every
    // beat, mid-run, after the voiceover is paid for.
    store.err = new Error("fetch failed");
    expect((await checkAvatarVSupport("x")).ok).toBe(false);
  });

  it("surfaces a bad API key distinctly", async () => {
    store.err = new Error("HeyGen /v3/avatars/looks/x 401: unauthorized");
    expect(await checkAvatarVSupport("x")).toEqual({ ok: false, error: "auth" });
  });

  it("names a rate limit as a rate limit, not an unreachable server", async () => {
    store.err = new Error('HeyGen /v3/avatars/looks/x 429: {"error":{"code":"rate_limit_exceeded"}}');
    const r = await checkAvatarVSupport("x");
    expect(r.error).toMatch(/rate-limiting/i);
    expect(r.error).not.toMatch(/couldn't reach/i);
  });

  it("rejects an id HeyGen doesn't have", async () => {
    store.err = new Error("HeyGen /v3/avatars/looks/x 404: not found");
    expect((await checkAvatarVSupport("nope")).error).toMatch(/no avatar with the id/i);
  });
});

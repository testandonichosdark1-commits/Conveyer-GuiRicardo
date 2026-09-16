import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Avatar V (v3) request, pinned against what the LIVE API accepts.
 *
 * Every expectation here was established by probing api.heygen.com, not by reading docs
 * (the docs are wrong about Avatar V — they say Digital Twin only; the API renders it on
 * an ordinary photo avatar). /v3/videos validates STRICTLY: an unknown field is a 400
 * ("Extra inputs are not permitted"), never a silent ignore. So a field that doesn't
 * belong is not cosmetic — it fails every avatar beat of a paid run.
 */

const spy = vi.hoisted(() => ({ postPath: "", postBody: null as unknown }));

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));
vi.mock("./heygen-client", () => ({
  uploadAsset: async () => ({ id: "asset_from_v1_upload" }),
  // Record where the create went, then abort. Throwing here stops the call right after
  // the routing decision — no polling, no download, no 8s poll delay in a unit test.
  heygenPost: async (p: string, b: unknown) => {
    spy.postPath = p;
    spy.postBody = b;
    throw new Error("STOP_AFTER_ROUTING");
  },
  heygenGet: async () => ({}),
}));

import { generateAvatarClip, buildV3Body, v3Size, type AvatarHandle } from "./heygen-video";

const AV: AvatarHandle = { engine: "talking_photo", heygenId: "look_1", apiEngine: "avatar_v" };

/**
 * Which API a beat is sent to, based ONLY on the snapshotted engine.
 *
 * This is the single most important assertion in Stage 2. If the v3 branch is ever lost,
 * an Avatar V avatar renders through the v2 path — a different engine than the operator
 * chose, billed at a different rate, with no error anywhere. It is invisible without
 * this test, because a v2 render of the same avatar SUCCEEDS.
 */
describe("generateAvatarClip — engine routing", () => {
  let audio!: string;
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "av-route-"));
    audio = path.join(dir, "beat.mp3");
    fs.writeFileSync(audio, "not really audio, never uploaded for real");
    spy.postPath = "";
    spy.postBody = null;
  });

  it("sends an Avatar V avatar to /v3/videos", async () => {
    await expect(generateAvatarClip("run1", AV, audio, "/tmp/out.mp4", {})).rejects.toThrow("STOP_AFTER_ROUTING");
    expect(spy.postPath).toBe("/v3/videos");
  });

  it("keeps Avatar IV on /v2/video/generate — byte-identical to before Stage 2", async () => {
    const iv: AvatarHandle = { engine: "talking_photo", heygenId: "tp_1", useAvatarIv: true };
    await expect(generateAvatarClip("run1", iv, audio, "/tmp/out.mp4", {})).rejects.toThrow("STOP_AFTER_ROUTING");
    expect(spy.postPath).toBe("/v2/video/generate");
    expect(spy.postBody).toHaveProperty("video_inputs");
  });

  it("keeps Legacy on /v2/video/generate", async () => {
    const legacy: AvatarHandle = { engine: "talking_photo", heygenId: "tp_1" };
    await expect(generateAvatarClip("run1", legacy, audio, "/tmp/out.mp4", {})).rejects.toThrow("STOP_AFTER_ROUTING");
    expect(spy.postPath).toBe("/v2/video/generate");
  });

  it("reuses the SAME v1 audio upload for v3 — verified live that v3 accepts its asset id", async () => {
    // The reason Stage 2 has no /v3/assets multipart path at all: an asset from the
    // existing raw v1 upload resolves via GET /v3/assets/{id} and rendered end-to-end.
    await expect(generateAvatarClip("run1", AV, audio, "/tmp/out.mp4", {})).rejects.toThrow("STOP_AFTER_ROUTING");
    expect((spy.postBody as Record<string, unknown>).audio_asset_id).toBe("asset_from_v1_upload");
  });
});

describe("v3Size — our WxH format onto v3's two enums", () => {
  it("maps the common landscape sizes to the right tier", () => {
    expect(v3Size("1920x1080")).toEqual({ resolution: "1080p", aspect_ratio: "16:9" });
    expect(v3Size("1280x720")).toEqual({ resolution: "720p", aspect_ratio: "16:9" });
  });

  it("keys the tier off the SHORTER side, so portrait 1080 is still 1080p", () => {
    // 1080x1920 is "1080p portrait". Keying off height would call it 4k-ish nonsense.
    expect(v3Size("1080x1920")).toEqual({ resolution: "1080p", aspect_ratio: "9:16" });
  });

  it("supports square — v3 has a real 1:1, unlike Veo (no coercion to 16:9)", () => {
    expect(v3Size("1080x1080")).toEqual({ resolution: "1080p", aspect_ratio: "1:1" });
  });

  it("maps 4k", () => {
    expect(v3Size("3840x2160")).toEqual({ resolution: "4k", aspect_ratio: "16:9" });
  });

  it("picks the nearest aspect by RATIO, not by exact size", () => {
    // A 16:9 channel at an unusual pixel size is still 16:9.
    expect(v3Size("1024x576").aspect_ratio).toBe("16:9");
    expect(v3Size("864x1080").aspect_ratio).toBe("4:5");
  });

  it("falls back to the same default as the v2 path on garbage", () => {
    expect(v3Size("nonsense")).toEqual({ resolution: "1080p", aspect_ratio: "16:9" });
    expect(v3Size(undefined)).toEqual({ resolution: "1080p", aspect_ratio: "16:9" });
  });

  it("only ever emits values from v3's enums", () => {
    const RES = ["720p", "1080p", "4k"];
    const AR = ["16:9", "9:16", "4:5", "5:4", "1:1"];
    for (const f of ["1920x1080", "1080x1920", "1080x1080", "3840x2160", "1x1", "9999x1", "nope"]) {
      const s = v3Size(f);
      expect(RES).toContain(s.resolution);
      expect(AR).toContain(s.aspect_ratio);
    }
  });
});

describe("buildV3Body — only what the live API accepts", () => {
  const body = buildV3Body(AV, "asset_123", { title: "beat 3", resolution: "1920x1080" });

  it("sends the tagged-union discriminator", () => {
    // Omitting it 400s with "Unable to extract tag using discriminator 'type'" BEFORE
    // any other validation — the first thing the live API taught us.
    expect(body.type).toBe("avatar");
  });

  it("names the avatar and the audio asset", () => {
    expect(body.avatar_id).toBe("look_1");
    expect(body.audio_asset_id).toBe("asset_123");
  });

  it("ALWAYS states the engine explicitly", () => {
    // `engine` is optional to the API — omitting it renders on HeyGen's default. That is
    // a silent engine substitution, which is the one thing this feature must never do.
    expect(body.engine).toEqual({ type: "avatar_v" });
  });

  it("sends resolution/aspect_ratio as enums, never v2's dimension object", () => {
    expect(body.resolution).toBe("1080p");
    expect(body.aspect_ratio).toBe("16:9");
    // Live: `dimension` → 400 "Extra inputs are not permitted".
    expect(body).not.toHaveProperty("dimension");
  });

  it("never sends expressiveness — the API rejects it for avatar_v", () => {
    // Live: 400 "expressiveness is not supported with engine 'avatar_v'".
    expect(body).not.toHaveProperty("expressiveness");
  });

  it("sends no v2-only field at all (strict validation makes any of them fatal)", () => {
    for (const k of ["video_inputs", "character", "voice", "test", "use_avatar_iv_model", "talking_photo_id"]) {
      expect(body).not.toHaveProperty(k);
    }
  });

  it("sends ONLY fields verified to be accepted", () => {
    // A allow-list, not a deny-list: with "Extra inputs are not permitted", anything new
    // added here without probing it first breaks every avatar beat of a paid run.
    expect(Object.keys(body).sort()).toEqual(
      ["type", "avatar_id", "audio_asset_id", "engine", "resolution", "aspect_ratio", "title"].sort()
    );
  });
});

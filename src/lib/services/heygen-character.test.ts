import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Regression guard: the `character` object we send to /v2/video/generate.
 *
 * The bug: `use_avatar_iv_model` was set INSIDE the talking_photo branch, so an
 * "avatar"-type character (imported avatars + trained photo_avatar_groups) was
 * always rendered on the legacy engine — even though the UI let the operator pick
 * Avatar IV and the Costs page billed them the Avatar IV rate ($3.00/min vs
 * ~$1.00/min). Silent: HeyGen ignores the absent flag and returns a normal video.
 *
 * HeyGen's v2 character table marks the talking-photo-only fields explicitly
 * (talking_photo_style, talking_style, expression, super_resolution,
 * use_legacy_photo_avatar_model). `use_avatar_iv_model` carries no such note, so
 * it is valid next to avatar_id — these tests pin that it is sent for BOTH types.
 */

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));

const captured: { body: Record<string, unknown> | null } = { body: null };

vi.mock("./heygen-client", () => ({
  uploadAsset: async () => ({ id: "audio_asset_1" }),
  heygenPost: async (_path: string, body: unknown) => {
    captured.body = body as Record<string, unknown>;
    return { data: { video_id: "vid_1" } };
  },
  heygenGet: async () => ({ data: { status: "completed", video_url: "https://x/v.mp4" } }),
}));

import { generateAvatarClip, type AvatarHandle } from "./heygen-video";

const RUN = "character-body-run";
let dir: string;
let audioPath: string;
let outPath: string;

beforeEach(() => {
  captured.body = null;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "heygen-char-"));
  audioPath = path.join(dir, "beat.mp3");
  outPath = path.join(dir, "out.mp4");
  fs.writeFileSync(audioPath, Buffer.from([1, 2, 3]));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }))
  );
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Drive generateAvatarClip to completion, advancing past the poll loop's sleeps. */
async function characterFor(avatar: AvatarHandle): Promise<Record<string, unknown>> {
  const p = generateAvatarClip(RUN, avatar, audioPath, outPath);
  await vi.advanceTimersByTimeAsync(60_000);
  await p;
  const inputs = captured.body?.video_inputs as { character: Record<string, unknown> }[];
  return inputs[0].character;
}

describe("buildCharacter — Avatar IV applies to both character types", () => {
  it("sends use_avatar_iv_model for an 'avatar' character (imported / trained group)", async () => {
    const c = await characterFor({ engine: "photo_avatar_group", heygenId: "look_123", useAvatarIv: true });
    expect(c.type).toBe("avatar");
    expect(c.avatar_id).toBe("look_123");
    expect(c.use_avatar_iv_model).toBe(true); // regression: silently dropped before the fix
  });

  it("still sends use_avatar_iv_model for a talking_photo character (unchanged)", async () => {
    const c = await characterFor({ engine: "talking_photo", heygenId: "tp_123", useAvatarIv: true });
    expect(c.type).toBe("talking_photo");
    expect(c.talking_photo_id).toBe("tp_123");
    expect(c.use_avatar_iv_model).toBe(true);
  });

  it("omits the flag on both types when Legacy is selected (flag omitted = legacy engine)", async () => {
    const avatarType = await characterFor({ engine: "photo_avatar_group", heygenId: "look_123", useAvatarIv: false });
    expect(avatarType).not.toHaveProperty("use_avatar_iv_model");

    const tpType = await characterFor({ engine: "talking_photo", heygenId: "tp_123", useAvatarIv: false });
    expect(tpType).not.toHaveProperty("use_avatar_iv_model");
  });

  it("keeps the type-specific fields on their own type only", async () => {
    const c = await characterFor({ engine: "photo_avatar_group", heygenId: "look_123", useAvatarIv: true });
    // talking_photo_style is documented as talking_photo-only — must not leak here.
    expect(c).not.toHaveProperty("talking_photo_style");
    expect(c.avatar_style).toBe("normal");
  });
});

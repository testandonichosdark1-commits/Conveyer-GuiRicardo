import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The avatar renderer seam (avatar-renderer.ts) is a pure dispatch over the existing
 * HeyGen implementation. These tests pin that a call through the seam reaches
 * heygen-video's generateAvatarClip with EXACTLY the arguments the pipeline used to pass
 * it directly — so routing the pipeline through the seam changes nothing observable.
 */
const heygen = vi.hoisted(() => ({ calls: [] as unknown[][], fail: null as Error | null }));
vi.mock("./heygen-video", () => ({
  generateAvatarClip: async (...a: unknown[]) => {
    heygen.calls.push(a);
    if (heygen.fail) throw heygen.fail;
    return a[3] as string;
  },
}));

import {
  generateAvatarClip,
  decodeAvatarRenderer,
  DEFAULT_AVATAR_RENDERER,
  type AvatarHandle,
} from "./avatar-renderer";
import type { AvatarHandle as HeygenAvatarHandle } from "./heygen-video";

const RUN = "run-1";
const AUDIO = "/runs/My Video/avatar/beat_0004.mp3";
const CLIP = "/runs/My Video/avatar/beat_0004.mp4";
const OPTS = { title: "beat 4", resolution: "1920x1080" };

/** The three engines a run can snapshot, shaped exactly as studio-pipeline's readAvatar returns them. */
const HANDLES: Record<string, HeygenAvatarHandle & { dbId: number }> = {
  legacy: { dbId: 7, engine: "talking_photo", heygenId: "tp_legacy", imageKey: null, useAvatarIv: false, motionPrompt: null, apiEngine: null },
  avatarIv: { dbId: 8, engine: "photo_avatar_group", heygenId: "look_iv", imageKey: "image/abc/original", useAvatarIv: true, motionPrompt: "nods", apiEngine: null },
  avatarV: { dbId: 9, engine: "talking_photo", heygenId: "look_v", imageKey: null, useAvatarIv: false, motionPrompt: null, apiEngine: "avatar_v" },
};

beforeEach(() => {
  heygen.calls = [];
  heygen.fail = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("decodeAvatarRenderer", () => {
  it("A/I. the default — and the only renderer — is HeyGen", () => {
    expect(DEFAULT_AVATAR_RENDERER).toBe("heygen");
    expect(decodeAvatarRenderer("heygen")).toBe("heygen");
  });

  it("B. a NULL / missing snapshot (every pre-column run) means HeyGen", () => {
    expect(decodeAvatarRenderer(null)).toBe("heygen");
    expect(decodeAvatarRenderer(undefined)).toBe("heygen");
    expect(decodeAvatarRenderer("")).toBe("heygen");
  });

  it("refuses to guess on an unknown renderer instead of silently using HeyGen", () => {
    expect(() => decodeAvatarRenderer("infinitetalk")).toThrow(/refusing to guess/);
    expect(() => decodeAvatarRenderer("HeyGen")).toThrow(/refusing to guess/);
  });
});

describe("generateAvatarClip (dispatcher)", () => {
  for (const [name, h] of Object.entries(HANDLES)) {
    it(`D/12. ${name}: HeyGen receives exactly the call the pipeline used to make directly`, async () => {
      // BEFORE: studio-pipeline called heygen-video's generateAvatarClip with the handle
      // readAvatar returned (no renderer field existed).
      const before: unknown[] = [RUN, h, AUDIO, CLIP, OPTS];
      // AFTER: the same handle now carries `renderer` and goes through the seam.
      const handle: AvatarHandle & { dbId: number } = { renderer: "heygen", ...h };
      await generateAvatarClip(RUN, handle, AUDIO, CLIP, OPTS);
      expect(heygen.calls).toEqual([before]);
      // Avatar id, engine, api engine, IV flag, paths and options all identical; the
      // discriminant is not leaked into the HeyGen handle.
      expect(heygen.calls[0][1]).not.toHaveProperty("renderer");
      expect(heygen.calls[0][4]).toBe(OPTS);
    });
  }

  it("F. returns HeyGen's result and never touches the input/output paths", async () => {
    await expect(generateAvatarClip(RUN, { renderer: "heygen", ...HANDLES.legacy }, AUDIO, CLIP, OPTS)).resolves.toBe(CLIP);
    expect(heygen.calls[0][2]).toBe(AUDIO);
    expect(heygen.calls[0][3]).toBe(CLIP);
  });

  it("does not mutate the caller's handle (the pipeline reuses it for every avatar beat)", async () => {
    const handle: AvatarHandle = { renderer: "heygen", ...HANDLES.avatarV };
    const snapshot = JSON.stringify(handle);
    await generateAvatarClip(RUN, handle, AUDIO, CLIP, OPTS);
    expect(JSON.stringify(handle)).toBe(snapshot);
  });

  it("E. a HeyGen failure propagates as the same error object", async () => {
    const err = new Error("HeyGen generate failed: avatar look not found");
    heygen.fail = err;
    await expect(generateAvatarClip(RUN, { renderer: "heygen", ...HANDLES.legacy }, AUDIO, CLIP, OPTS)).rejects.toBe(err);
  });

  it("G. makes exactly one implementation call and no request of its own", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await generateAvatarClip(RUN, { renderer: "heygen", ...HANDLES.avatarIv }, AUDIO, CLIP, OPTS);
    expect(heygen.calls).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("omitted options reach HeyGen as {} — the same value its own default produced", async () => {
    await generateAvatarClip(RUN, { renderer: "heygen", ...HANDLES.legacy }, AUDIO, CLIP);
    expect(heygen.calls[0][4]).toEqual({});
  });
});

import { describe, it, expect, vi } from "vitest";

/**
 * The run snapshot's render engine, and what it bills at.
 *
 * Why a snapshot column exists at all: Stage 1 stores an Avatar V avatar as
 * engine='talking_photo' + use_avatar_iv=NULL — BYTE-IDENTICAL to a Legacy avatar. So
 * `avatar_api_engine` is the only thing that tells a resumed run which engine it was
 * created with. Get this wrong and the run renders on v2 and bills $1/min instead of $4.
 */

vi.mock("./settings", () => ({ getSetting: () => "" }));
vi.mock("./logger", () => ({ log: () => {} }));
vi.mock("./db", () => ({ default: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) } }));

import { decodeApiEngine, billingEngine } from "./studio-pipeline";

describe("decodeApiEngine", () => {
  it("reads back the engine the run was created with", () => {
    expect(decodeApiEngine("avatar_v")).toBe("avatar_v");
  });

  it("treats NULL as the v2 path — every pre-Stage-2 run", () => {
    expect(decodeApiEngine(null)).toBeNull();
    expect(decodeApiEngine("")).toBeNull();
  });

  it("refuses to guess on an unknown engine rather than defaulting to v2", () => {
    // Silently mapping an unrecognized value to "not avatar_v" would render on v2 — a
    // different engine at a different price. Same reasoning as decodeEngine.
    expect(() => decodeApiEngine("avatar_vi")).toThrow(/refusing to guess/i);
    expect(() => decodeApiEngine("digital_twin")).toThrow(/refusing to guess/i);
  });
});

describe("billingEngine — bill the engine that actually rendered", () => {
  it("bills Avatar V at the Avatar V rate", () => {
    expect(billingEngine({ apiEngine: "avatar_v", useAvatarIv: false })).toBe("avatar_v");
  });

  it("ignores use_avatar_iv on an Avatar V run", () => {
    // Meaningless on the v3 path; it must not shadow the real engine.
    expect(billingEngine({ apiEngine: "avatar_v", useAvatarIv: true })).toBe("avatar_v");
  });

  it("keeps the v2 engines exactly as before", () => {
    expect(billingEngine({ apiEngine: null, useAvatarIv: true })).toBe("avatar_iv");
    expect(billingEngine({ apiEngine: null, useAvatarIv: false })).toBe("unlimited");
  });

  it("bills a Legacy avatar as Legacy — NOT Avatar V", () => {
    // The pair that is indistinguishable in every OTHER snapshot column.
    expect(billingEngine({ apiEngine: null, useAvatarIv: false })).toBe("unlimited");
    expect(billingEngine({ apiEngine: "avatar_v", useAvatarIv: false })).toBe("avatar_v");
  });
});

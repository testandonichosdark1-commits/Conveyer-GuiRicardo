import { describe, it, expect, vi } from "vitest";

/**
 * Regression guard for the run snapshot's engine decode.
 *
 * It used to be `x === "photo_avatar_group" ? x : "talking_photo"` — an `else` that
 * turned ANY unrecognized engine into a talking photo, rendering and billing on an
 * engine nobody chose.
 *
 * Avatar V is deliberately NOT an engine value — it lives in `avatars.api_engine`, and
 * /api/studio refuses such a run outright. This decode is the backstop for any value that
 * reaches the pipeline unrecognized: the run must FAIL rather than quietly mis-render.
 */

// studio-pipeline pulls in the whole render stack at import; stub the leaves so this
// stays a pure unit test of the decode.
vi.mock("./settings", () => ({ getSetting: () => "" }));
vi.mock("./logger", () => ({ log: () => {} }));
vi.mock("./db", () => ({ default: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) } }));

import { decodeEngine } from "./studio-pipeline";

describe("decodeEngine", () => {
  it("passes through the engines that render today", () => {
    expect(decodeEngine("talking_photo")).toBe("talking_photo");
    expect(decodeEngine("photo_avatar_group")).toBe("photo_avatar_group");
  });

  it("refuses to guess on an unknown or missing engine", () => {
    expect(() => decodeEngine("avatar_vi")).toThrow(/refusing to guess/i);
    expect(() => decodeEngine("digital_twin")).toThrow(/refusing to guess/i); // retired value
    expect(() => decodeEngine(null)).toThrow(/refusing to guess/i);
    expect(() => decodeEngine("")).toThrow(/refusing to guess/i);
  });
});

import { describe, it, expect } from "vitest";
import { voiceListingError } from "./voice-catalogue-detail";
import { classifyVoiceCatalogueError } from "./voice-catalogue-error";

/**
 * Keeping the provider's own sentence is the point: it is the only thing that can tell an
 * operator whether to replace their key or grant it a permission.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

describe("voiceListingError", () => {
  it("keeps ElevenLabs' nested explanation — the real payload", () => {
    const body = JSON.stringify({
      detail: {
        type: "authentication_error",
        code: "unauthorized",
        message: "The API key you used is missing the permission voices_read to execute this operation.",
        status: "missing_permissions",
      },
    });
    const got = voiceListingError("ElevenLabs", 401, body);
    expect(got).toContain("ElevenLabs 401");
    expect(got).toContain("voices_read");
    // And the result must still classify correctly — the two pieces work as a pair.
    expect(classifyVoiceCatalogueError(got)).toBe("no_permission");
  });

  it("reads the other common shapes", () => {
    expect(voiceListingError("AI84", 403, JSON.stringify({ error: "forbidden" }))).toContain("forbidden");
    expect(voiceListingError("HeyGen", 401, JSON.stringify({ message: "bad token" }))).toContain("bad token");
    expect(voiceListingError("X", 400, JSON.stringify({ detail: "flat detail" }))).toContain("flat detail");
  });

  it("falls back to raw text when the body isn't JSON", () => {
    expect(voiceListingError("ElevenLabs", 502, "<html>Bad Gateway</html>")).toContain("Bad Gateway");
  });

  it("says just the status when the provider said nothing", () => {
    expect(voiceListingError("ElevenLabs", 500, "")).toBe("ElevenLabs 500");
    expect(voiceListingError("ElevenLabs", 500, "   ")).toBe("ElevenLabs 500");
  });

  it("puts the status FIRST so classification keeps working on the same string", () => {
    // A refusal with no scope wording must still read as "rejected", not "unreachable".
    const got = voiceListingError("ElevenLabs", 401, JSON.stringify({ detail: { message: "Invalid API key" } }));
    expect(got.startsWith("ElevenLabs 401")).toBe(true);
    expect(classifyVoiceCatalogueError(got)).toBe("rejected");
  });

  it("caps a runaway body so the message stays readable", () => {
    const got = voiceListingError("ElevenLabs", 500, "x".repeat(5000));
    expect(got.length).toBeLessThan(220);
  });
});

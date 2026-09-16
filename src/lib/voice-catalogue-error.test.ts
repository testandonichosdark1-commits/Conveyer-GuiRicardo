import { describe, it, expect } from "vitest";
import { classifyVoiceCatalogueError } from "./voice-catalogue-error";

/**
 * The distinction that matters is "your key was refused" vs "we couldn't reach them": one is
 * the operator's to fix in Settings, the other is waiting or retrying. Collapsing them into
 * one message is what made an expired key indistinguishable from a broken deploy.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

describe("classifyVoiceCatalogueError", () => {
  it("recognises a missing key from the routes' own wording", () => {
    // Every /api/voices/* route phrases it this way, for every provider.
    for (const m of ["ELEVENLABS_API_KEY not set", "AI84_API_KEY not set", "HUME_API_KEY not set"]) {
      expect(classifyVoiceCatalogueError(m), m).toBe("no_key");
    }
  });

  it("separates a key that lacks a SCOPE from a key that was refused", () => {
    // Measured on a live account: this key narrated videos for weeks and still does, but it
    // was issued without `voices_read`, so listing 401s. Same status code as a bad key,
    // opposite remedy — call it "rejected" and the operator replaces a working key.
    expect(
      classifyVoiceCatalogueError(
        "ElevenLabs 401: The API key you used is missing the permission voices_read to execute this operation."
      )
    ).toBe("no_permission");
    expect(classifyVoiceCatalogueError('AI84 403: {"status":"missing_permissions"}')).toBe("no_permission");
    expect(classifyVoiceCatalogueError("HeyGen 401: insufficient permissions")).toBe("no_permission");
    expect(classifyVoiceCatalogueError("ElevenLabs 401: token is missing the voices scope")).toBe("no_permission");
  });

  it("recognises a refused key — the case that cost an evening of debugging", () => {
    expect(classifyVoiceCatalogueError("ElevenLabs 401")).toBe("rejected");
    expect(classifyVoiceCatalogueError("AI84 403")).toBe("rejected");
    expect(classifyVoiceCatalogueError("HeyGen 401")).toBe("rejected");
    expect(classifyVoiceCatalogueError("unauthorized")).toBe("rejected");
    expect(classifyVoiceCatalogueError('{"detail":"Invalid API key"}')).toBe("rejected");
  });

  it("calls everything else unreachable rather than guessing", () => {
    for (const m of ["ElevenLabs 500", "ElevenLabs 429", "fetch failed", "Failed to fetch", "???"]) {
      expect(classifyVoiceCatalogueError(m), m).toBe("unreachable");
    }
  });

  it("treats a blank or absent message as unreachable, never as a key problem", () => {
    // Accusing an operator's key when we know nothing would send them to edit a working key.
    expect(classifyVoiceCatalogueError(null)).toBe("unreachable");
    expect(classifyVoiceCatalogueError(undefined)).toBe("unreachable");
    expect(classifyVoiceCatalogueError("   ")).toBe("unreachable");
  });

  it("does not read 401 out of an unrelated number", () => {
    // "1401 voices" or an id containing the digits must not read as a refusal.
    expect(classifyVoiceCatalogueError("AI84 timed out after 1401ms")).toBe("unreachable");
    expect(classifyVoiceCatalogueError("voice user_401_voice_1786 missing")).toBe("unreachable");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Engine resolution. The rule under test is that an UNKNOWN answer is null, never a guess:
 * null means "leave the global AI84_MODEL in charge", which is what every install did before
 * this existed, while a wrong guess is a failed run the operator has already been billed for.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

const listAll = vi.hoisted(() => vi.fn());
vi.mock("./ai84-voices", () => ({ listAllAi84Voices: listAll }));

import { resolveAi84Backend, resetAi84EngineCache } from "./ai84-voice-engine";

const KEY = "sk-user-test";
const CLONE = "user_7744_voice_1786013694967";

beforeEach(() => {
  resetAi84EngineCache();
  listAll.mockReset();
  listAll.mockResolvedValue([
    { voice_id: CLONE, name: "Samarian tab v1 · your clone", backend: "minimax", cloned: true },
    { voice_id: "Chinese_wenrounvxing", name: "Soothing Host · library", backend: "minimax" },
    { voice_id: "yFgkuUnlOWx3k7ezUZQm", name: "Mykhailo", backend: "elevenlabs" },
  ]);
});

describe("resolveAi84Backend", () => {
  it("answers MiniMax for a cloned voice WITHOUT touching the network", async () => {
    // Clones exist on one engine only, so this is a local certainty. It also has to work
    // when AI84 is unreachable, or a client's own voice would fall back to the wrong engine.
    expect(await resolveAi84Backend(KEY, CLONE)).toBe("minimax");
    expect(listAll).not.toHaveBeenCalled();
  });

  it("reads the engine off the catalogue for an ordinary voice", async () => {
    expect(await resolveAi84Backend(KEY, "Chinese_wenrounvxing")).toBe("minimax");
    resetAi84EngineCache();
    expect(await resolveAi84Backend(KEY, "yFgkuUnlOWx3k7ezUZQm")).toBe("elevenlabs");
  });

  it("is null for a voice in NEITHER catalogue — unknown, not a guess", async () => {
    // A private voice, or a typo. The run keeps the global model, exactly as before.
    expect(await resolveAi84Backend(KEY, "not_in_any_library")).toBeNull();
  });

  it("is null when the SAME id appears on both engines", async () => {
    // Two different voices that happen to share a string; picking one would be us choosing
    // an engine on the operator's behalf, which is the bug this exists to remove.
    listAll.mockResolvedValue([
      { voice_id: "ambiguous", name: "a", backend: "minimax" },
      { voice_id: "ambiguous", name: "b", backend: "elevenlabs" },
    ]);
    expect(await resolveAi84Backend(KEY, "ambiguous")).toBeNull();
  });

  it("FAILS OPEN when the catalogue can't be fetched", async () => {
    listAll.mockRejectedValue(new Error("AI84 502"));
    expect(await resolveAi84Backend(KEY, "Chinese_wenrounvxing")).toBeNull();
  });

  it("does not remember a failure — the next run tries again", async () => {
    // Caching "unknown" for ten minutes would turn one blip into a stretch of runs
    // quietly using the wrong engine.
    listAll.mockRejectedValueOnce(new Error("AI84 502"));
    expect(await resolveAi84Backend(KEY, "Chinese_wenrounvxing")).toBeNull();
    expect(await resolveAi84Backend(KEY, "Chinese_wenrounvxing")).toBe("minimax");
    expect(listAll).toHaveBeenCalledTimes(2);
  });

  it("fetches the catalogue ONCE for repeated lookups", async () => {
    await resolveAi84Backend(KEY, "Chinese_wenrounvxing");
    await resolveAi84Backend(KEY, "yFgkuUnlOWx3k7ezUZQm");
    expect(listAll).toHaveBeenCalledTimes(1);
  });

  it("fetches ONCE for two lookups racing each other", async () => {
    // Two videos started together is the entire scenario this feature is for; both must not
    // pull 730 voices at the same time.
    await Promise.all([
      resolveAi84Backend(KEY, "Chinese_wenrounvxing"),
      resolveAi84Backend(KEY, "yFgkuUnlOWx3k7ezUZQm"),
    ]);
    expect(listAll).toHaveBeenCalledTimes(1);
  });

  it("keeps accounts apart", async () => {
    await resolveAi84Backend(KEY, "Chinese_wenrounvxing");
    await resolveAi84Backend("sk-user-other", "Chinese_wenrounvxing");
    expect(listAll).toHaveBeenCalledTimes(2);
    expect(listAll).toHaveBeenLastCalledWith("sk-user-other");
  });

  it("asks nothing when there is no voice or no key", async () => {
    expect(await resolveAi84Backend(KEY, null)).toBeNull();
    expect(await resolveAi84Backend(KEY, "   ")).toBeNull();
    expect(await resolveAi84Backend("", "Chinese_wenrounvxing")).toBeNull();
    expect(listAll).not.toHaveBeenCalled();
  });

  it("still answers for a clone with no API key at all", async () => {
    expect(await resolveAi84Backend("", CLONE)).toBe("minimax");
  });
});

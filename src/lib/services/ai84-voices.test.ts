import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mergeMinimaxVoices,
  listMinimaxVoices,
  listElevenVoices,
  listAllAi84Voices,
  MAX_LIBRARY_PAGES,
} from "./ai84-voices";

/**
 * AI84's voice listings. The load-bearing behaviour is that an operator's OWN cloned
 * voices come first and survive — they are the reason the picker exists, and burying or
 * dropping them reproduces the original bug ("my voice isn't in the list").
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

const clone = (id: string, name: string) => ({ canonical_voice_id: id, name });
const libVoice = (id: string, name: string, tags?: string[]) => ({
  canonical_voice_id: id,
  name,
  minimax_voice: { tag_list: tags },
});

function jsonOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function fail(status = 500): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("mergeMinimaxVoices", () => {
  it("puts the account's own clones first and labels them", () => {
    const out = mergeMinimaxVoices([clone("user_7744_voice_1", "Samarian tab v1")], [libVoice("lib_a", "Stock A")]);
    expect(out[0].voice_id).toBe("user_7744_voice_1");
    expect(out[0].name).toMatch(/your clone/);
    expect(out[1].name).toMatch(/library/);
  });

  it("keeps the clone label when the same id also appears in the library", () => {
    const out = mergeMinimaxVoices([clone("dup", "Mine")], [libVoice("dup", "Theirs")]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toMatch(/your clone/);
  });

  it("drops entries with no id rather than emitting an unselectable option", () => {
    expect(mergeMinimaxVoices([{ name: "nameless" }], [])).toHaveLength(0);
  });

  it("surfaces a couple of tags so 695 similar names can be told apart", () => {
    const [v] = mergeMinimaxVoices([], [libVoice("x", "Anchor", ["Hindi", "Female", "News"])]);
    expect(v.name).toContain("Hindi, Female");
    expect(v.name).not.toContain("News"); // only the first two, or the label becomes unreadable
  });
});

describe("listMinimaxVoices", () => {
  it("stops paging once a short page arrives", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ data: [clone("c1", "Mine")] })) // cloned
      .mockResolvedValueOnce(jsonOk({ data: [libVoice("l1", "A")], total: 1 })); // library p1 (short)

    const out = await listMinimaxVoices("k");

    expect(out.map((v) => v.voice_id)).toEqual(["c1", "l1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never exceeds the page ceiling even if the API keeps returning full pages", async () => {
    // A wrong `total` (or a full page every time) must not turn one click into an
    // unbounded fetch loop.
    fetchMock.mockResolvedValue(
      jsonOk({ data: Array.from({ length: 200 }, (_, i) => libVoice(`v${i}`, `V${i}`)), total: 999999 })
    );

    await listMinimaxVoices("k");

    // 1 cloned call + at most MAX_LIBRARY_PAGES library calls.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1 + MAX_LIBRARY_PAGES);
  });

  it("still returns the clones when the library call fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ data: [clone("c1", "Mine")] })).mockResolvedValue(fail(500));

    const out = await listMinimaxVoices("k");

    expect(out.map((v) => v.voice_id)).toEqual(["c1"]);
  });

  it("still returns the library when the cloned call fails", async () => {
    fetchMock.mockResolvedValueOnce(fail(500)).mockResolvedValueOnce(jsonOk({ data: [libVoice("l1", "A")], total: 1 }));

    const out = await listMinimaxVoices("k");

    expect(out.map((v) => v.voice_id)).toEqual(["l1"]);
  });

  it("throws only when BOTH sources fail — an empty list would read as an empty account", async () => {
    fetchMock.mockResolvedValue(fail(401));
    await expect(listMinimaxVoices("k")).rejects.toThrow();
  });
});

describe("listAllAi84Voices", () => {
  const minimaxOk = () => [
    jsonOk({ data: [clone("user_1_voice_2", "Samarian tab v1")] }),
    jsonOk({ data: [libVoice("mm_lib", "Stock MiniMax")], total: 1 }),
  ];
  const elevenOk = () => jsonOk({ voices: [{ voice_id: "abc", name: "Narrator" }] });

  it("puts clones first, then MiniMax library, then ElevenLabs — and tags each engine", async () => {
    // The order is the feature: a creator opens this list looking for the voice they
    // recorded themselves.
    fetchMock.mockResolvedValueOnce(minimaxOk()[0]).mockResolvedValueOnce(minimaxOk()[1]).mockResolvedValueOnce(elevenOk());

    const out = await listAllAi84Voices("k");

    expect(out.map((v) => v.voice_id)).toEqual(["user_1_voice_2", "mm_lib", "abc"]);
    expect(out.map((v) => v.backend)).toEqual(["minimax", "minimax", "elevenlabs"]);
    expect(out[0].cloned).toBe(true);
    expect(out[1].cloned).toBeUndefined();
  });

  it("keeps ElevenLabs voices when the MiniMax side fails entirely", async () => {
    fetchMock.mockResolvedValueOnce(fail(500)).mockResolvedValueOnce(fail(500)).mockResolvedValueOnce(elevenOk());

    const out = await listAllAi84Voices("k");

    expect(out.map((v) => v.voice_id)).toEqual(["abc"]);
  });

  it("keeps the clones when the ElevenLabs side fails — losing them is the original bug", async () => {
    fetchMock.mockResolvedValueOnce(minimaxOk()[0]).mockResolvedValueOnce(minimaxOk()[1]).mockResolvedValueOnce(fail(502));

    const out = await listAllAi84Voices("k");

    expect(out.map((v) => v.voice_id)).toEqual(["user_1_voice_2", "mm_lib"]);
    expect(out[0].cloned).toBe(true);
  });

  it("throws only when BOTH engines fail — an empty list reads as an empty account", async () => {
    fetchMock.mockResolvedValue(fail(401));
    await expect(listAllAi84Voices("k")).rejects.toThrow();
  });

  it("does NOT dedup across engines — the same id on two engines is two voices", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ data: [] }))
      .mockResolvedValueOnce(jsonOk({ data: [libVoice("same", "MiniMax one")], total: 1 }))
      .mockResolvedValueOnce(jsonOk({ voices: [{ voice_id: "same", name: "ElevenLabs one" }] }));

    const out = await listAllAi84Voices("k");

    expect(out).toHaveLength(2);
    expect(out.map((v) => v.backend)).toEqual(["minimax", "elevenlabs"]);
  });
});

describe("listElevenVoices", () => {
  it("reads the shared-voices envelope and tags each voice", async () => {
    fetchMock.mockResolvedValue(
      jsonOk({ voices: [{ voice_id: "abc", name: "Narrator", gender: "male", language: "en" }] })
    );

    const out = await listElevenVoices("k");

    expect(out).toEqual([{ voice_id: "abc", name: "Narrator (male, en)", backend: "elevenlabs" }]);
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/shared-voices");
  });
});

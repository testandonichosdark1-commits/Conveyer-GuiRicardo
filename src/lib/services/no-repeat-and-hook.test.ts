import { describe, expect, it, vi } from "vitest";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { absorbFailedBeats } from "./beat-gap-fill";
import { buildBeatsWithHook, buildBeats } from "./studio-plan";
import { wikimediaFetch, archiveLicenseIsFree, openverseSearch } from "./visual-source";
import type { RenderBeat } from "./studio-assemble";

function rb(index: number, startMs: number, endMs: number, visualPath: string | null, layout = "broll", avatarClipPath: string | null = null): RenderBeat {
  return { index, startMs, endMs, text: `b${index}`, layout, visualPath, avatarClipPath, visualQuery: "", source: "real" } as unknown as RenderBeat;
}

describe("absorbFailedBeats — never repeat an asset", () => {
  it("gives a failed beat's time to the previous shot, which plays on", () => {
    const { beats, absorbed, orphans } = absorbFailedBeats([rb(0, 0, 4000, "a.mp4"), rb(1, 4000, 8000, null), rb(2, 8000, 12000, "c.mp4")]);
    expect(beats.map((b) => [b.index, b.startMs, b.endMs, b.visualPath])).toEqual([
      [0, 0, 8000, "a.mp4"],
      [2, 8000, 12000, "c.mp4"],
    ]);
    expect(absorbed).toEqual([1]);
    expect(orphans).toEqual([]);
    // no file appears twice
    const paths = beats.map((b) => b.visualPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("a failed first beat (and a run of them) is covered by the next shot starting earlier", () => {
    const { beats, absorbed } = absorbFailedBeats([rb(0, 0, 3000, null), rb(1, 3000, 6000, null), rb(2, 6000, 9000, "c.mp4")]);
    expect(beats.map((b) => [b.index, b.startMs, b.endMs])).toEqual([[2, 0, 9000]]);
    expect(absorbed).toEqual([0, 1]);
  });

  it("never stretches a lip-synced avatar beat; a split beat with its avatar needs no fill", () => {
    const { beats, orphans } = absorbFailedBeats([
      rb(0, 0, 3000, null, "avatar", "av0.mp4"),
      rb(1, 3000, 6000, null),
      rb(2, 6000, 9000, null, "avatar", "av2.mp4"),
      rb(3, 9000, 12000, null, "split", "av3.mp4"),
    ]);
    expect(beats.find((b) => b.index === 0)!.endMs).toBe(3000);
    expect(orphans.map((o) => o.index)).toEqual([1]);
    expect(beats.find((b) => b.index === 3)!.visualPath).toBeNull();
  });

  it("keeps the timeline contiguous", () => {
    const input = [rb(0, 0, 2000, "a"), rb(1, 2000, 5000, null), rb(2, 5000, 7000, null), rb(3, 7000, 9000, "d"), rb(4, 9000, 11000, null)];
    const { beats } = absorbFailedBeats(input);
    for (let i = 1; i < beats.length; i++) expect(beats[i].startMs).toBe(beats[i - 1].endMs);
    expect(beats[0].startMs).toBe(0);
    expect(beats[beats.length - 1].endMs).toBe(11000);
  });
});

describe("buildBeatsWithHook — faster cuts in the opening", () => {
  // 120 s of narration: one word every 400 ms, a sentence end every 15 words (6 s).
  const words = Array.from({ length: 300 }, (_, i) => ({
    word: (i + 1) % 15 === 0 ? "end." : (i + 1) % 5 === 0 ? "pause," : "word",
    startMs: i * 400,
    endMs: i * 400 + 350,
  }));

  it("cuts ~2 s during the hook and the normal length after it", () => {
    const beats = buildBeatsWithHook(words, 4.5, 3, 10, 40, 2);
    const dur = (b: { startMs: number; endMs: number }) => (b.endMs - b.startMs) / 1000;
    const hook = beats.filter((b) => b.endMs <= 42_000);
    const after = beats.filter((b) => b.startMs >= 42_000);
    expect(Math.max(...hook.map(dur))).toBeLessThanOrEqual(3.6);
    expect(hook.reduce((s, b) => s + dur(b), 0) / hook.length).toBeLessThan(3);
    expect(after.reduce((s, b) => s + dur(b), 0) / after.length).toBeGreaterThan(4);
    beats.forEach((b, i) => expect(b.index).toBe(i));
  });

  it("is plain buildBeats when the hook pace is off", () => {
    expect(buildBeatsWithHook(words, 4.5, 3, 10, 40, 0)).toEqual(buildBeats(words, 4.5, 3, 10));
  });
});

describe("wikimediaFetch — throttled and retried", () => {
  it("waits and retries a 429 instead of failing the search", async () => {
    let n = 0;
    const fake = (async () => {
      n++;
      return new Response("{}", { status: n === 1 ? 429 : 200, headers: { "retry-after": "0" } });
    }) as unknown as typeof fetch;
    const r = await wikimediaFetch("https://example.test", { minGapMs: 5, fetchImpl: fake });
    expect(r.status).toBe(200);
    expect(n).toBe(2);
  });

  it("serializes concurrent calls (never two in flight)", async () => {
    let inFlight = 0;
    let peak = 0;
    const fake = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await Promise.all([1, 2, 3, 4].map(() => wikimediaFetch("https://example.test", { minGapMs: 1, fetchImpl: fake })));
    expect(peak).toBe(1);
  });
});

describe("Openverse and archive.org — public domain / CC0 only", () => {
  it("archive.org accepts only public-domain / CC0 licence urls", () => {
    expect(archiveLicenseIsFree("http://creativecommons.org/licenses/publicdomain/")).toBe(true);
    expect(archiveLicenseIsFree("https://creativecommons.org/publicdomain/mark/1.0/")).toBe(true);
    expect(archiveLicenseIsFree("http://creativecommons.org/publicdomain/zero/1.0/")).toBe(true);
    expect(archiveLicenseIsFree("http://creativecommons.org/licenses/by/4.0/")).toBe(false);
    expect(archiveLicenseIsFree("http://creativecommons.org/licenses/by-nc-sa/3.0/")).toBe(false);
    expect(archiveLicenseIsFree(undefined)).toBe(false);
  });

  it("Openverse asks for pdm,cc0 and drops anything else it returns", async () => {
    let asked = "";
    vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
      asked = String(u);
      return new Response(JSON.stringify({ results: [
        { id: "1", url: "https://o/1.jpg", license: "cc0" },
        { id: "2", url: "https://o/2.jpg", license: "by" },
        { id: "3", url: "https://o/3.jpg", license: "pdm" },
      ] }), { status: 200 });
    }));
    try {
      const hits = await openverseSearch("locomotive");
      expect(new URL(asked).searchParams.get("license")).toBe("pdm,cc0");
      expect(hits.map((h) => h.dedupeId)).toEqual(["openverse:1", "openverse:3"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

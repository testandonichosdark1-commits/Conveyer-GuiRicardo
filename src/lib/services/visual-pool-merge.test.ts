import { describe, it, expect, vi } from "vitest";

/**
 * Slot allocation — how the 14 pool places are divided between the enabled sources.
 *
 * The defect: a plain round-robin by rank index gives every provider the same number of
 * places. With the shipped eight-source default that is rank 0 and rank 1 of the first six
 * providers plus rank 0 of the last two — so ranks 2-4 of EVERY provider are unreachable,
 * including pexels, which supplies the large majority of chosen clips. Archive, which
 * supplies almost none, gets exactly as many places as pexels does.
 *
 * The consequence is the one clients feel: each additional source ticked in Settings takes
 * places away from the sources that actually deliver, so the eighth tick makes the pool
 * worse rather than better.
 *
 * The fix must not shrink the pool — a smaller pool would flatter every downstream metric
 * while delivering the scorer less to work with — so the size invariant below is checked
 * against a copy of the old algorithm rather than assumed.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { __testing, type ProviderHit } from "./visual-source";

const { mergePools, SOURCE_POOL_PER_PROVIDER, SOURCE_POOL_MAX } = __testing;

const ALL = ["storyblocks", "pexels", "pixabay", "openverse", "wikimedia", "archive", "web", "wigolo"];

function hit(provider: string, i: number): ProviderHit {
  return {
    kind: "video",
    provider,
    url: `https://e.test/${provider}/${i}.mp4`,
    dedupeId: `${provider}:${i}`,
    thumbUrl: `https://e.test/${provider}/${i}.jpg`,
  };
}

/** n hits for each named provider, in FOOTAGE_SOURCES order (not weight order). */
function lists(names: string[], n: number | ((name: string) => number)): ProviderHit[][] {
  return names.map((name) => Array.from({ length: typeof n === "number" ? n : n(name) }, (_, i) => hit(name, i)));
}

function countByProvider(pool: ProviderHit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of pool) out[h.provider!] = (out[h.provider!] ?? 0) + 1;
  return out;
}

/** The old rule, kept here so the size invariant is CHECKED against it, not assumed. */
function roundRobinReference(ls: ProviderHit[][], usedIds: ReadonlySet<string>, max: number): ProviderHit[] {
  const seen = new Set<string>();
  const pool: ProviderHit[] = [];
  for (let i = 0; i < SOURCE_POOL_PER_PROVIDER; i++) {
    for (const list of ls) {
      const h = list[i];
      if (!h || usedIds.has(h.dedupeId) || seen.has(h.dedupeId)) continue;
      seen.add(h.dedupeId);
      pool.push(h);
      if (pool.length >= max) return pool;
    }
  }
  return pool;
}

describe("mergePools — slot allocation", () => {
  it("gives the strongest sources more places, without locking any source out", () => {
    const pool = mergePools(lists(ALL, 5), new Set(), SOURCE_POOL_MAX);
    expect(pool.length).toBe(SOURCE_POOL_MAX);
    // Quota = 1 + ceil(weight/2), capped at 5, then the spare place drains to the strongest.
    expect(countByProvider(pool)).toEqual({
      pexels: 4,
      storyblocks: 3,
      pixabay: 2,
      wikimedia: 1,
      openverse: 1,
      archive: 1,
      web: 1,
      wigolo: 1,
    });
    // The defect, still reproducible: the old rule gave pexels and archive the same two.
    const old = countByProvider(roundRobinReference(lists(ALL, 5), new Set(), SOURCE_POOL_MAX));
    expect(old.pexels).toBe(old.archive);
  });

  it("never returns fewer candidates than the old rule, for any shape", () => {
    // The load-bearing invariant. Reallocating places must not cost places — including the
    // dominant real-world case where only one provider returned anything at all.
    let seed = 20260817;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);

    for (let trial = 0; trial < 300; trial++) {
      const live = ALL.filter(() => rnd(3) > 0); // random subset, sometimes empty
      const ls = lists(live, () => rnd(SOURCE_POOL_PER_PROVIDER + 1));
      const used = new Set(ls.flat().filter(() => rnd(4) === 0).map((h) => h.dedupeId));
      expect(mergePools(ls, used, SOURCE_POOL_MAX).length).toBe(
        roundRobinReference(ls, used, SOURCE_POOL_MAX).length
      );
    }
  });

  it("hands every place to the only live provider", () => {
    // 58% of measured beats had a pool from effectively one source. That case must be
    // untouched: five hits in, five hits out, in rank order.
    const ls = lists(["pexels"], 5);
    const pool = mergePools(ls, new Set(), SOURCE_POOL_MAX);
    expect(pool.map((h) => h.dedupeId)).toEqual(["pexels:0", "pexels:1", "pexels:2", "pexels:3", "pexels:4"]);
  });

  it("takes each provider's hits in rank order", () => {
    const pool = mergePools(lists(ALL, 5), new Set(), SOURCE_POOL_MAX);
    expect(pool.filter((h) => h.provider === "pexels").map((h) => h.dedupeId)).toEqual([
      "pexels:0",
      "pexels:1",
      "pexels:2",
      "pexels:3",
    ]);
  });

  it("skips used ids and duplicates in every pass", () => {
    const ls = lists(["pexels", "archive"], 5);
    // Same asset offered by both sources — it must be admitted once.
    ls[1][0] = { ...ls[1][0], dedupeId: "pexels:0" };
    const used = new Set(["pexels:1", "pexels:2"]);
    const pool = mergePools(ls, used, SOURCE_POOL_MAX);
    const ids = pool.map((h) => h.dedupeId);
    expect(ids).not.toContain("pexels:1");
    expect(ids).not.toContain("pexels:2");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("honours a cap lower than the number of available candidates", () => {
    expect(mergePools(lists(ALL, 5), new Set(), 3).length).toBe(3);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Guards the Pexels rate-limit cooldown fix:
 *  - markKeyExhausted clamps recovery to the hourly window even when the reset
 *    header points far into the future (Pexels' X-Ratelimit-Reset is the MONTHLY
 *    rollover), so we never sleep for days / hit the old 75-min ceiling.
 *  - acquireKey never sleeps while a healthy key exists, and resumes on a key that
 *    becomes available between poll slices (early recovery OR a key added mid-run).
 */

// getSetting drives the key pool; return whatever PEXELS_API_KEY the test sets.
const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { __testing } from "./stock-footage";
const { keyPool, refreshKeyPool, markKeyExhausted, acquireKey, HOURLY_WINDOW_MS, POLL_SLICE_MS } = __testing;

function resetPool() {
  keyPool.keys = [];
  keyPool.cursor = 0;
}

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  resetPool();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("markKeyExhausted — clamp to the hourly window", () => {
  it("ignores a far-future (monthly) reset and clamps to ~now+60min", () => {
    const now = Date.now();
    const state = { key: "k", remaining: null, resetAt: Math.round(now / 1000) + 30 * 24 * 3600, exhaustedUntilMs: null };
    markKeyExhausted(state);
    expect(state.exhaustedUntilMs).not.toBeNull();
    // clamped: at most an hour out, and not the days-away header value.
    expect(state.exhaustedUntilMs!).toBeLessThanOrEqual(now + HOURLY_WINDOW_MS + 1000);
    expect(state.exhaustedUntilMs!).toBeGreaterThan(now + HOURLY_WINDOW_MS - 5000);
  });

  it("defaults to ~now+60min when no reset header was ever seen", () => {
    const now = Date.now();
    const state = { key: "k", remaining: null, resetAt: null, exhaustedUntilMs: null };
    markKeyExhausted(state);
    expect(state.exhaustedUntilMs!).toBeLessThanOrEqual(now + HOURLY_WINDOW_MS + 1000);
    expect(state.exhaustedUntilMs!).toBeGreaterThan(now + HOURLY_WINDOW_MS - 5000);
  });

  it("honors an earlier reset (sooner than the hourly window)", () => {
    const now = Date.now();
    const soon = Math.round(now / 1000) + 10 * 60; // 10 min out
    const state = { key: "k", remaining: null, resetAt: soon, exhaustedUntilMs: null };
    markKeyExhausted(state);
    expect(state.exhaustedUntilMs!).toBe(soon * 1000 + 5000);
  });
});

describe("acquireKey — never wait when a healthy key exists", () => {
  it("returns immediately without sleeping when a key is available", async () => {
    settings.PEXELS_API_KEY = "k1";
    refreshKeyPool(); // seed pool with k1 (available: exhaustedUntilMs null)
    vi.useFakeTimers();
    const key = await acquireKey("run");
    expect(key.key).toBe("k1");
  });

  it("resumes on a key that becomes available between poll slices", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    settings.PEXELS_API_KEY = "k1";
    refreshKeyPool();
    // k1 cools down for exactly two poll slices → must wake and re-scan across
    // both before it frees (derived from POLL_SLICE_MS so it tracks the constant).
    keyPool.keys[0].exhaustedUntilMs = 2 * POLL_SLICE_MS;

    const p = acquireKey("run");
    let resolved = false;
    p.then(() => { resolved = true; });

    // After one slice the key is still cooling down.
    await vi.advanceTimersByTimeAsync(POLL_SLICE_MS);
    expect(resolved).toBe(false);

    // After the second slice we reach the cooldown end → the next scan returns the key.
    await vi.advanceTimersByTimeAsync(POLL_SLICE_MS);
    const key = await p;
    expect(key.key).toBe("k1");
  });
});

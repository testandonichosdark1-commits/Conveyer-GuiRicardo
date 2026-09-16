import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Phase-aware 69labs polling (pollJob).
 *
 * Verifies the smarter give-up decisions and heartbeat WITHOUT hitting the network or waiting in
 * real time: fetch is stubbed with a scripted status sequence and the poll's 2.5s sleeps are
 * driven by fake timers. The DB-backed logger / settings / cancellation are mocked.
 */

const logs = vi.hoisted(() => [] as { level: string; msg: string }[]);

vi.mock("../settings", () => ({ getSetting: () => "vk_test_key" }));
vi.mock("../logger", () => ({ log: (_r: string, level: string, msg: string) => logs.push({ level, msg }) }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {}, CancelledError: class extends Error {} }));

import { pollJob } from "./labs69";

type Status = { status: string; progressPercent?: number | null; startedAt?: string | null };

/** A stubbed status endpoint returning `script[i]`, holding the last entry once exhausted. */
function stubStatus(script: Status[]) {
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const body = script[Math.min(i, script.length - 1)];
    i++;
    return { ok: true, status: 200, json: async () => body, text: async () => "" } as unknown as Response;
  }));
}

/** Run pollJob under fake timers, advancing `ms` of virtual time; returns "ok" or the thrown error. */
async function drive(ms: number): Promise<string | Error> {
  vi.useFakeTimers();
  try {
    const p = pollJob("images", "abcd1234ef", "run1", "image").then(() => "ok" as const).catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(ms);
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

const heartbeats = () => logs.filter((l) => /69labs images abcd1234/.test(l.msg));

describe("pollJob — phase-aware polling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    logs.length = 0;
  });

  it("completes through queued → rendering → completed and emits heartbeats", async () => {
    // PENDING for ~10s, then PROCESSING with advancing progress, then COMPLETED.
    const script: Status[] = [
      { status: "PENDING" }, { status: "PENDING" }, { status: "PENDING" }, { status: "PENDING" },
      { status: "PROCESSING", progressPercent: 20 },
      { status: "PROCESSING", progressPercent: 55 },
      { status: "FINALIZING", progressPercent: 95 },
      { status: "COMPLETED" },
    ];
    stubStatus(script);
    const res = await drive(60_000);
    expect(res).toBe("ok");
    const beats = heartbeats();
    // Heartbeats name the phase explicitly (QUEUED vs PROCESSING), not just elapsed time.
    expect(beats.some((b) => /phase QUEUED elapsed \d+s/.test(b.msg))).toBe(true);
    expect(beats.some((b) => /phase PROCESSING elapsed \d+s.*%/.test(b.msg))).toBe(true);
    // Final lifecycle line on the happy path.
    expect(beats.some((b) => /completed in \d+s/.test(b.msg))).toBe(true);
  });

  it("gives up EARLY on a job stuck in the queue (QUEUE_MAX_MS ≈ 120s, not 480s)", async () => {
    stubStatus([{ status: "PENDING" }]); // never leaves the queue
    const res = await drive(130_000);
    expect(res).toBeInstanceOf(Error);
    expect(String(res)).toMatch(/queue polling timeout/);
    // Caller reacts to "polling timeout" → cancel + retry; that contract is preserved.
    expect(String(res)).toMatch(/polling timeout/);
    // A final lifecycle line is emitted before the throw, naming the phase + reason.
    expect(heartbeats().some((b) => /queue timeout after \d+s \(phase QUEUED\)/.test(b.msg))).toBe(true);
  });

  it("detects a STALLED render (progress frozen) and gives up after STALL_MAX_MS ≈ 90s", async () => {
    stubStatus([{ status: "PROCESSING", progressPercent: 30 }]); // rendering but progress never moves
    const res = await drive(100_000);
    expect(res).toBeInstanceOf(Error);
    expect(String(res)).toMatch(/stalled polling timeout/);
    // Final lifecycle line names the phase and where progress froze.
    expect(heartbeats().some((b) => /stalled in PROCESSING — no progress for \d+s \(stuck at 30%\)/.test(b.msg))).toBe(true);
  });

  it("does NOT kill a legitimately slow render that keeps making progress", async () => {
    // Advancing progress for ~2 min (past QUEUE_MAX and STALL_MAX), then completes — must succeed.
    const script: Status[] = [];
    for (let p = 5; p <= 95; p += 2) script.push({ status: "PROCESSING", progressPercent: p });
    script.push({ status: "COMPLETED" });
    stubStatus(script);
    const res = await drive(140_000);
    expect(res).toBe("ok"); // never stall-killed while progress advanced
  });

  it("does NOT stall-kill a static PROCESSING when NO progress signal is reported", async () => {
    // progressPercent null throughout → status-only; a static PROCESSING is normal for a slow
    // render and must survive well past STALL_MAX_MS (RENDER_MAX_MS is the only backstop).
    const script: Status[] = Array(40).fill({ status: "PROCESSING", progressPercent: null });
    script.push({ status: "COMPLETED" });
    stubStatus(script);
    const res = await drive(140_000);
    expect(res).toBe("ok");
  });

  it("surfaces a terminal FAILED with its userMessage (no timeout wait)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: "FAILED", userMessage: "content blocked" }), text: async () => "" } as unknown as Response)));
    const res = await drive(5_000);
    expect(res).toBeInstanceOf(Error);
    expect(String(res)).toMatch(/FAILED: content blocked/);
    expect(String(res)).not.toMatch(/polling timeout/); // a real failure isn't a timeout retry
    // Final lifecycle line for a provider-terminated job, with 69labs' user message.
    expect(heartbeats().some((b) => /failed after \d+s — content blocked/.test(b.msg))).toBe(true);
  });
});

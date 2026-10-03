import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Runpod Serverless client (runpod-manager.ts). Every request is answered by a stubbed
 * fetch — nothing here needs, or ever touches, the network.
 */
const KEY = "rp_SECRET_KEY_1234567890";
const settings = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => settings.values[k] ?? "" }));

import {
  submitRunpodJob,
  getRunpodJobStatus,
  cancelRunpodJob,
  getRunpodEndpointHealth,
  waitForRunpodTerminalStatus,
  resolveRunpodEndpoint,
  runpodStatusToSceneJobStatus,
  isTerminalRunpodStatus,
  provesNotDelivered,
  RunpodError,
  RunpodPollTimeoutError,
  type RunpodJobStatus,
} from "./runpod-manager";

const EP = { endpointId: "ep123abc" };
const BASE = "https://api.runpod.ai/v2/ep123abc";

type Call = { url: string; init: RequestInit };
let calls: Call[];
let responder: (c: Call, n: number) => Promise<Response> | Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
/** An undici-shaped network failure: TypeError("fetch failed") with the real code in `cause`. */
function netError(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}
/** A fetch that never answers until its signal aborts — a dead socket. */
function hang(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const s = init.signal!;
    s.addEventListener("abort", () => reject(s.reason), { once: true });
  });
}

beforeEach(() => {
  settings.values = { RUNPOD_API_KEY: KEY, RUNPOD_LTX_ENDPOINT_ID: "ep123abc", RUNPOD_INFINITETALK_ENDPOINT_ID: "" };
  calls = [];
  responder = () => json(500, "unset");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    return responder(c, calls.length);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function rpError(p: Promise<unknown>): Promise<RunpodError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RunpodError);
    return e as RunpodError;
  }
  throw new Error("expected a RunpodError");
}

describe("configuration", () => {
  it("resolves endpoints from settings and refuses an unset one before any request", () => {
    expect(resolveRunpodEndpoint("ltx")).toEqual({ endpointId: "ep123abc" });
    expect(() => resolveRunpodEndpoint("infinitetalk")).toThrow(/RUNPOD_INFINITETALK_ENDPOINT_ID/);
    expect(calls).toHaveLength(0);
  });

  it("a missing API key fails as not_delivered without a request", async () => {
    settings.values.RUNPOD_API_KEY = "";
    const e = await rpError(submitRunpodJob(EP, { a: 1 }));
    expect([e.code, e.delivery, e.safeToResubmit]).toEqual(["config", "not_delivered", true]);
    expect(calls).toHaveLength(0);
  });

  it("rejects ids that could escape the URL path", async () => {
    expect((await rpError(submitRunpodJob({ endpointId: "../x" }, {}))).code).toBe("invalid_request");
    expect((await rpError(getRunpodJobStatus(EP, "a/b"))).code).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });
});

describe("submit (POST /run)", () => {
  it("sends one POST to /run with the bearer key and returns the job id and initial status", async () => {
    responder = () => json(200, { id: "job-1", status: "IN_QUEUE" });
    const res = await submitRunpodJob(EP, { prompt: "x", seconds: 5 });
    expect(res).toEqual({ remoteJobId: "job-1", status: "IN_QUEUE" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/run`);
    expect(calls[0].url).not.toMatch(/runsync/);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ input: { prompt: "x", seconds: 5 } });
  });

  it("serialises policy in Runpod's field names and milliseconds, omitting unset fields", async () => {
    responder = () => json(200, { id: "job-p" });
    await submitRunpodJob(EP, { a: 1 }, { policy: { executionTimeoutMs: 600_000, ttlMs: 3_600_000 } });
    await submitRunpodJob(EP, { a: 1 }, { policy: { ttlMs: 60_000 } });
    await submitRunpodJob(EP, { a: 1 }, { policy: {} });
    expect(calls.map((c) => JSON.parse(c.init.body as string))).toEqual([
      { input: { a: 1 }, policy: { executionTimeout: 600_000, ttl: 3_600_000 } },
      { input: { a: 1 }, policy: { ttl: 60_000 } },
      { input: { a: 1 } },
    ]);
  });

  it("rejects an unreasonable policy before sending", async () => {
    for (const policy of [
      { executionTimeoutMs: 0 },
      { executionTimeoutMs: 4_999 }, // Runpod minimum is 5 s
      { ttlMs: 9_999 }, // Runpod minimum is 10 s
      { ttlMs: -5 },
      { ttlMs: 10_000.5 },
      { executionTimeoutMs: 7 * 24 * 3600 * 1000 + 1 },
      { ttlMs: 7 * 24 * 3600 * 1000 + 1 },
    ]) {
      const e = await rpError(submitRunpodJob(EP, { a: 1 }, { policy }));
      expect([e.code, e.delivery]).toEqual(["invalid_request", "not_delivered"]);
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts the documented policy bounds exactly", async () => {
    responder = () => json(200, { id: "job-b" });
    const week = 7 * 24 * 3600 * 1000;
    await submitRunpodJob(EP, { a: 1 }, { policy: { executionTimeoutMs: 5_000, ttlMs: 10_000 } });
    await submitRunpodJob(EP, { a: 1 }, { policy: { executionTimeoutMs: week, ttlMs: week } });
    expect(calls).toHaveLength(2);
  });

  it("measures the 10 MB limit on the FINAL serialised body in UTF-8 bytes", async () => {
    responder = () => json(200, { id: "job-size" });
    const LIMIT = 10 * 1024 * 1024;
    const bodyLen = (blob: string, policy?: object) => Buffer.byteLength(JSON.stringify(policy ? { input: { blob }, policy } : { input: { blob } }), "utf8");
    // An input that fits on its own…
    const blob = "x".repeat(LIMIT - bodyLen(""));
    expect(bodyLen(blob)).toBe(LIMIT);
    await submitRunpodJob(EP, { blob });
    expect(calls).toHaveLength(1);
    // …is refused once the policy pushes the whole body past the limit.
    const e = await rpError(submitRunpodJob(EP, { blob }, { policy: { ttlMs: 60_000 } }));
    expect([e.code, e.delivery]).toEqual(["invalid_request", "not_delivered"]);
    // Bytes, not characters: 6M two-byte characters is 12 MB.
    expect((await rpError(submitRunpodJob(EP, { blob: "é".repeat(6 * 1024 * 1024) }))).code).toBe("invalid_request");
    expect(calls).toHaveLength(1);
  });

  it("a 2xx without a job id is AMBIGUOUS — the job may exist", async () => {
    responder = () => json(200, { status: "IN_QUEUE" });
    const e = await rpError(submitRunpodJob(EP, { a: 1 }));
    expect([e.code, e.delivery, e.safeToResubmit]).toEqual(["malformed_response", "unknown", false]);
  });

  it("an unparsable 2xx is ambiguous too", async () => {
    responder = () => json(200, "<html>gateway</html>");
    expect((await rpError(submitRunpodJob(EP, { a: 1 }))).delivery).toBe("unknown");
  });

  it("an unexpected status word in the submit reply does not hide the job id", async () => {
    responder = () => json(200, { id: "job-x", status: "QUEUED_SOMEHOW" });
    expect(await submitRunpodJob(EP, { a: 1 })).toEqual({ remoteJobId: "job-x", status: null });
  });

  it.each([
    [401, "rejected"],
    [404, "rejected"],
    [429, "rejected"],
    [500, "unknown"],
    [502, "unknown"],
  ])("HTTP %i → delivery %s, and /run is never re-sent", async (status, delivery) => {
    responder = () => json(status as number, { error: "nope" });
    const e = await rpError(submitRunpodJob(EP, { a: 1 }));
    expect([e.code, e.httpStatus, e.delivery]).toEqual(["http", status, delivery]);
    expect(calls).toHaveLength(1);
  });

  it("connection refused / DNS / connect timeout prove the request never arrived", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
      calls = [];
      responder = () => { throw netError(code); };
      const e = await rpError(submitRunpodJob(EP, { a: 1 }));
      expect([e.code, e.delivery, e.safeToResubmit]).toEqual(["network", "not_delivered", true]);
      expect(calls).toHaveLength(1);
    }
  });

  it("a reset or bare 'fetch failed' is ambiguous — it can happen after the request was sent", async () => {
    for (const err of [netError("ECONNRESET"), netError("UND_ERR_SOCKET"), new TypeError("fetch failed")]) {
      calls = [];
      responder = () => { throw err; };
      const e = await rpError(submitRunpodJob(EP, { a: 1 }));
      expect([e.delivery, e.safeToResubmit]).toEqual(["unknown", false]);
      expect(calls).toHaveLength(1); // no blind retry of /run
    }
  });

  it("our own timeout after sending is ambiguous and not retried", async () => {
    responder = (c) => hang(c.init);
    const e = await rpError(submitRunpodJob(EP, { a: 1 }, { timeoutMs: 20 }));
    expect([e.code, e.delivery, e.safeToResubmit]).toEqual(["timeout", "unknown", false]);
    expect(calls).toHaveLength(1);
  });

  it("a caller abort before sending is not_delivered; after sending it is ambiguous", async () => {
    const pre = new AbortController();
    pre.abort();
    expect((await rpError(submitRunpodJob(EP, { a: 1 }, { signal: pre.signal }))).delivery).toBe("not_delivered");
    expect(calls).toHaveLength(0);

    const mid = new AbortController();
    responder = (c) => { setTimeout(() => mid.abort(new Error("run cancelled")), 5); return hang(c.init); };
    const e = await rpError(submitRunpodJob(EP, { a: 1 }, { signal: mid.signal }));
    expect([e.code, e.delivery]).toEqual(["aborted", "unknown"]);
  });

  it("refuses non-object or oversized input locally", async () => {
    expect((await rpError(submitRunpodJob(EP, [] as never))).delivery).toBe("not_delivered");
    expect((await rpError(submitRunpodJob(EP, { blob: "x".repeat(11 * 1024 * 1024) }))).code).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("provesNotDelivered is strict", () => {
    expect(provesNotDelivered(netError("ECONNREFUSED"))).toBe(true);
    expect(provesNotDelivered(netError("ECONNRESET"))).toBe(false);
    expect(provesNotDelivered(new TypeError("fetch failed"))).toBe(false);
    expect(provesNotDelivered(new Error("ECONNREFUSED in a message only"))).toBe(false);
  });
});

describe("status (GET /status/{id})", () => {
  const statusBody = (status: string, extra: Record<string, unknown> = {}) => ({ id: "job-1", status, ...extra });

  it.each(["IN_QUEUE", "IN_PROGRESS", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"] as RunpodJobStatus[])(
    "parses %s",
    async (s) => {
      responder = () => json(200, statusBody(s));
      const st = await getRunpodJobStatus(EP, "job-1");
      expect(st.status).toBe(s);
      expect(calls[0].url).toBe(`${BASE}/status/job-1`);
      expect(calls[0].init.method).toBe("GET");
    }
  );

  it("preserves output, executionTime and delayTime on COMPLETED", async () => {
    const output = { video_url: "https://x/y.mp4", frames: 121, meta: { seed: 7 } };
    responder = () => json(200, statusBody("COMPLETED", { output, executionTime: 81234, delayTime: 1520, workerId: "w1" }));
    expect(await getRunpodJobStatus(EP, "job-1")).toEqual({ id: "job-1", status: "COMPLETED", output, executionTimeMs: 81234, delayTimeMs: 1520 });
  });

  it("preserves error on FAILED", async () => {
    responder = () => json(200, statusBody("FAILED", { error: "CUDA out of memory" }));
    expect(await getRunpodJobStatus(EP, "job-1")).toMatchObject({ status: "FAILED", error: "CUDA out of memory" });
  });

  it("an unknown status is an error naming the value — never guessed", async () => {
    responder = () => json(200, statusBody("WARMING_UP"));
    const e = await rpError(getRunpodJobStatus(EP, "job-1"));
    expect(e.code).toBe("unknown_status");
    expect(e.message).toContain('"WARMING_UP"');
  });

  it("rejects malformed responses", async () => {
    for (const body of ["not json", [1, 2], { status: "COMPLETED" }, { id: "other-job", status: "COMPLETED" }, { id: "job-1" }]) {
      responder = () => json(200, body);
      const e = await rpError(getRunpodJobStatus(EP, "job-1", { retryBaseDelayMs: 1 }));
      expect(["malformed_response", "unknown_status"]).toContain(e.code);
    }
  });

  it("retries 429 / 5xx / transport failures, then succeeds", async () => {
    const answers = [() => json(429, "slow down", { "retry-after": "0" }), () => { throw netError("ECONNRESET"); }];
    responder = (_c, n) => (n <= 2 ? answers[n - 1]() : json(200, statusBody("RUNNING")));
    // 3 attempts max: 429 → transport reset → success (a read is safe to repeat)
    expect((await getRunpodJobStatus(EP, "job-1", { retryBaseDelayMs: 1 })).status).toBe("RUNNING");
    expect(calls).toHaveLength(3);
  });

  it("gives up after its attempts and reports the last HTTP error", async () => {
    responder = () => json(500, "down");
    const e = await rpError(getRunpodJobStatus(EP, "job-1", { retryBaseDelayMs: 1 }));
    expect([e.httpStatus, calls.length]).toEqual([500, 3]);
  });

  it("does not retry a definitive 401 / 404", async () => {
    for (const s of [401, 404]) {
      calls = [];
      responder = () => json(s, { error: "x" });
      const e = await rpError(getRunpodJobStatus(EP, "job-1", { retryBaseDelayMs: 1 }));
      expect([e.httpStatus, calls.length]).toEqual([s, 1]);
    }
  });
});

describe("cancel (POST /cancel/{id})", () => {
  it("returns the validated state Runpod reports", async () => {
    responder = () => json(200, { id: "job-1", status: "CANCELLED" });
    const st = await cancelRunpodJob(EP, "job-1");
    expect(st.status).toBe("CANCELLED");
    expect(calls[0]).toMatchObject({ url: `${BASE}/cancel/job-1`, init: { method: "POST" } });
  });

  it("a job that already finished is reported as finished, not cancelled", async () => {
    responder = () => json(200, { id: "job-1", status: "COMPLETED", output: { ok: true } });
    expect((await cancelRunpodJob(EP, "job-1")).status).toBe("COMPLETED");
  });

  it("a malformed cancel reply is an error, not a cancellation", async () => {
    for (const body of [{}, { id: "job-1" }, { id: "job-1", status: "STOPPING" }, "ok"]) {
      responder = () => json(200, body);
      await rpError(cancelRunpodJob(EP, "job-1", { retryBaseDelayMs: 1 }));
    }
  });

  it("re-sends only what provably did not act: an undelivered request or an explicit 429", async () => {
    const ok = () => json(200, { id: "job-1", status: "CANCELLED" });
    responder = (_c, n) => (n === 1 ? (() => { throw netError("ECONNREFUSED"); })() : ok());
    expect((await cancelRunpodJob(EP, "job-1", { retryBaseDelayMs: 1 })).status).toBe("CANCELLED");
    expect(calls).toHaveLength(2);

    calls = [];
    responder = (_c, n) => (n === 1 ? json(429, "slow") : ok());
    expect((await cancelRunpodJob(EP, "job-1", { retryBaseDelayMs: 1 })).status).toBe("CANCELLED");
    expect(calls).toHaveLength(2);
  });

  it("never replays an ambiguous cancel — 5xx, reset or timeout come back as delivery 'unknown'", async () => {
    const cases: [string, (c: Call) => Promise<Response> | Response][] = [
      ["5xx", () => json(503, "busy")],
      ["reset", () => { throw netError("ECONNRESET"); }],
      ["timeout", (c) => hang(c.init)],
    ];
    for (const [, answer] of cases) {
      calls = [];
      responder = answer;
      const e = await rpError(cancelRunpodJob(EP, "job-1", { retryBaseDelayMs: 1, timeoutMs: 20 }));
      expect(e.delivery).toBe("unknown");
      expect(calls).toHaveLength(1);
    }
  });

  it("an explicit 4xx is reported as such, not retried", async () => {
    responder = () => json(404, { error: "job not found" });
    const e = await rpError(cancelRunpodJob(EP, "job-1", { retryBaseDelayMs: 1 }));
    expect([e.httpStatus, e.delivery, calls.length]).toEqual([404, "rejected", 1]);
  });
});

describe("health (GET /health)", () => {
  it("returns the documented job and worker counters", async () => {
    const body = { jobs: { completed: 9, failed: 1, inProgress: 1, inQueue: 2, retried: 0 }, workers: { idle: 1, running: 1 } };
    responder = () => json(200, body);
    expect(await getRunpodEndpointHealth(EP)).toEqual(body);
    expect(calls[0].url).toBe(`${BASE}/health`);
  });

  it("validates documented counters when present, tolerates missing ones and future extras", async () => {
    responder = () => json(200, { jobs: { inQueue: 0, throttled: 3, note: "x" }, workers: { idle: 0, initializing: 2 } });
    expect(await getRunpodEndpointHealth(EP)).toEqual({ jobs: { inQueue: 0, throttled: 3 }, workers: { idle: 0, initializing: 2 } });
    for (const bad of [
      { jobs: { inQueue: "2" }, workers: {} },
      { jobs: { completed: -1 }, workers: {} },
      { jobs: {}, workers: { running: 1.5 } },
      { jobs: {} },
      { jobs: [], workers: {} },
    ]) {
      responder = () => json(200, bad);
      expect((await rpError(getRunpodEndpointHealth(EP, { retryBaseDelayMs: 1 }))).code).toBe("malformed_response");
    }
  });
});

describe("secrecy", () => {
  it("the API key never appears in an error message, even when Runpod echoes it", async () => {
    const msgs: string[] = [];
    responder = () => json(401, { error: `invalid key ${KEY}` });
    msgs.push((await rpError(submitRunpodJob(EP, { a: 1 }))).message);
    msgs.push((await rpError(getRunpodJobStatus(EP, "job-1"))).message);
    responder = () => { throw new TypeError(`fetch failed for Bearer ${KEY}`, { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }); };
    msgs.push((await rpError(submitRunpodJob(EP, { a: 1 }))).message);
    for (const m of msgs) {
      expect(m).not.toContain(KEY);
    }
    expect(msgs[0]).toContain("[REDACTED]");
  });

  it("the module has no logger to leak into", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./runpod-manager.ts", import.meta.url), "utf-8");
    expect(src).not.toMatch(/from "\.\.\/logger"|console\./);
  });
});

describe("waitForRunpodTerminalStatus", () => {
  it("polls until a terminal status and reports every state", async () => {
    const seq = ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"];
    responder = (_c, n) => json(200, { id: "job-1", status: seq[Math.min(n, seq.length) - 1], ...(n >= 3 ? { output: { url: "u" } } : {}) });
    const seen: string[] = [];
    const st = await waitForRunpodTerminalStatus(EP, "job-1", { timeoutMs: 5_000, intervalMs: 1, onStatus: (s) => seen.push(s.status) });
    expect(st).toMatchObject({ status: "COMPLETED", output: { url: "u" } });
    expect(seen).toEqual(seq);
    expect(calls).toHaveLength(3);
  });

  it("stops at FAILED / CANCELLED / TIMED_OUT too", async () => {
    for (const s of ["FAILED", "CANCELLED", "TIMED_OUT"]) {
      calls = [];
      responder = () => json(200, { id: "job-1", status: s });
      expect((await waitForRunpodTerminalStatus(EP, "job-1", { timeoutMs: 1000, intervalMs: 1 })).status).toBe(s);
      expect(calls).toHaveLength(1);
    }
  });

  it("propagates an unknown status instead of waiting it out", async () => {
    responder = () => json(200, { id: "job-1", status: "MYSTERY" });
    expect((await rpError(waitForRunpodTerminalStatus(EP, "job-1", { timeoutMs: 1000, intervalMs: 1 }))).code).toBe("unknown_status");
  });

  it("times out with the last state, backs off, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    responder = () => json(200, { id: "job-1", status: "IN_PROGRESS" });
    const p = waitForRunpodTerminalStatus(EP, "job-1", { timeoutMs: 60_000, intervalMs: 5_000, maxIntervalMs: 20_000, backoffFactor: 2 });
    const settled = p.then(() => null, (e) => e);
    await vi.advanceTimersByTimeAsync(70_000);
    const e = await settled;
    expect(e).toBeInstanceOf(RunpodPollTimeoutError);
    expect((e as RunpodPollTimeoutError).lastState?.status).toBe("IN_PROGRESS");
    // 5s, 10s, 20s, 20s, then the remaining 5s → 6 polls in 60s instead of 12 at a fixed 5s.
    expect(calls).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an AbortSignal stops polling promptly and clears its timer", async () => {
    vi.useFakeTimers();
    responder = () => json(200, { id: "job-1", status: "IN_QUEUE" });
    const ctrl = new AbortController();
    const p = waitForRunpodTerminalStatus(EP, "job-1", { timeoutMs: 600_000, intervalMs: 30_000, signal: ctrl.signal });
    const settled = p.then(() => null, (e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    ctrl.abort();
    const e = (await settled) as RunpodError;
    expect([e.code, calls.length]).toEqual(["aborted", 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires a positive timeout — there is no unbounded wait", async () => {
    await expect(waitForRunpodTerminalStatus(EP, "job-1", { timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
  });
});

describe("Runpod → scene job status", () => {
  it.each([
    ["IN_QUEUE", "submitted"],
    ["IN_PROGRESS", "running"],
    ["RUNNING", "running"],
    ["COMPLETED", "succeeded"],
    ["FAILED", "failed"],
    ["TIMED_OUT", "failed"],
    ["CANCELLED", "cancelled"],
  ] as const)("%s → %s", (rp, sj) => {
    expect(runpodStatusToSceneJobStatus(rp)).toBe(sj);
  });

  it("terminal Runpod statuses map to terminal scene job statuses", () => {
    expect(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].every((s) => isTerminalRunpodStatus(s as RunpodJobStatus))).toBe(true);
    expect(["IN_QUEUE", "IN_PROGRESS", "RUNNING"].some((s) => isTerminalRunpodStatus(s as RunpodJobStatus))).toBe(false);
  });
});

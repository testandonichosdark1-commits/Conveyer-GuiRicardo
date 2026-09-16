import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Unit tests for the shared HTTP transport (./http): per-request timeout + the
 * billable-vs-idempotent retry split + the retryStatus escape hatch (used by 69labs'
 * hourly-cap loop). Nothing here touches the network — fetch is always stubbed.
 *
 * The load-bearing test is "a billable request is NOT retried on our own timeout": a naive
 * shared retry would re-send the POST and charge the customer twice.
 */

import { requestWithPolicy, textWithPolicy, isOurAbort, provesRequestNeverArrived } from "./http";

function res(opts: { ok: boolean; status?: number; text?: string }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    text: async () => opts.text ?? "body",
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

/** What our timeout ceiling actually produces when it fires (name drives isOurAbort). */
const timeoutError = () => new DOMException("operation timed out", "TimeoutError");

/** What Node's fetch produces when the socket never opened (the useful code lives in
 *  `cause`; the top-level message is a generic "fetch failed"). */
function connError(code = "ECONNREFUSED"): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}

const BILLABLE = { timeoutMs: 60_000, retryOnTimeout: false };
const IDEMPOTENT = { timeoutMs: 60_000, retryOnTimeout: true };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("requestWithPolicy — BILLABLE (retryOnTimeout: false)", () => {
  it("does NOT retry our own timeout: a re-send could create a second billable job", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw timeoutError();
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = requestWithPolicy("https://x/create", { method: "POST" }, "prov create", BILLABLE).then(
      () => null,
      (e: Error) => e
    );
    await vi.runAllTimersAsync();
    const err = await p;

    // THE money assertion: exactly one POST went out, so exactly one charge.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not retried \(a retry could create a second billable task\)/);
  });

  it("surfaces the timeout ceiling in the message", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutError(); }));
    const p = requestWithPolicy("https://x/create", { method: "POST" }, "prov create", BILLABLE);
    const assertion = expect(p).rejects.toThrow(/timed out after 60s/);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("DOES retry a genuine connection error — the request never reached the server", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n < 2) throw connError();
      return res({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = requestWithPolicy("https://x/create", { method: "POST" }, "prov create", BILLABLE);
    await vi.runAllTimersAsync();
    expect((await p).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry an UNKNOWN error on a billable request (outcome unknown → could double-bill)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("something odd"); // not a timeout, not a proven-never-arrived conn error
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      requestWithPolicy("https://x/create", { method: "POST" }, "prov create", BILLABLE)
    ).rejects.toThrow(/prov create: something odd/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("requestWithPolicy — IDEMPOTENT (retryOnTimeout: true)", () => {
  it("DOES retry our own timeout then succeeds — the dead-socket rescue", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n < 3) throw timeoutError();
      return res({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = requestWithPolicy("https://x/poll", {}, "prov poll", IDEMPOTENT);
    await vi.runAllTimersAsync();
    expect((await p).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after 3 attempts on a sustained timeout instead of hanging forever", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => { throw timeoutError(); });
    vi.stubGlobal("fetch", fetchMock);
    const p = requestWithPolicy("https://x/poll", {}, "prov poll", IDEMPOTENT);
    const assertion = expect(p).rejects.toThrow(/timed out after 60s/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("requestWithPolicy — status handling", () => {
  it("retries 429/5xx transparently when retryStatus is on (default), then returns ok", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchMock = vi.fn(async () => (++n < 2 ? res({ ok: false, status: 503 }) : res({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const p = requestWithPolicy("https://x/poll", {}, "prov poll", IDEMPOTENT);
    await vi.runAllTimersAsync();
    expect((await p).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retryStatus:false hands the throttle response back to the caller (no retry)", async () => {
    const fetchMock = vi.fn(async () => res({ ok: false, status: 429, text: "rate" }));
    vi.stubGlobal("fetch", fetchMock);
    // This is what 69labs relies on: it must SEE the 429 to run its hourly-cap wait loop.
    const r = await requestWithPolicy("https://x/create", { method: "POST" }, "prov create", {
      timeoutMs: 60_000,
      retryOnTimeout: false,
      retryStatus: false,
    });
    expect(r.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a permanent 4xx without retrying (caller decides what it means)", async () => {
    const fetchMock = vi.fn(async () => res({ ok: false, status: 401, text: "unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await requestWithPolicy("https://x/poll", {}, "prov poll", IDEMPOTENT);
    expect(r.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("per-request timeout is armed on every call", () => {
  it("passes a composed AbortSignal to fetch (a naked fetch would hang forever on a dead socket)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => res({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await requestWithPolicy("https://x/create", { method: "POST" }, "prov create", BILLABLE);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("a caller cancellation signal is honored (composed with our timeout)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      // Real fetch would reject on an already-aborted signal; emulate that.
      if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return res({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      requestWithPolicy("https://x/create", { method: "POST", signal: ctrl.signal }, "prov create", BILLABLE)
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("textWithPolicy", () => {
  it("returns the body on ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ ok: true, text: "hello" })));
    expect(await textWithPolicy("https://x", {}, "prov", IDEMPOTENT)).toBe("hello");
  });

  it("throws `${label} ${status}: body` on a non-retried non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ ok: false, status: 401, text: "nope" })));
    await expect(textWithPolicy("https://x", {}, "prov", IDEMPOTENT)).rejects.toThrow(/prov 401: nope/);
  });
});

describe("error classifiers", () => {
  it("isOurAbort recognizes TimeoutError / AbortError by name", () => {
    expect(isOurAbort(timeoutError())).toBe(true);
    expect(isOurAbort(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isOurAbort(connError())).toBe(false);
  });

  it("provesRequestNeverArrived digs the code out of the cause chain", () => {
    expect(provesRequestNeverArrived(connError("ECONNRESET"))).toBe(true);
    expect(provesRequestNeverArrived(connError("ENOTFOUND"))).toBe(true);
    expect(provesRequestNeverArrived(new Error("HTTP 500"))).toBe(false);
  });
});

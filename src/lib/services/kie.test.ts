import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Unit tests for the kie.ai request resilience layer (per-request timeout + the
 * billable-vs-idempotent retry split). Settings are mocked so the test is hermetic;
 * fetch is always stubbed — nothing here touches the network.
 *
 * The load-bearing test is "createTask is NOT retried on our own timeout": a naive
 * shared retry would re-send the billable POST and charge the customer twice.
 */
vi.mock("../settings", () => ({ getSetting: () => "test-value" }));

import { kiePost, kieGet } from "./kie";

function res(opts: { ok: boolean; status?: number; text?: string }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    text: async () => opts.text ?? JSON.stringify({ code: 200, data: { taskId: "t_1" } }),
  } as unknown as Response;
}

/** What AbortSignal.timeout actually produces when our ceiling fires. */
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

/** What Node's fetch produces when the socket never opened (real shape: the useful
 *  code lives in `cause`, the top-level message is a generic "fetch failed"). */
function connError(code = "ECONNREFUSED"): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("kiePost — BILLABLE createTask", () => {
  it("does NOT retry our own timeout: a re-send could create a second billable task", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw timeoutError();
    });
    vi.stubGlobal("fetch", fetchMock);

    // Capture the outcome without letting the message assertion short-circuit the
    // call-count check below — the COUNT is the thing that protects the customer.
    const p = kiePost("/api/v1/jobs/createTask", { model: "m" }).then(
      () => null,
      (e: Error) => e
    );
    await vi.runAllTimersAsync();
    const err = await p;

    // THE money assertion: exactly one POST reached kie.ai, so exactly one charge.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/not retried \(a retry could create a second billable task\)/);
  });

  it("surfaces the timeout ceiling in the message so an operator can read the log", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutError(); }));
    const p = kiePost("/api/v1/veo/generate", {});
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

    const p = kiePost<{ data?: { taskId?: string } }>("/api/v1/jobs/createTask", {});
    await vi.runAllTimersAsync();
    expect((await p).data?.taskId).toBe("t_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("DOES retry a 5xx — the server answered and rejected, so no task was created", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchMock = vi.fn(async () => (++n < 2 ? res({ ok: false, status: 503, text: "unavailable" }) : res({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const p = kiePost<{ data?: { taskId?: string } }>("/api/v1/jobs/createTask", {});
    await vi.runAllTimersAsync();
    expect((await p).data?.taskId).toBe("t_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails fast on a permanent 4xx without retrying", async () => {
    const fetchMock = vi.fn(async () => res({ ok: false, status: 401, text: "unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(kiePost("/api/v1/jobs/createTask", {})).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes a healthy fast request straight through with no retry", async () => {
    const fetchMock = vi.fn(async () => res({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await kiePost<{ data?: { taskId?: string } }>("/api/v1/jobs/createTask", {});
    expect(out.data?.taskId).toBe("t_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("kieGet — FREE, idempotent poll", () => {
  const poll = "/api/v1/jobs/recordInfo?taskId=t_1";
  const success = JSON.stringify({ code: 200, data: { state: "success", resultJson: '{"resultUrls":["u"]}' } });

  it("DOES retry our own timeout and then succeeds — this is the dead-socket rescue", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n < 3) throw timeoutError(); // two dead sockets in a row (e.g. after machine sleep)
      return res({ ok: true, text: success });
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = kieGet<{ data?: { state?: string } }>(poll);
    await vi.runAllTimersAsync();
    expect((await p).data?.state).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(3); // hung up twice, re-asked, got the answer
  });

  it("gives up after 3 attempts on a sustained timeout instead of hanging forever", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => { throw timeoutError(); });
    vi.stubGlobal("fetch", fetchMock);
    const p = kieGet(poll);
    const assertion = expect(p).rejects.toThrow(/timed out after 60s/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 429 rate limit and then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchMock = vi.fn(async () => (++n < 2 ? res({ ok: false, status: 429, text: "rate" }) : res({ ok: true, text: success })));
    vi.stubGlobal("fetch", fetchMock);
    const p = kieGet<{ data?: { state?: string } }>(poll);
    await vi.runAllTimersAsync();
    expect((await p).data?.state).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes a healthy fast poll straight through with no retry", async () => {
    const fetchMock = vi.fn(async () => res({ ok: true, text: success }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await kieGet<{ data?: { state?: string } }>(poll)).data?.state).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("per-request timeout is armed on every call", () => {
  it("passes an AbortSignal to fetch (a naked fetch would hang forever on a dead socket)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => res({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await kiePost("/api/v1/jobs/createTask", {});
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SUPPORTED_GEMINI_MODELS,
  RETIRED_GEMINI_MODELS,
  buildGeminiLadder,
  classifyGeminiError,
  callGemini,
} from "./gemini-models";

/** Pure, dependency-free — no settings, no DB, no keys. */
describe("buildGeminiLadder", () => {
  it("puts the configured model first, then unique live fallbacks", () => {
    expect(buildGeminiLadder("gemini-2.5-pro")).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  });

  it("self-heals duplicates: configured model already in the supported list", () => {
    // Goal 5 — no gemini-2.5-flash twice.
    expect(buildGeminiLadder("gemini-2.5-flash")).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  });

  it("never contains a retired model — even if it is the configured one", () => {
    const ladder = buildGeminiLadder("gemini-2.0-flash");
    expect(ladder).toEqual(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
    for (const m of ladder) expect(RETIRED_GEMINI_MODELS.has(m)).toBe(false);
  });

  it("falls back to the supported list for blank / whitespace input", () => {
    expect(buildGeminiLadder("")).toEqual([...SUPPORTED_GEMINI_MODELS]);
    expect(buildGeminiLadder("   ")).toEqual([...SUPPORTED_GEMINI_MODELS]);
    expect(buildGeminiLadder(null)).toEqual([...SUPPORTED_GEMINI_MODELS]);
  });

  it("no ladder ever references a gemini-2.0 model", () => {
    for (const input of ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-pro", ""]) {
      expect(buildGeminiLadder(input).some((m) => m.startsWith("gemini-2.0"))).toBe(false);
    }
  });
});

describe("classifyGeminiError", () => {
  it("treats 429 and 5xx as transient", () => {
    expect(classifyGeminiError("Gemini 503: overloaded")).toBe("transient");
    expect(classifyGeminiError("Gemini 429: rate limit")).toBe("transient");
    expect(classifyGeminiError("Gemini 500: internal")).toBe("transient");
    expect(classifyGeminiError("Gemini 504: gateway timeout")).toBe("transient");
  });

  it("treats retired-model 404 and other 4xx as permanent", () => {
    expect(classifyGeminiError("Gemini 404: models/gemini-2.0-flash is not found for API version v1beta")).toBe("permanent");
    expect(classifyGeminiError("Gemini 400: invalid argument")).toBe("permanent");
    expect(classifyGeminiError("Gemini 401: unauthorized")).toBe("permanent");
    expect(classifyGeminiError("Gemini 403: permission denied")).toBe("permanent");
  });

  it("treats timeouts and network drops as transient", () => {
    expect(classifyGeminiError("Gemini timeout after 45s")).toBe("transient");
    expect(classifyGeminiError("fetch failed")).toBe("transient");
    expect(classifyGeminiError("ECONNRESET")).toBe("transient");
  });

  it("treats an unrecognized error (e.g. malformed body) as permanent — no wasted backoff", () => {
    expect(classifyGeminiError("Unexpected end of JSON input")).toBe("permanent");
  });
});

/** Mock fetch so the single retry loop can be exercised without network or real sleeps. */
function fakeResponse(opts: { ok: boolean; status?: number; json?: unknown; text?: string }): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

/** URL → model name (…/models/<model>:generateContent?…). */
function modelFromUrl(url: string): string {
  return url.match(/models\/([^:]+):generateContent/)?.[1] ?? "";
}

const NO_BACKOFF = () => 0;

describe("callGemini (the single retry/failover loop)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns json + serving model on first success, with exactly one fetch", async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ ok: true, json: { ok: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    const { json, model } = await callGemini({ apiKey: "k", model: "gemini-2.5-flash", body: "{}" });
    expect(json).toEqual({ ok: 1 });
    expect(model).toBe("gemini-2.5-flash");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails over to the next live model on a transient 503", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(modelFromUrl(url));
      return seen.length === 1 ? fakeResponse({ ok: false, status: 503, text: "overloaded" }) : fakeResponse({ ok: true, json: { ok: 1 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const failures: string[] = [];
    const { model } = await callGemini({
      apiKey: "k", model: "gemini-2.5-flash", body: "{}", backoffMs: NO_BACKOFF,
      onFailure: (f) => failures.push(`${f.kind}:${f.model}`),
    });
    expect(seen).toEqual(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
    expect(model).toBe("gemini-2.5-flash-lite");
    expect(failures).toEqual(["transient:gemini-2.5-flash"]);
  });

  it("skips a model permanently on a 404 and never requests it again", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const m = modelFromUrl(url);
      seen.push(m);
      // gemini-2.5-flash 404s once; if the loop ever cycled back to it we'd see it twice.
      return m === "gemini-2.5-flash"
        ? fakeResponse({ ok: false, status: 404, text: "not found" })
        : fakeResponse({ ok: true, json: { ok: 1 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const failures: { kind: string; model: string }[] = [];
    // maxAttempts 4 would cycle, but the dead model must be dropped from the cycle.
    const { model } = await callGemini({
      apiKey: "k", model: "gemini-2.5-flash", body: "{}", maxAttempts: 4, backoffMs: NO_BACKOFF,
      onFailure: (f) => failures.push({ kind: f.kind, model: f.model }),
    });
    expect(model).toBe("gemini-2.5-flash-lite");
    expect(seen.filter((m) => m === "gemini-2.5-flash")).toHaveLength(1); // never re-requested
    expect(failures).toEqual([{ kind: "permanent", model: "gemini-2.5-flash" }]);
  });

  it("retries on a validate() throw (empty body) as a transient content blip", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => fakeResponse({ ok: true, json: { n: ++n } }));
    vi.stubGlobal("fetch", fetchMock);
    const { json } = await callGemini({
      apiKey: "k", model: "gemini-2.5-flash", body: "{}", maxAttempts: 3, backoffMs: NO_BACKOFF,
      validate: (j) => { if ((j as { n: number }).n < 2) throw new Error("empty response"); },
    });
    expect((json as { n: number }).n).toBe(2); // first (empty) retried, second accepted
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws the last error once the live models are exhausted", async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ ok: false, status: 503, text: "overloaded" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      callGemini({ apiKey: "k", model: "gemini-2.5-flash", body: "{}", backoffMs: NO_BACKOFF })
    ).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(SUPPORTED_GEMINI_MODELS.length); // one per live model
  });

  it("preserves a higher retry budget by cycling live models", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(modelFromUrl(url));
      return fakeResponse({ ok: false, status: 503, text: "overloaded" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      callGemini({ apiKey: "k", model: "gemini-2.5-flash", body: "{}", maxAttempts: 5, backoffMs: NO_BACKOFF })
    ).rejects.toThrow(/503/);
    // 5 attempts cycling [flash, flash-lite]: flash, flash-lite, flash, flash-lite, flash
    expect(seen).toEqual([
      "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash",
    ]);
  });
});

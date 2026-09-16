import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SUPPORTED_GEMINI_MODELS,
  RETIRED_GEMINI_MODELS,
  isRetiredGeminiModel,
  replacementForGeminiModel,
  buildGeminiLadder,
  classifyGeminiError,
  callGemini,
  preferredOrder,
  noteGeminiModelFailure,
  noteGeminiModelSuccess,
  resetGeminiModelHealth,
} from "./gemini-models";

/** Pure, dependency-free — no settings, no DB, no keys. */
describe("buildGeminiLadder", () => {
  it("puts a LIVE configured model first, then unique live fallbacks", () => {
    expect(buildGeminiLadder("gemini-3.1-pro-preview")).toEqual([
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
    ]);
  });

  it("self-heals duplicates: configured model already in the supported list", () => {
    // Goal 5 — no gemini-3.5-flash twice.
    expect(buildGeminiLadder("gemini-3.5-flash")).toEqual([
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
    ]);
  });

  it("never contains a retired model — even if it is the configured one", () => {
    const ladder = buildGeminiLadder("gemini-2.0-flash");
    expect(ladder).toEqual(["gemini-3.5-flash", "gemini-3.1-flash-lite"]);
    for (const m of ladder) expect(RETIRED_GEMINI_MODELS.has(m)).toBe(false);
  });

  it("substitutes the Gemini-3 replacement (by class) for a retired 2.5 model, first in the ladder", () => {
    // flash-lite class stays flash-lite, not whatever's first in the supported list.
    expect(buildGeminiLadder("gemini-2.5-flash-lite")).toEqual([
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash",
    ]);
    // flash class → 3.5-flash (dedups with the supported head).
    expect(buildGeminiLadder("gemini-2.5-flash")).toEqual([
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
    ]);
    // pro class → 3.1-pro-preview first (not in the supported list), then live flash fallbacks.
    expect(buildGeminiLadder("gemini-2.5-pro")).toEqual([
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
    ]);
  });

  it("falls back to the supported list for blank / whitespace input", () => {
    expect(buildGeminiLadder("")).toEqual([...SUPPORTED_GEMINI_MODELS]);
    expect(buildGeminiLadder("   ")).toEqual([...SUPPORTED_GEMINI_MODELS]);
    expect(buildGeminiLadder(null)).toEqual([...SUPPORTED_GEMINI_MODELS]);
  });

  it("no ladder ever references a gemini-2.0 or gemini-2.5 model", () => {
    for (const input of ["gemini-3.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", ""]) {
      const ladder = buildGeminiLadder(input);
      expect(ladder.some((m) => m.startsWith("gemini-2.0") || m.startsWith("gemini-2.5"))).toBe(false);
    }
  });
});

describe("retired-model helpers", () => {
  it("isRetiredGeminiModel flags the 2.0 + 2.5 families, not live 3.x models", () => {
    for (const m of ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"]) {
      expect(isRetiredGeminiModel(m)).toBe(true);
    }
    expect(isRetiredGeminiModel("  gemini-2.5-flash  ")).toBe(true); // trims
    for (const m of ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "", null, undefined]) {
      expect(isRetiredGeminiModel(m)).toBe(false);
    }
  });

  it("replacementForGeminiModel maps each retired id by class and passes live models through", () => {
    expect(replacementForGeminiModel("gemini-2.5-flash")).toBe("gemini-3.5-flash");
    expect(replacementForGeminiModel("gemini-2.5-flash-lite")).toBe("gemini-3.1-flash-lite");
    expect(replacementForGeminiModel("gemini-2.5-pro")).toBe("gemini-3.1-pro-preview");
    expect(replacementForGeminiModel("gemini-2.0-flash-lite")).toBe("gemini-3.1-flash-lite");
    expect(replacementForGeminiModel("gemini-3.5-flash")).toBe("gemini-3.5-flash"); // live → unchanged
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
  // Model health outlives a call BY DESIGN, so it also outlives a test. Clearing it here
  // keeps these cases independent of each other and of their order — the 404 case below
  // demotes a model for 30 minutes, which would otherwise silently reorder later tests.
  afterEach(() => {
    vi.unstubAllGlobals();
    resetGeminiModelHealth();
  });

  it("returns json + serving model on first success, with exactly one fetch", async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ ok: true, json: { ok: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    const { json, model } = await callGemini({ apiKey: "k", model: "gemini-3.5-flash", body: "{}" });
    expect(json).toEqual({ ok: 1 });
    expect(model).toBe("gemini-3.5-flash");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("can retry the configured model without cross-model fallback", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(modelFromUrl(url));
      return seen.length === 1
        ? fakeResponse({ ok: false, status: 503, text: "overloaded" })
        : fakeResponse({ ok: true, json: { ok: 1 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { model } = await callGemini({
      apiKey: "k",
      model: "gemini-3.1-flash-lite",
      body: "{}",
      maxAttempts: 2,
      allowModelFallback: false,
      backoffMs: NO_BACKOFF,
    });

    expect(model).toBe("gemini-3.1-flash-lite");
    expect(seen).toEqual(["gemini-3.1-flash-lite", "gemini-3.1-flash-lite"]);
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
      apiKey: "k", model: "gemini-3.5-flash", body: "{}", backoffMs: NO_BACKOFF,
      onFailure: (f) => failures.push(`${f.kind}:${f.model}`),
    });
    expect(seen).toEqual(["gemini-3.5-flash", "gemini-3.1-flash-lite"]);
    expect(model).toBe("gemini-3.1-flash-lite");
    expect(failures).toEqual(["transient:gemini-3.5-flash"]);
  });

  it("skips a model permanently on a 404 and never requests it again", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const m = modelFromUrl(url);
      seen.push(m);
      // gemini-3.5-flash 404s once; if the loop ever cycled back to it we'd see it twice.
      return m === "gemini-3.5-flash"
        ? fakeResponse({ ok: false, status: 404, text: "not found" })
        : fakeResponse({ ok: true, json: { ok: 1 } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const failures: { kind: string; model: string }[] = [];
    // maxAttempts 4 would cycle, but the dead model must be dropped from the cycle.
    const { model } = await callGemini({
      apiKey: "k", model: "gemini-3.5-flash", body: "{}", maxAttempts: 4, backoffMs: NO_BACKOFF,
      onFailure: (f) => failures.push({ kind: f.kind, model: f.model }),
    });
    expect(model).toBe("gemini-3.1-flash-lite");
    expect(seen.filter((m) => m === "gemini-3.5-flash")).toHaveLength(1); // never re-requested
    expect(failures).toEqual([{ kind: "permanent", model: "gemini-3.5-flash" }]);
  });

  it("retries on a validate() throw (empty body) as a transient content blip", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => fakeResponse({ ok: true, json: { n: ++n } }));
    vi.stubGlobal("fetch", fetchMock);
    const { json } = await callGemini({
      apiKey: "k", model: "gemini-3.5-flash", body: "{}", maxAttempts: 3, backoffMs: NO_BACKOFF,
      validate: (j) => { if ((j as { n: number }).n < 2) throw new Error("empty response"); },
    });
    expect((json as { n: number }).n).toBe(2); // first (empty) retried, second accepted
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws the last error once the live models are exhausted", async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ ok: false, status: 503, text: "overloaded" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      callGemini({ apiKey: "k", model: "gemini-3.5-flash", body: "{}", backoffMs: NO_BACKOFF })
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
      callGemini({ apiKey: "k", model: "gemini-3.5-flash", body: "{}", maxAttempts: 5, backoffMs: NO_BACKOFF })
    ).rejects.toThrow(/503/);
    // 5 attempts cycling [flash, flash-lite]: flash, flash-lite, flash, flash-lite, flash
    expect(seen).toEqual([
      "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash",
    ]);
  });
});

/**
 * Model health that OUTLIVES the call.
 *
 * `callGemini`'s own `dead` set is per-call, so before this a model broken for a whole
 * install was re-tried first on every call — and a run makes dozens. An operator saw
 * exactly that: the configured model "constantly" failing, the system "always" falling
 * back, every planner chunk paying the 4 s backoff on the way.
 *
 * The load-bearing property is the last case: demote, never remove. Filtering a failing
 * model out of the ladder would leave nothing to call when everything is failing.
 */
describe("cross-call model health", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetGeminiModelHealth();
  });

  const LADDER = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];

  it("a permanent failure moves the model to the back of the NEXT call's ladder", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const m = modelFromUrl(url);
        seen.push(m);
        return m === "gemini-3.5-flash"
          ? fakeResponse({ ok: false, status: 404, text: "not found" })
          : fakeResponse({ ok: true, json: { ok: 1 } });
      })
    );
    const opts = { apiKey: "k", model: "gemini-3.5-flash", body: "{}", backoffMs: NO_BACKOFF };
    await callGemini(opts);
    expect(seen).toEqual(["gemini-3.5-flash", "gemini-3.1-flash-lite"]);

    seen.length = 0;
    await callGemini(opts); // the whole point: the second call must not re-try the broken one first
    expect(seen).toEqual(["gemini-3.1-flash-lite"]);
  });

  it("one transient failure is NOT enough to demote — a busy minute is not a broken model", () => {
    noteGeminiModelFailure("gemini-3.5-flash", "transient");
    expect(preferredOrder(LADDER)).toEqual(LADDER);
    noteGeminiModelFailure("gemini-3.5-flash", "transient");
    expect(preferredOrder(LADDER)).toEqual(LADDER);
    noteGeminiModelFailure("gemini-3.5-flash", "transient"); // third in a row
    expect(preferredOrder(LADDER)).toEqual(["gemini-3.1-flash-lite", "gemini-3.5-flash"]);
  });

  it("a success clears the record, so a recovered model leads again", () => {
    noteGeminiModelFailure("gemini-3.5-flash", "permanent");
    expect(preferredOrder(LADDER)).toEqual(["gemini-3.1-flash-lite", "gemini-3.5-flash"]);
    noteGeminiModelSuccess("gemini-3.5-flash");
    expect(preferredOrder(LADDER)).toEqual(LADDER);
  });

  it("transient failures are counted CONSECUTIVELY — a success in between resets the tally", () => {
    noteGeminiModelFailure("gemini-3.5-flash", "transient");
    noteGeminiModelFailure("gemini-3.5-flash", "transient");
    noteGeminiModelSuccess("gemini-3.5-flash");
    noteGeminiModelFailure("gemini-3.5-flash", "transient");
    expect(preferredOrder(LADDER)).toEqual(LADDER); // tally restarted, nowhere near the threshold
  });

  it("when EVERY model is demoted the ladder is left intact — demote, never remove", async () => {
    for (const m of LADDER) noteGeminiModelFailure(m, "permanent");
    expect(preferredOrder(LADDER)).toEqual(LADDER);

    // And a call still happens: a total outage must not turn into "tried nothing".
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(modelFromUrl(url));
        return fakeResponse({ ok: true, json: { ok: 1 } });
      })
    );
    const { model } = await callGemini({ apiKey: "k", model: "gemini-3.5-flash", body: "{}", backoffMs: NO_BACKOFF });
    expect(model).toBe("gemini-3.5-flash");
    expect(seen).toEqual(["gemini-3.5-flash"]);
  });

  it("healthy models keep their configured order — nothing changes when nothing fails", () => {
    expect(preferredOrder(LADDER)).toEqual(LADDER);
    expect(preferredOrder(["gemini-3.1-pro-preview", ...LADDER])).toEqual(["gemini-3.1-pro-preview", ...LADDER]);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Runware client — request shape, response parsing, cost extraction and the
 * retry policy. `fetch` is stubbed throughout; no network, no DB writes.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path that vitest
 * does not resolve.
 */

const settings: Record<string, string> = {};
vi.mock("../settings", () => ({
  getSetting: (k: string) => settings[k] ?? "",
}));
vi.mock("../logger", () => ({ log: () => {} }));

import { generateRunwareImage, runwareSize, runwareConfigured, isTransientRunwareError, pickAllowedSize } from "./runware";

/** A well-formed success envelope for one image. */
function ok(body: { imageURL?: string; cost?: number } = {}) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        data: [
          {
            taskType: "imageInference",
            taskUUID: "11111111-1111-4111-8111-111111111111",
            imageUUID: "22222222-2222-4222-8222-222222222222",
            imageURL: body.imageURL ?? "https://im.runware.ai/image/ws/2/ii/abc.png",
            ...(body.cost === undefined ? {} : { cost: body.cost }),
          },
        ],
      }),
  } as unknown as Response;
}

function httpError(status: number, body = "nope") {
  return { ok: false, status, text: async () => body } as unknown as Response;
}

/** The parsed JSON body of the Nth fetch call. */
function sentTask(mock: ReturnType<typeof vi.fn>, n = 0) {
  return JSON.parse((mock.mock.calls[n][1] as RequestInit).body as string)[0];
}

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  settings.RUNWARE_API_KEY = "rw-test-key";
  settings.RUNWARE_IMAGE_MODEL = "runware:101@1";
  settings.RUNWARE_RETRIES = "2";
  settings.RUNWARE_CONCURRENCY = "3";
  // Fake timers so the retry backoff (1s, 2s, …) costs no wall-clock time. Tests
  // that actually retry drive it with advanceTimersByTimeAsync; the 180s request
  // timeout never fires because no test advances anywhere near that far.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runwareConfigured", () => {
  it("is the API-key gate, and treats whitespace as unset", () => {
    expect(runwareConfigured()).toBe(true);
    settings.RUNWARE_API_KEY = "   ";
    expect(runwareConfigured()).toBe(false);
    settings.RUNWARE_API_KEY = "";
    expect(runwareConfigured()).toBe(false);
  });
});

describe("runwareSize", () => {
  it("snaps both sides to a multiple of 64 — Runware takes pixels, not an aspect string", () => {
    // 1080 is NOT divisible by 64 (16.875); 1088 is the nearest legal value.
    expect(runwareSize("1920x1080")).toEqual({ width: 1920, height: 1088 });
    expect(runwareSize("1080x1920")).toEqual({ width: 1088, height: 1920 });
    expect(runwareSize("1080x1080")).toEqual({ width: 1088, height: 1088 });
  });

  it("keeps the aspect error imperceptible (<1%) for the standard formats", () => {
    const landscape = runwareSize("1920x1080");
    const err = Math.abs(landscape.width / landscape.height - 1920 / 1080) / (1920 / 1080);
    expect(err).toBeLessThan(0.01);
  });

  it("clamps to Runware's documented 128–2048 band", () => {
    expect(runwareSize("3840x2160")).toEqual({ width: 2048, height: 2048 });
    expect(runwareSize("10x10")).toEqual({ width: 128, height: 128 });
  });

  it("falls back to 1080p for a missing or unparseable resolution", () => {
    expect(runwareSize(undefined)).toEqual({ width: 1920, height: 1088 });
    expect(runwareSize("not-a-size")).toEqual({ width: 1920, height: 1088 });
  });
});

describe("isTransientRunwareError", () => {
  it("retries the documented capacity codes", () => {
    for (const s of [429, 500, 502, 503, 504]) {
      expect(isTransientRunwareError(`Runware ${s} (imageInference): busy`), String(s)).toBe(true);
    }
  });

  it("fails fast on permanent 4xx — retrying a bad key or model id cannot help", () => {
    for (const s of [400, 401, 403, 404]) {
      expect(isTransientRunwareError(`Runware ${s} (imageInference): bad`), String(s)).toBe(false);
    }
  });

  it("retries transport drops but NOT our own timeout (which may already be billed)", () => {
    expect(isTransientRunwareError("Runware network error (imageInference): fetch failed")).toBe(true);
    expect(isTransientRunwareError("Runware network error (imageInference): ECONNRESET")).toBe(true);
    expect(
      isTransientRunwareError("Runware imageInference: timed out after 180s — not retried (a retry could bill a second generation)")
    ).toBe(false);
  });

  it("reads the status after the name, not a digit inside the label", () => {
    // "3d" in the label must not be mistaken for a status.
    expect(isTransientRunwareError("Runware 400 (3dInference): bad")).toBe(false);
  });
});

describe("generateRunwareImage — request shape", () => {
  it("posts one imageInference task to the v1 endpoint with a Bearer key", async () => {
    const f = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);

    await generateRunwareImage("run1", "a lighthouse at dusk", { resolution: "1920x1080" });

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.runware.ai/v1");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer rw-test-key" });

    const body = JSON.parse((init as RequestInit).body as string);
    expect(Array.isArray(body), "the body is an ARRAY of tasks").toBe(true);
    expect(body).toHaveLength(1);
  });

  it("sends exactly the documented fields — includeCost on, one URL-delivered PNG", async () => {
    const f = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);

    await generateRunwareImage("run1", "a lighthouse at dusk", { resolution: "1920x1080" });

    const task = sentTask(f);
    expect(task).toMatchObject({
      taskType: "imageInference",
      model: "runware:101@1",
      positivePrompt: "a lighthouse at dusk",
      width: 1920,
      height: 1088,
      numberResults: 1,
      outputType: "URL",
      outputFormat: "PNG",
      includeCost: true,
    });
    expect(task.taskUUID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("omits negativePrompt unless one is given (an empty field is not sent)", async () => {
    const f = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);

    await generateRunwareImage("run1", "p");
    expect(sentTask(f)).not.toHaveProperty("negativePrompt");

    await generateRunwareImage("run1", "p", { negativePrompt: "   " });
    expect(sentTask(f, 1)).not.toHaveProperty("negativePrompt");

    await generateRunwareImage("run1", "p", { negativePrompt: "no text, no logos" });
    expect(sentTask(f, 2).negativePrompt).toBe("no text, no logos");
  });

  it("honors an explicit model override, else the setting, else the registry default", async () => {
    const f = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);

    await generateRunwareImage("run1", "p", { model: "google:4@2" });
    expect(sentTask(f).model).toBe("google:4@2");

    settings.RUNWARE_IMAGE_MODEL = "";
    await generateRunwareImage("run1", "p");
    // Falls back to defaultAiModel("runware", "image") — the registry's recommended id.
    expect(sentTask(f, 1).model).toBe("runware:101@1");
  });

  it("caps the prompt at 5000 characters", async () => {
    const f = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);
    await generateRunwareImage("run1", "x".repeat(9000));
    expect(sentTask(f).positivePrompt).toHaveLength(5000);
  });

  it("refuses to start without an API key — no billable call is made", async () => {
    const f = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);
    settings.RUNWARE_API_KEY = "";
    await expect(generateRunwareImage("run1", "p")).rejects.toThrow(/RUNWARE_API_KEY is not set/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("generateRunwareImage — response handling", () => {
  it("returns the image URL and the REAL billed cost reported by includeCost", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ cost: 0.0051 })));
    const r = await generateRunwareImage("run1", "p", { resolution: "1920x1080" });
    expect(r.url).toBe("https://im.runware.ai/image/ws/2/ii/abc.png");
    expect(r.cost).toBe(0.0051);
    expect(r.model).toBe("runware:101@1");
    expect({ width: r.width, height: r.height }).toEqual({ width: 1920, height: 1088 });
  });

  it("reports cost as null when Runware did not return one — never a fabricated number", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    expect((await generateRunwareImage("run1", "p")).cost).toBeNull();
  });

  it("surfaces an `errors` envelope even when it arrives with HTTP 200", async () => {
    // The trap kie.ts's parseKie exists for: an application error masquerading as success.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ errors: [{ code: "invalidModel", message: "Model not found", parameter: "model" }] }),
      } as unknown as Response)
    );
    await expect(generateRunwareImage("run1", "p")).rejects.toThrow(/invalidModel.*Model not found.*parameter: model/);
  });

  it("throws on a success envelope with no imageURL rather than returning an empty result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) } as unknown as Response)
    );
    await expect(generateRunwareImage("run1", "p")).rejects.toThrow(/no imageURL/);
  });

  it("throws on a non-JSON body instead of failing obscurely later", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "<html>gateway</html>" } as unknown as Response)
    );
    await expect(generateRunwareImage("run1", "p")).rejects.toThrow(/non-JSON response/);
  });
});

describe("generateRunwareImage — retry policy", () => {
  it("retries a 429 and succeeds, honoring RUNWARE_RETRIES", async () => {
    const f = vi.fn().mockResolvedValueOnce(httpError(429, "queue full")).mockResolvedValueOnce(ok({ cost: 0.005 }));
    vi.stubGlobal("fetch", f);
    const p = generateRunwareImage("run1", "p");
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await p;
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.cost).toBe(0.005);
  });

  it("gives up after retries + 1 attempts", async () => {
    settings.RUNWARE_RETRIES = "2";
    const f = vi.fn().mockResolvedValue(httpError(503, "capacity"));
    vi.stubGlobal("fetch", f);
    // Assert BEFORE advancing: the rejection lands mid-advance, and a promise with
    // no handler attached yet surfaces as an unhandled rejection.
    const settled = expect(generateRunwareImage("run1", "p")).rejects.toThrow(/Runware 503/);
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
    expect(f).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does not retry a permanent 401 — one attempt only", async () => {
    const f = vi.fn().mockResolvedValue(httpError(401, "bad key"));
    vi.stubGlobal("fetch", f);
    await expect(generateRunwareImage("run1", "p")).rejects.toThrow(/Runware 401/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rejected task — a model-id error repeats identically", async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ errors: [{ code: "invalidModel", message: "nope" }] }),
    } as unknown as Response);
    vi.stubGlobal("fetch", f);
    await expect(generateRunwareImage("run1", "p")).rejects.toThrow(/invalidModel/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("NEVER re-sends after OUR OWN timeout — a retry could bill a second generation", async () => {
    // The rule taken from kie.ts's BILLABLE_POST: an aborted billable request may
    // already have reached Runware and been charged for.
    const abort = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    const f = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal("fetch", f);
    await expect(generateRunwareImage("run1", "p")).rejects.toThrow(/not retried/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries a transport error that proves the request never landed", async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", f);
    const p = generateRunwareImage("run1", "p");
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toBeTruthy();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

// ── Per-model constraints learned from the API ──────────────────────────────
/**
 * Two models in our own registry are rejected outright by a request that every other
 * model accepts, and both rejections were found live (2026-07-27) rather than in the
 * docs. Runware states the remedy in the rejection, so the client learns it instead of
 * carrying a hand-written capability table that would drift as models are added.
 *
 * Each test uses a DISTINCT model id: the memo is process-wide by design (one corrective
 * round trip per model, ever), so sharing an id between tests would leak state.
 */

/** The real `unsupportedDimensions` payload, trimmed to the fields we read. */
function unsupportedDimensions() {
  return httpError(
    400,
    JSON.stringify({
      data: [],
      errors: [
        {
          code: "unsupportedDimensions",
          message:
            "Unsupported use of width/height parameters. The specified dimensions are not supported for the selected model. Supported values are: '1024x1024', '1248x832', '832x1248', '768x1344', '1344x768'.",
          parameter: ["width", "height"],
          allowedValues: { "1:1": "1024x1024", "3:2": "1248x832", "2:3": "832x1248", "9:16": "768x1344", "16:9": "1344x768" },
        },
      ],
    })
  );
}

/** The real `unsupportedArchitectureNegativePrompt` payload (Seedream 4.0). */
function unsupportedNegative() {
  return httpError(
    400,
    JSON.stringify({
      data: [],
      errors: [
        {
          code: "unsupportedArchitectureNegativePrompt",
          message: "Unsupported use of 'negativePrompt' parameter. Negative prompt is not supported in this model architecture.",
          parameter: "negativePrompt",
          baseModelArchitecture: "seedream4",
        },
      ],
    })
  );
}

describe("pickAllowedSize", () => {
  const NANO = ["1024x1024", "1248x832", "832x1248", "1184x864", "864x1184", "896x1152", "1152x896", "768x1344", "1344x768", "1536x672"];

  it("matches the aspect ratio, not the pixel count", () => {
    expect(pickAllowedSize(NANO, { width: 1920, height: 1088 })).toEqual({ width: 1344, height: 768 });
    expect(pickAllowedSize(NANO, { width: 1088, height: 1920 })).toEqual({ width: 768, height: 1344 });
    expect(pickAllowedSize(NANO, { width: 1088, height: 1088 })).toEqual({ width: 1024, height: 1024 });
  });

  it("never picks a wider-still size just because it is bigger (1536x672 is 21:9, not 16:9)", () => {
    const got = pickAllowedSize(NANO, { width: 1920, height: 1088 })!;
    expect(got.width / got.height).toBeCloseTo(16 / 9, 1);
  });

  it("takes the SMALLEST size that avoids upscaling, not the largest on offer", () => {
    // Nano Banana Pro's real 16:9 ladder. 5504x3072 is 16.9MP for a 2MP video —
    // 8x the pixels and, measured live, ~2x the price and ~2x the wall clock.
    const pro = ["1376x768", "2752x1536", "5504x3072"];
    expect(pickAllowedSize(pro, { width: 1920, height: 1088 })).toEqual({ width: 2752, height: 1536 });
  });

  it("upscales the least when nothing on the menu is big enough", () => {
    // 640x360 is fractionally the closer aspect (0.74% off vs 0.84%), but treating that
    // as a win would buy an invisible improvement with a visible 3x upscale.
    expect(pickAllowedSize(["640x360", "1344x768"], { width: 1920, height: 1088 })).toEqual({ width: 1344, height: 768 });
  });

  it("still rejects a genuinely different shape, however large", () => {
    // 21:9 is 30% off — outside the tolerance, so it loses to the smaller 16:9.
    expect(pickAllowedSize(["1536x672", "1344x768"], { width: 1920, height: 1088 })).toEqual({ width: 1344, height: 768 });
  });

  it("returns null for an unusable list rather than inventing a size", () => {
    expect(pickAllowedSize([], { width: 1920, height: 1088 })).toBeNull();
    expect(pickAllowedSize(["wat"], { width: 1920, height: 1088 })).toBeNull();
  });
});

describe("a model that constrains dimensions", () => {
  it("re-sends at an allowed size and succeeds — the beat is not lost", async () => {
    const f = vi.fn().mockResolvedValueOnce(unsupportedDimensions()).mockResolvedValueOnce(ok({ cost: 0.039 }));
    vi.stubGlobal("fetch", f);
    const img = await generateRunwareImage("run1", "p", { resolution: "1920x1080", model: "test:dims@1" });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sentTask(f, 0)).toMatchObject({ width: 1920, height: 1088 });
    expect(sentTask(f, 1)).toMatchObject({ width: 1344, height: 768 });
    // The reported size is the one actually generated, so logs and Ken Burns agree.
    expect(img).toMatchObject({ width: 1344, height: 768, cost: 0.039 });
  });

  it("charges the correction to the FIRST beat only — the constraint is remembered", async () => {
    const f = vi.fn().mockResolvedValueOnce(unsupportedDimensions()).mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);
    await generateRunwareImage("run1", "p", { resolution: "1920x1080", model: "test:dims@2" });
    await generateRunwareImage("run1", "p", { resolution: "1920x1080", model: "test:dims@2" });
    expect(f).toHaveBeenCalledTimes(3); // 2 for the first image, 1 for the second
    expect(sentTask(f, 2)).toMatchObject({ width: 1344, height: 768 });
  });

  it("re-sends ONCE — a second identical rejection is surfaced, never looped on", async () => {
    const f = vi.fn().mockResolvedValue(unsupportedDimensions());
    vi.stubGlobal("fetch", f);
    await expect(generateRunwareImage("run1", "p", { resolution: "1920x1080", model: "test:dims@3" })).rejects.toThrow(
      /unsupportedDimensions/
    );
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("surfaces the error untouched when the payload names no usable size", async () => {
    const bare = httpError(400, JSON.stringify({ data: [], errors: [{ code: "unsupportedDimensions", message: "no." }] }));
    const f = vi.fn().mockResolvedValue(bare);
    vi.stubGlobal("fetch", f);
    await expect(generateRunwareImage("run1", "p", { model: "test:dims@4" })).rejects.toThrow(/unsupportedDimensions/);
    expect(f).toHaveBeenCalledTimes(1); // nothing was learned — no point re-sending
  });
});

describe("a model that refuses negativePrompt", () => {
  it("re-sends with the bans folded back into the positive prompt, not dropped", async () => {
    const f = vi.fn().mockResolvedValueOnce(unsupportedNegative()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", f);
    await generateRunwareImage("run1", "a lighthouse", {
      negativePrompt: "text, watermark",
      fallbackPrompt: "a lighthouse, absolutely no text, no watermark",
      model: "test:neg@1",
    });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sentTask(f, 0)).toMatchObject({ positivePrompt: "a lighthouse", negativePrompt: "text, watermark" });
    const second = sentTask(f, 1);
    expect(second.negativePrompt).toBeUndefined();
    // The ban survives the switch — this is the whole point of fallbackPrompt.
    expect(second.positivePrompt).toBe("a lighthouse, absolutely no text, no watermark");
  });

  it("still generates when the caller supplied no fallback, minus the bans", async () => {
    const f = vi.fn().mockResolvedValueOnce(unsupportedNegative()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", f);
    await generateRunwareImage("run1", "a lighthouse", { negativePrompt: "text", model: "test:neg@2" });
    expect(sentTask(f, 1)).toMatchObject({ positivePrompt: "a lighthouse" });
    expect(sentTask(f, 1).negativePrompt).toBeUndefined();
  });

  it("remembers the refusal, so later beats never send a negativePrompt at all", async () => {
    const f = vi.fn().mockResolvedValueOnce(unsupportedNegative()).mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);
    const opts = { negativePrompt: "text", fallbackPrompt: "p, no text", model: "test:neg@3" };
    await generateRunwareImage("run1", "p", opts);
    await generateRunwareImage("run1", "p", opts);
    expect(f).toHaveBeenCalledTimes(3);
    expect(sentTask(f, 2).negativePrompt).toBeUndefined();
  });
});

describe("what the correction must NOT do", () => {
  it("does not re-send an ordinary rejection — a bad model id is still fatal", async () => {
    const f = vi.fn().mockResolvedValue(
      httpError(400, JSON.stringify({ data: [], errors: [{ code: "invalidModel", message: "no such model" }] }))
    );
    vi.stubGlobal("fetch", f);
    await expect(generateRunwareImage("run1", "p", { model: "test:bad@1" })).rejects.toThrow(/invalidModel/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not re-send after OUR abort, whose request may already be billed", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const f = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal("fetch", f);
    await expect(generateRunwareImage("run1", "p", { model: "test:abort@1" })).rejects.toThrow(/not retried/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("leaves every other field of the request identical across the correction", async () => {
    const f = vi.fn().mockResolvedValueOnce(unsupportedDimensions()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", f);
    await generateRunwareImage("run1", "a lighthouse", { negativePrompt: "text", resolution: "1920x1080", model: "test:dims@5" });
    const [a, b] = [sentTask(f, 0), sentTask(f, 1)];
    for (const k of ["taskType", "model", "positivePrompt", "negativePrompt", "numberResults", "outputType", "outputFormat", "includeCost"]) {
      expect(b[k], k).toEqual(a[k]);
    }
    // A fresh idempotency key, because it is a genuinely new task.
    expect(b.taskUUID).not.toBe(a.taskUUID);
  });
});

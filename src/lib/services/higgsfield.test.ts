import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Higgsfield client — request shape, two-part auth, async create→poll lifecycle,
 * terminal-status handling (incl. nsfw/cancelled as failures) and the retry policy.
 * `fetch` is stubbed throughout; no network, no DB writes.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

const settings: Record<string, string> = {};
vi.mock("../settings", () => ({
  getSetting: (k: string) => settings[k] ?? "",
}));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import {
  generateHiggsfieldImageUrl,
  generateHiggsfieldVideoUrl,
  higgsfieldConfigured,
  isTransientHiggsfieldError,
  higgsfieldTerminal,
  extractHiggsfieldUrl,
} from "./higgsfield";

/** A create-job success envelope (POST /{model}). */
function created(reqId = "req-abc-123") {
  return { ok: true, status: 200, text: async () => JSON.stringify({ request_id: reqId, status_url: "x", cancel_url: "y" }) } as unknown as Response;
}
/** A poll-status envelope (GET /requests/{id}/status). */
function statusBody(status: string, extra: Record<string, unknown> = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ status, ...extra }) } as unknown as Response;
}
function httpError(status: number, body = "nope") {
  return { ok: false, status, text: async () => body } as unknown as Response;
}
/** Parsed JSON body of the Nth fetch call. */
function sentBody(mock: ReturnType<typeof vi.fn>, n = 0) {
  return JSON.parse((mock.mock.calls[n][1] as RequestInit).body as string);
}

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  settings.HIGGSFIELD_API_KEY = "hf-id";
  settings.HIGGSFIELD_API_SECRET = "hf-secret";
  settings.HIGGSFIELD_ENABLED = "1";
  settings.HIGGSFIELD_IMAGE_MODEL = "higgsfield-ai/soul/standard";
  settings.HIGGSFIELD_VIDEO_MODEL = "higgsfield-ai/dop/standard";
  settings.HIGGSFIELD_RETRIES = "2";
  settings.HIGGSFIELD_CONCURRENCY = "2";
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("higgsfieldConfigured", () => {
  it("requires enabled + BOTH key halves; whitespace counts as unset", () => {
    expect(higgsfieldConfigured()).toBe(true);
    settings.HIGGSFIELD_API_SECRET = "   ";
    expect(higgsfieldConfigured()).toBe(false);
    settings.HIGGSFIELD_API_SECRET = "hf-secret";
    settings.HIGGSFIELD_API_KEY = "";
    expect(higgsfieldConfigured()).toBe(false);
    settings.HIGGSFIELD_API_KEY = "hf-id";
    settings.HIGGSFIELD_ENABLED = "0";
    expect(higgsfieldConfigured()).toBe(false);
  });
});

describe("isTransientHiggsfieldError", () => {
  it("retries 429 / 5xx", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isTransientHiggsfieldError(`Higgsfield ${s} (image): busy`), String(s)).toBe(true);
  });
  it("fails fast on permanent 4xx", () => {
    for (const s of [400, 401, 403, 404]) expect(isTransientHiggsfieldError(`Higgsfield ${s} (image): bad`), String(s)).toBe(false);
  });
  it("retries transport drops and timeouts", () => {
    expect(isTransientHiggsfieldError("Higgsfield network error (image): fetch failed")).toBe(true);
    expect(isTransientHiggsfieldError("Higgsfield timeout after 120s (image)")).toBe(true);
  });
  it("reads the status after the name, not a digit in the label", () => {
    expect(isTransientHiggsfieldError("Higgsfield 400 (v2video): bad")).toBe(false);
  });
});

describe("higgsfieldTerminal", () => {
  it("maps completed → done", () => {
    expect(higgsfieldTerminal("completed")).toBe("done");
    expect(higgsfieldTerminal("COMPLETED")).toBe("done");
  });
  it("maps failed / nsfw / cancelled → fail (all failure paths)", () => {
    expect(higgsfieldTerminal("failed")).toBe("fail");
    expect(higgsfieldTerminal("nsfw")).toBe("fail");
    expect(higgsfieldTerminal("cancelled")).toBe("fail");
    expect(higgsfieldTerminal("canceled")).toBe("fail");
  });
  it("maps queued / in_progress / unknown → pending (keep polling)", () => {
    expect(higgsfieldTerminal("queued")).toBe("pending");
    expect(higgsfieldTerminal("in_progress")).toBe("pending");
    expect(higgsfieldTerminal("")).toBe("pending");
  });
});

describe("extractHiggsfieldUrl", () => {
  it("reads images[].url", () => {
    expect(extractHiggsfieldUrl({ images: [{ url: "https://cdn/hf/a.png" }] })).toBe("https://cdn/hf/a.png");
  });
  it("reads video.url", () => {
    expect(extractHiggsfieldUrl({ video: { url: "https://cdn/hf/v.mp4" } })).toBe("https://cdn/hf/v.mp4");
  });
  it("returns null when neither is a usable URL", () => {
    expect(extractHiggsfieldUrl({})).toBeNull();
    expect(extractHiggsfieldUrl({ images: [{}] })).toBeNull();
    expect(extractHiggsfieldUrl({ video: { url: "not-a-url" } })).toBeNull();
  });
});

describe("generateHiggsfieldImageUrl — create + poll", () => {
  it("posts to /{model} with the two-part Key auth, then polls status and returns the URL", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(created("req-1"))
      .mockResolvedValueOnce(statusBody("completed", { images: [{ url: "https://cdn/hf/a.png" }] }));
    vi.stubGlobal("fetch", f);

    const p = generateHiggsfieldImageUrl("run1", "a lighthouse at dusk", "16:9");
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toBe("https://cdn/hf/a.png");

    // Create call
    const [createUrl, createInit] = f.mock.calls[0];
    expect(createUrl).toBe("https://platform.higgsfield.ai/higgsfield-ai/soul/standard");
    expect((createInit as RequestInit).method).toBe("POST");
    expect((createInit as RequestInit).headers).toMatchObject({ Authorization: "Key hf-id:hf-secret" });
    expect(sentBody(f, 0)).toMatchObject({ prompt: "a lighthouse at dusk", aspect_ratio: "16:9" });

    // Poll call
    expect(f.mock.calls[1][0]).toBe("https://platform.higgsfield.ai/requests/req-1/status");
  });

  it("keeps polling through queued → in_progress → completed", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(created("req-2"))
      .mockResolvedValueOnce(statusBody("queued"))
      .mockResolvedValueOnce(statusBody("in_progress"))
      .mockResolvedValueOnce(statusBody("completed", { images: [{ url: "https://cdn/hf/b.png" }] }));
    vi.stubGlobal("fetch", f);
    const p = generateHiggsfieldImageUrl("run1", "p");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toBe("https://cdn/hf/b.png");
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("throws when the job comes back nsfw", async () => {
    const f = vi.fn().mockResolvedValueOnce(created("req-3")).mockResolvedValueOnce(statusBody("nsfw"));
    vi.stubGlobal("fetch", f);
    const settled = expect(generateHiggsfieldImageUrl("run1", "p")).rejects.toThrow(/nsfw/i);
    await vi.advanceTimersByTimeAsync(6000);
    await settled;
  });

  it("throws when the job comes back failed", async () => {
    const f = vi.fn().mockResolvedValueOnce(created("req-4")).mockResolvedValueOnce(statusBody("failed", { error: "boom" }));
    vi.stubGlobal("fetch", f);
    const settled = expect(generateHiggsfieldImageUrl("run1", "p")).rejects.toThrow(/failed.*boom/i);
    await vi.advanceTimersByTimeAsync(6000);
    await settled;
  });

  it("refuses to start without an API key or secret — no billable call is made", async () => {
    const f = vi.fn().mockResolvedValue(created());
    vi.stubGlobal("fetch", f);
    settings.HIGGSFIELD_API_SECRET = "";
    await expect(generateHiggsfieldImageUrl("run1", "p")).rejects.toThrow(/HIGGSFIELD_API_SECRET is not set/);
    expect(f).not.toHaveBeenCalled();
  });

  it("caps the image prompt at 5000 characters", async () => {
    const f = vi.fn().mockResolvedValueOnce(created()).mockResolvedValueOnce(statusBody("completed", { images: [{ url: "https://cdn/x.png" }] }));
    vi.stubGlobal("fetch", f);
    const p = generateHiggsfieldImageUrl("run1", "x".repeat(9000));
    await vi.advanceTimersByTimeAsync(6000);
    await p;
    expect(sentBody(f, 0).prompt).toHaveLength(5000);
  });
});

describe("generateHiggsfieldVideoUrl — create + poll", () => {
  it("posts to the video model slug with prompt + duration and returns video.url", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(created("req-v"))
      .mockResolvedValueOnce(statusBody("completed", { video: { url: "https://cdn/hf/v.mp4" } }));
    vi.stubGlobal("fetch", f);
    const p = generateHiggsfieldVideoUrl("run1", "a drone shot", "16:9", 6);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toBe("https://cdn/hf/v.mp4");
    expect(f.mock.calls[0][0]).toBe("https://platform.higgsfield.ai/higgsfield-ai/dop/standard");
    expect(sentBody(f, 0)).toMatchObject({ prompt: "a drone shot", aspect_ratio: "16:9", duration: 6 });
  });
});

describe("retry policy (create POST)", () => {
  it("retries a 429 on create and succeeds, honoring HIGGSFIELD_RETRIES", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(httpError(429, "slow down"))
      .mockResolvedValueOnce(created("req-r"))
      .mockResolvedValueOnce(statusBody("completed", { images: [{ url: "https://cdn/r.png" }] }));
    vi.stubGlobal("fetch", f);
    const p = generateHiggsfieldImageUrl("run1", "p");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toBe("https://cdn/r.png");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("does not retry a permanent 401 — one attempt only", async () => {
    const f = vi.fn().mockResolvedValue(httpError(401, "bad key"));
    vi.stubGlobal("fetch", f);
    await expect(generateHiggsfieldImageUrl("run1", "p")).rejects.toThrow(/Higgsfield 401/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

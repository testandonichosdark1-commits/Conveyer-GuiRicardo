import { describe, it, expect, beforeEach, vi } from "vitest";
import { isGeminiQuotaError } from "./gemini-models";
import { isCancelled, clearCancelled } from "../cancellation";

// The notice writes through the real logger, which writes to the DB. Capture the calls instead.
const logged: { runId: string; level: string; message: string; stage?: string }[] = [];
vi.mock("../logger", () => ({
  log: (runId: string, level: string, message: string, opts?: { stage?: string }) => {
    logged.push({ runId, level, message, stage: opts?.stage });
  },
}));

const { noteGeminiQuota, geminiQuotaHit, __resetGeminiQuotaNotice } = await import("./gemini-quota");

/** The exact shape our Gemini layer throws: `Gemini <status>: <first 200 bytes of body>`. */
const REAL_429 =
  'Gemini 429: {\n  "error": {\n    "code": 429,\n    "message": "Quota exceeded for quota metric ' +
  "'Generate Content API requests' and limit 'Requests per day'\",\n    \"status\": \"RESOURCE_EXHAUSTED\"";

/**
 * A pay-as-you-go key's real exhaustion wording. Live, the "message" text ran long enough that
 * "status": "RESOURCE_EXHAUSTED" fell past the 200-byte body slice entirely, so this is the
 * shape that slipped through undetected — a run kept going ~140 more beats fail-open, and one
 * of them let a provider's own safety-filter placeholder image into the final video.
 */
const PREPAYMENT_429 =
  'Gemini 429: {"error":{"code":429,"message":"Your prepayment credits are depleted. Learn more ' +
  'at https://ai.google.dev/gemini-api/docs/billing"}}';

beforeEach(() => {
  logged.length = 0;
  __resetGeminiQuotaNotice();
  clearCancelled("run-a");
  clearCancelled("run-b");
});

describe("isGeminiQuotaError", () => {
  it("recognises the exhausted-key 429 a real client run produced", () => {
    expect(isGeminiQuotaError(REAL_429)).toBe(true);
  });

  it("recognises RESOURCE_EXHAUSTED even when the body is truncated before the metric name", () => {
    expect(isGeminiQuotaError('Gemini 429: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')).toBe(true);
  });

  it("does NOT claim a quota problem for a bare 429 with no quota wording", () => {
    // A momentary rate limit clears on its own. Telling the operator to go fix their billing
    // over one of those sends them after a bill that is already paid.
    expect(isGeminiQuotaError("Gemini 429: rate limited, please retry")).toBe(false);
  });

  it("ignores every non-429 failure", () => {
    expect(isGeminiQuotaError("Gemini 503: The model is overloaded")).toBe(false);
    expect(isGeminiQuotaError("Gemini 400: quota exceeded")).toBe(false); // wrong status → not ours
    expect(isGeminiQuotaError("Gemini timeout after 45s")).toBe(false);
    expect(isGeminiQuotaError("fetch failed")).toBe(false);
  });

  it("recognises a pay-as-you-go key's real exhaustion wording, even truncated before RESOURCE_EXHAUSTED", () => {
    // This is the shape that went undetected live: no "quota"/"RESOURCE_EXHAUSTED" survives the
    // 200-byte body slice when the message is this long, so "prepayment credit" is matched on
    // its own precisely so a truncated body still classifies correctly.
    expect(isGeminiQuotaError(PREPAYMENT_429)).toBe(true);
  });
});

describe("noteGeminiQuota", () => {
  it("logs exactly ONE error however many beats hit the wall", () => {
    // The client run 429'd ~170 times; the point of this module is that it says so once.
    for (let i = 0; i < 170; i++) noteGeminiQuota("run-a", REAL_429);
    expect(logged).toHaveLength(1);
    expect(logged[0].level).toBe("error");
    expect(logged[0].message).toContain("GEMINI UNAVAILABLE");
    expect(logged[0].message).toContain("GOOGLE_API_KEY");
  });

  it("names both consequences the operator actually sees", () => {
    noteGeminiQuota("run-a", REAL_429);
    expect(logged[0].message).toMatch(/overlay cards/i); // why the text vanished
    expect(logged[0].message).toMatch(/footage search/i); // why the shots got worse
  });

  it("files the notice under the stage that actually hit the wall", () => {
    // A key can also run dry mid-run, long after planning succeeded; the log must point there.
    noteGeminiQuota("run-a", REAL_429);
    noteGeminiQuota("run-b", REAL_429, "visual");
    expect(logged.map((l) => l.stage)).toEqual(["plan", "visual"]);
  });

  it("stays silent for failures that are not quota exhaustion", () => {
    noteGeminiQuota("run-a", "Gemini 503: The model is overloaded");
    noteGeminiQuota("run-a", "Gemini timeout after 45s");
    expect(logged).toHaveLength(0);
    expect(geminiQuotaHit("run-a")).toBe(false);
  });

  it("tracks runs independently — one exhausted run never speaks for another", () => {
    noteGeminiQuota("run-a", REAL_429);
    expect(geminiQuotaHit("run-a")).toBe(true);
    expect(geminiQuotaHit("run-b")).toBe(false);
    noteGeminiQuota("run-b", REAL_429);
    expect(logged).toHaveLength(2);
    expect(logged.map((l) => l.runId)).toEqual(["run-a", "run-b"]);
  });

  it("reports the run's known state even when handed an unrelated failure", () => {
    // Callers pass whatever they caught; once the wall is known, a later 503 must not read as
    // "this run is fine" to the overlay summary that consumes the return value.
    noteGeminiQuota("run-a", REAL_429);
    expect(noteGeminiQuota("run-a", "Gemini 503: overloaded")).toBe(true);
  });
});

describe("noteGeminiQuota — pausing instead of finishing degraded", () => {
  it("cancels the run the same way a user-initiated Stop does, on the first quota hit", () => {
    expect(isCancelled("run-a")).toBe(false);
    noteGeminiQuota("run-a", REAL_429);
    expect(isCancelled("run-a")).toBe(true);
  });

  it("never touches a different run", () => {
    noteGeminiQuota("run-a", REAL_429);
    expect(isCancelled("run-b")).toBe(false);
  });

  it("does not pause for a failure that isn't quota exhaustion", () => {
    noteGeminiQuota("run-a", "Gemini 503: The model is overloaded");
    expect(isCancelled("run-a")).toBe(false);
  });

  it("pauses on the real-world prepayment-credit wording too", () => {
    noteGeminiQuota("run-a", PREPAYMENT_429);
    expect(isCancelled("run-a")).toBe(true);
  });
});

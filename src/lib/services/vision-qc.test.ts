import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Frame quality control must not switch itself off in silence.
 *
 * `scoreLocalImage` fails OPEN — no Gemini key, an unreadable or oversized file, or any API
 * error returns 100 out of 100. That routing is right (a broken judge must not stall a run)
 * and these tests pin that it is UNCHANGED. What was wrong is that 100 clears every bar,
 * reads exactly like a genuine perfect score, and emitted nothing at all: the AI-image gate
 * only logs scores BELOW its threshold, so a fail-open produced no line anywhere. With
 * AI_REGEN_ATTEMPTS defaulting to 5, that means every generated image was accepted first try
 * with no regeneration and no hint that nothing had been checked.
 *
 * So the two halves below are equally load-bearing: the score must still be 100, and the run
 * must say so once.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));

const { LOGS } = vi.hoisted(() => ({ LOGS: [] as { level: string; message: string }[] }));
vi.mock("../logger", () => ({
  log: (_runId: string, level: string, message: string) => LOGS.push({ level, message }),
}));

import { __testing } from "./visual-source";
import { __resetVisionQcNotice, visionQcOff } from "./vision-qc";

const { scoreLocalImage } = __testing;

/** Lines the notice produced — identified by its leading marker, not by loose matching. */
const notices = () => LOGS.filter((l) => l.message.startsWith("FRAME QUALITY CONTROL IS OFF"));

let tmpImg: string;

beforeEach(() => {
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  LOGS.length = 0;
  __resetVisionQcNotice();
  tmpImg = path.join(os.tmpdir(), `vision-qc-${process.pid}-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(tmpImg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
});

afterEach(() => {
  try { fs.unlinkSync(tmpImg); } catch {}
});

const score = (runId: string, file = tmpImg) =>
  scoreLocalImage(runId, 0, "colosseum aerial rome", "the colosseum from above", undefined, file);

describe("scoreLocalImage — the fail-open still accepts, but says so", () => {
  it("with no Gemini key: still returns 100, and reports once", async () => {
    // The first half is the invariant — this change must not alter a single routing decision.
    await expect(score("run-a")).resolves.toBe(100);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].level).toBe("warn");
    // The operator has to be able to act on it, so the cause must be named.
    expect(notices()[0].message).toContain("GOOGLE_API_KEY");
  });

  it("says it once per run, however many frames are scored", async () => {
    // A run scores hundreds of frames; a line each would bury the fact instead of surfacing it.
    await score("run-b");
    await score("run-b");
    await score("run-b");
    expect(notices()).toHaveLength(1);
  });

  it("reports again for a different run", async () => {
    await score("run-c");
    await score("run-d");
    expect(notices()).toHaveLength(2);
    expect(visionQcOff("run-c")).toBe(true);
    expect(visionQcOff("run-never-ran")).toBe(false);
  });

  it("reports an unreadable file, naming that cause rather than the key", async () => {
    SETTINGS.GOOGLE_API_KEY = "test-key"; // key present: the failure is the FILE
    await expect(score("run-e", path.join(os.tmpdir(), "vision-qc-does-not-exist.jpg"))).resolves.toBe(100);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].message).toContain("could not be read");
  });

  it("reports an empty file", async () => {
    SETTINGS.GOOGLE_API_KEY = "test-key";
    fs.writeFileSync(tmpImg, Buffer.alloc(0));
    await expect(score("run-f")).resolves.toBe(100);
    expect(notices()[0].message).toContain("empty");
  });

  it("reports an oversized file", async () => {
    SETTINGS.GOOGLE_API_KEY = "test-key";
    fs.writeFileSync(tmpImg, Buffer.alloc(6 * 1024 * 1024 + 1));
    await expect(score("run-g")).resolves.toBe(100);
    expect(notices()[0].message).toContain("6 MB");
  });

  it("says a 100 in this run means 'not checked', not 'perfect'", async () => {
    // The whole point of the wording: the log already contained 100s that meant the opposite
    // of what they looked like.
    await score("run-h");
    expect(notices()[0].message).toContain("not checked");
  });

  it("stays silent when the judge actually judged", async () => {
    SETTINGS.GOOGLE_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ score: 42 }) }] } }],
            usageMetadata: {},
          }),
          { status: 200 }
        )
      ) as unknown as typeof fetch
    );
    await expect(score("run-i")).resolves.toBe(42);
    expect(notices()).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

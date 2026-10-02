import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * animateStill is a pure dispatch seam over kenBurns (still-animator.ts). These tests pin
 * that, with nothing configured, it is EXACTLY a kenBurns call: same arguments in the same
 * positions, same errors, same single output file, no other work.
 */
const kb = vi.hoisted(() => ({ calls: [] as unknown[][], fail: null as Error | null }));
vi.mock("./ken-burns", () => ({
  kenBurns: (...a: unknown[]) => {
    kb.calls.push(a);
    if (kb.fail) throw kb.fail;
    fs.writeFileSync(a[1] as string, "kb");
  },
}));

import { animateStill, resolveStillAnimator } from "./still-animator";

let dir: string;
beforeEach(() => {
  kb.calls = [];
  kb.fail = null;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "still-animator-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

function input(over: Partial<Parameters<typeof animateStill>[0]> = {}) {
  const imagePath = path.join(dir, "still.png");
  fs.writeFileSync(imagePath, "png");
  return { imagePath, outPath: path.join(dir, "beat_0003.mp4"), durationSec: 4.37, zoomOut: true, resolution: "1080x1920", ...over };
}

describe("animateStill", () => {
  it("A. with no configuration, resolves to and delegates to Ken Burns (exactly once)", async () => {
    expect(resolveStillAnimator()).toBe("kenburns");
    await animateStill(input());
    expect(kb.calls).toHaveLength(1);
  });

  it("B+C. forwards every argument unchanged, in kenBurns' positional order", async () => {
    const i = input();
    await animateStill(i);
    expect(kb.calls[0]).toEqual([i.imagePath, i.outPath, 4.37, true, "1080x1920"]);

    await animateStill(input({ zoomOut: false, resolution: undefined, durationSec: 0.2 }));
    // undefined resolution reaches kenBurns as undefined, so its own VIDEO_RESOLUTION
    // fallback still applies; the duration is not clamped here (kenBurns clamps it).
    expect(kb.calls[1]).toEqual([i.imagePath, i.outPath, 0.2, false, undefined]);
  });

  it("D. a Ken Burns failure propagates with the same error object", async () => {
    const err = new Error("Ken Burns ffmpeg failed (rc=1): boom");
    kb.fail = err;
    await expect(animateStill(input())).rejects.toBe(err);
  });

  it("E. writes only the requested output, and leaves the input in place for the caller to clean up", async () => {
    const i = input();
    await animateStill(i);
    expect(fs.readdirSync(dir).sort()).toEqual(["beat_0003.mp4", "still.png"]);
    expect(fs.existsSync(i.imagePath)).toBe(true);
  });

  it("F. calls no external API", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await animateStill(input());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("G. callers never learn which animator ran — no result, no animator in the contract", async () => {
    await expect(animateStill(input())).resolves.toBeUndefined();
    // @ts-expect-error — the caller cannot pick an animator; that decision is the seam's.
    await animateStill({ ...input(), animator: "ltx" });
    expect(kb.calls).toHaveLength(2);
  });
});

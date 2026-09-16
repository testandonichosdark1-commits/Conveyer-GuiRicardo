import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * The per-run "AI photo / video balance" slider, at the point where it actually spends money.
 *
 * `applyAiVideoRatio` (studio-plan.test.ts) writes the split onto the beats. What is asserted
 * here is that the split survives all the way to the generator that bills for it, and the one
 * thing that must outrank it:
 *
 *   global "image"/"video"  >  the operator's ratio  >  the planner's per-beat verdict
 *
 * The global modes must stay on top, or a client who chose "Images only" gets billed for
 * generated video — the same cost bug FALLBACK_AI_MEDIA exists to prevent next door. Asserted
 * through the real `acquireVisual`, so it is the shipped chain being tested and not a
 * re-implementation of it.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
const gen = vi.hoisted(() => ({ image: vi.fn(), video: vi.fn() }));

vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("./kie", () => ({
  generateImageUrl: (...a: unknown[]) => { gen.image(...a); return Promise.resolve("http://kie/img"); },
  generateVideoUrl: (...a: unknown[]) => { gen.video(...a); return Promise.resolve("http://kie/vid"); },
  downloadKie: (_url: string, out: string) => { fs.writeFileSync(out, "x"); return Promise.resolve(); },
}));
vi.mock("./ken-burns", () => ({ kenBurns: (_src: string, out: string) => fs.writeFileSync(out, "x") }));
vi.mock("./cost-ledger", () => ({
  recordKieImage: () => {}, recordKieVeo: () => {}, recordGemini: () => {},
  recordLabs69: () => {}, recordMagnificImage: () => {}, recordMagnificVideo: () => {},
}));

import { acquireVisual } from "./visual-source";
import type { Beat } from "./studio-plan";

const OUT = path.join(os.tmpdir(), `ai-video-ratio-${process.pid}.mp4`);

/** A planned-AI b-roll beat. `pinned` is what applyAiVideoRatio would have written. */
function beat(aiMedia?: "image" | "video", pinned?: boolean): Beat {
  return {
    index: 0, startMs: 0, endMs: 4000, text: "a widget on a bench",
    layout: "broll", visualQuery: "widget bench", source: "ai",
    aiMedia, aiMediaPinned: pinned,
  } as Beat;
}

beforeEach(() => {
  gen.image.mockClear();
  gen.video.mockClear();
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  Object.assign(SETTINGS, {
    GOOGLE_API_KEY: "", // no vision scoring
    AI_PROVIDER: "kie",
    KIE_API_KEY: "test-key",
    AI_REGEN_ATTEMPTS: "1",
    YT_DLP_ENABLED: "0",
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ videos: [], photos: [], hits: [] }), { status: 200 })) as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the run-level photo/video ratio in resolveAiMedia's precedence chain", () => {
  it("a pinned 'video' beat generates video under AI media = auto", async () => {
    SETTINGS.KIE_AI_MEDIA = "auto";
    await acquireVisual("run", beat("video", true), OUT, new Set(), {});
    expect(gen.video).toHaveBeenCalled();
    expect(gen.image).not.toHaveBeenCalled();
  });

  it("a beat the ratio assigned to stills generates an image, not video", async () => {
    SETTINGS.KIE_AI_MEDIA = "auto";
    await acquireVisual("run", beat("image", true), OUT, new Set(), {});
    expect(gen.image).toHaveBeenCalled();
    expect(gen.video).not.toHaveBeenCalled();
  });

  it("'Images only' still wins over the pin — no surprise video bill", async () => {
    // The cost-safety property. A client whose global mode is "image" must never generate video,
    // whatever a stale ratio in a resumed run's config_json says.
    SETTINGS.KIE_AI_MEDIA = "image";
    await acquireVisual("run", beat("video", true), OUT, new Set(), {});
    expect(gen.image).toHaveBeenCalled();
    expect(gen.video).not.toHaveBeenCalled();
  });

  it("without a pin the planner still decides — runs made before the slider are unchanged", async () => {
    SETTINGS.KIE_AI_MEDIA = "auto";
    await acquireVisual("run", beat("video", undefined), OUT, new Set(), {});
    expect(gen.video).toHaveBeenCalled();
    expect(gen.image).not.toHaveBeenCalled();
  });
});

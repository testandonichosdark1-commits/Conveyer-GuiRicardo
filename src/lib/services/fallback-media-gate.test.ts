import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * FALLBACK_AI_MEDIA actually gates what the AI *fallback* generates — image vs video —
 * and touches ONLY the fallback path, never normal AI generation.
 *
 * The setting exists because AI video is far pricier than AI images: a real operator was
 * surprised by ~$40 of fallback video. So the two properties that must hold:
 *   1. A REAL beat that can't find footage (the fallback) obeys FALLBACK_AI_MEDIA.
 *   2. A planned-AI beat (source: "ai") is NOT constrained by it — that's normal AI mode.
 *
 * We starve every real provider (empty pool) so a real beat is forced into the fallback,
 * then assert which kie generator ran: image (nano-banana) or video (Veo).
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
const gen = vi.hoisted(() => ({ image: vi.fn(), video: vi.fn() }));
// The universal 69labs/Grok floor is text-to-VIDEO. `anim.scene` spies on it so a test can
// prove "Images only" NEVER reaches it. `ctl.imageFails` starves every AI *image* backend so
// the fallback is forced down toward that floor — the exact condition C1 lived in.
const anim = vi.hoisted(() => ({ scene: vi.fn() }));
const ctl = vi.hoisted(() => ({ imageFails: false }));

vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
// Replace the billable kie calls with spies; write a dummy file so downstream steps run.
// generateImageUrl can be forced to fail (ctl.imageFails) to simulate a total image outage.
vi.mock("./kie", () => ({
  generateImageUrl: (...a: unknown[]) => { gen.image(...a); return ctl.imageFails ? Promise.reject(new Error("kie image outage")) : Promise.resolve("http://kie/img"); },
  generateVideoUrl: (...a: unknown[]) => { gen.video(...a); return Promise.resolve("http://kie/vid"); },
  downloadKie: (_url: string, out: string) => { fs.writeFileSync(out, "x"); return Promise.resolve(); },
}));
// The text-to-video floor (animateScene with a null keyframe). Spy so "Images only" can assert
// it is never invoked; writes a clip + returns its path so the floor's rename step succeeds when
// it IS legitimately reached (e.g. "both" degrading to video).
vi.mock("./img2vid", () => ({
  animateScene: (_runId: string, _scene: unknown, _img: unknown, dir: string) => {
    anim.scene();
    const p = path.join(dir, `floor-${process.pid}.mp4`);
    fs.writeFileSync(p, "v");
    return Promise.resolve(p);
  },
}));
// Ken Burns would shell out to ffmpeg — stub it to just produce the output file.
vi.mock("./ken-burns", () => ({ kenBurns: (_src: string, out: string) => fs.writeFileSync(out, "x") }));
vi.mock("./cost-ledger", () => ({
  recordKieImage: () => {}, recordKieVeo: () => {}, recordGemini: () => {},
  recordLabs69: () => {}, recordMagnificImage: () => {}, recordMagnificVideo: () => {},
}));

import { acquireVisual } from "./visual-source";
import type { Beat } from "./studio-plan";

const OUT = path.join(os.tmpdir(), `fallback-media-${process.pid}.mp4`);

function beat(source: "real" | "ai"): Beat {
  return { index: 0, startMs: 0, endMs: 4000, text: "a widget on a bench", layout: "broll", visualQuery: "widget bench", source } as Beat;
}

beforeEach(() => {
  gen.image.mockClear();
  gen.video.mockClear();
  anim.scene.mockClear();
  ctl.imageFails = false;
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  Object.assign(SETTINGS, {
    FOOTAGE_SOURCES: "pexels",
    PEXELS_API_KEY: "test-key",
    GOOGLE_API_KEY: "", // no vision scoring
    AI_PROVIDER: "kie",
    KIE_API_KEY: "test-key",
    AI_REGEN_ATTEMPTS: "1", // one image attempt, score short-circuits to 100
    YT_DLP_ENABLED: "0",
  });
  // Every real provider returns an empty pool → the real beat is forced into AI fallback.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ videos: [], photos: [], hits: [] }), { status: 200 })) as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FALLBACK_AI_MEDIA gates the fallback path", () => {
  it("'image' (default): a starved real beat generates an AI image, never a video", async () => {
    SETTINGS.FALLBACK_AI_MEDIA = "image";
    await acquireVisual("run", beat("real"), OUT, new Set(), {});
    expect(gen.image).toHaveBeenCalled();
    expect(gen.video).not.toHaveBeenCalled();
  });

  it("'video': a starved real beat generates an AI video", async () => {
    SETTINGS.FALLBACK_AI_MEDIA = "video";
    await acquireVisual("run", beat("real"), OUT, new Set(), {});
    expect(gen.video).toHaveBeenCalled();
    expect(gen.image).not.toHaveBeenCalled();
  });

  it("'image' fallback overrides even KIE_AI_MEDIA=video — no surprise fallback videos", async () => {
    // The exact cost bug: KIE_AI_MEDIA=video would have made the fallback generate video.
    // FALLBACK_AI_MEDIA=image must win on the fallback path.
    SETTINGS.FALLBACK_AI_MEDIA = "image";
    SETTINGS.KIE_AI_MEDIA = "video";
    await acquireVisual("run", beat("real"), OUT, new Set(), {});
    expect(gen.image).toHaveBeenCalled();
    expect(gen.video).not.toHaveBeenCalled();
  });

  it("does NOT touch normal AI mode: a planned-AI beat still honours KIE_AI_MEDIA=video", async () => {
    // beat.source === "ai" is normal AI generation, not a fallback. FALLBACK_AI_MEDIA=image
    // must not constrain it — otherwise the setting would leak into normal AI mode.
    SETTINGS.FALLBACK_AI_MEDIA = "image";
    SETTINGS.KIE_AI_MEDIA = "video";
    await acquireVisual("run", beat("ai"), OUT, new Set(), {});
    expect(gen.video).toHaveBeenCalled();
    expect(gen.image).not.toHaveBeenCalled();
  });

  it("'both' preserves today's behaviour (KIE_AI_MEDIA decides) — existing users unchanged", async () => {
    SETTINGS.FALLBACK_AI_MEDIA = "both";
    SETTINGS.KIE_AI_MEDIA = "video";
    await acquireVisual("run", beat("real"), OUT, new Set(), {});
    expect(gen.video).toHaveBeenCalled();
    expect(gen.image).not.toHaveBeenCalled();
  });

  // C1 REGRESSION GUARD. Even when every AI image backend fails, "Images only" must never reach
  // the text-to-video floor (animateScene). Instead acquireVisual throws → the pipeline reuses a
  // neighbouring visual (graceful degradation), never a surprise AI video. If someone deletes the
  // guard, animateScene runs, no error is thrown, and BOTH assertions below fail.
  it("'image' + total image outage NEVER generates an AI video — it degrades gracefully", async () => {
    SETTINGS.FALLBACK_AI_MEDIA = "image";
    ctl.imageFails = true; // every AI image attempt fails → forced toward the video floor
    await expect(acquireVisual("run", beat("real"), OUT, new Set(), {})).rejects.toThrow(/Images only/i);
    expect(gen.image).toHaveBeenCalled(); // it did try to make an image
    expect(gen.video).not.toHaveBeenCalled(); // …but never Veo
    expect(anim.scene).not.toHaveBeenCalled(); // …and never the 69labs/Grok text-to-video floor
  });

  // Contrast: the floor is NOT dead code. With 'both' (no constraint) an image outage still degrades
  // to the video floor as it always has — proving the C1 guard is scoped to "image", not a blanket
  // removal of the last-resort path that would change existing-user behaviour.
  it("'both' + total image outage still falls to the video floor (behaviour unchanged)", async () => {
    SETTINGS.FALLBACK_AI_MEDIA = "both";
    ctl.imageFails = true;
    await acquireVisual("run", beat("real"), OUT, new Set(), {});
    expect(anim.scene).toHaveBeenCalled(); // the last-resort text-to-video floor still runs for 'both'
  });
});

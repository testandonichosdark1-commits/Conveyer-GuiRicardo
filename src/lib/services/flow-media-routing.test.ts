import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Flow browser provider — media routing and fallback-type-preservation.
 *
 * Three properties that must hold once Flow is no longer image-only:
 *   1. resolveAiMedia() (the SAME resolver every other AI provider uses) decides image vs
 *      video for Flow too — no more hardcoded "Flow is image-only" refusal.
 *   2. A video-routed beat that calls Ken Burns would be a bug (Ken Burns is for STILLS);
 *      only the image path may call it.
 *   3. When Flow fails and FLOW_FALLBACK_PROVIDER=kie, the media KIND is preserved —
 *      a video-routed beat falls to kie.ai's Veo, never its nano-banana image path, and a
 *      FLOW_FALLBACK_PROVIDER=none run fails closed for both kinds rather than silently
 *      substituting a paid provider.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
const kieGen = vi.hoisted(() => ({ image: vi.fn(), video: vi.fn() }));
const flowGen = vi.hoisted(() => ({ image: vi.fn(), video: vi.fn() }));
const kb = vi.hoisted(() => ({ used: vi.fn() }));
const ctl = vi.hoisted(() => ({ flowImageFails: false, flowVideoFails: false, flowVideoNoCredits: false }));

vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

const { FakeFlowBrowserError } = vi.hoisted(() => ({
  FakeFlowBrowserError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("./flow-browser", () => ({
  FlowBrowserError: FakeFlowBrowserError,
  generateFlowImage: (_runId: string, _prompt: string, outPath: string) => {
    flowGen.image(outPath);
    if (ctl.flowImageFails) return Promise.reject(new FakeFlowBrowserError("flow image UI failure", "ui"));
    fs.writeFileSync(outPath, "png-bytes");
    return Promise.resolve({ path: outPath, model: "nano banana pro" });
  },
  generateFlowVideo: (_runId: string, _prompt: string, outPath: string) => {
    flowGen.video(outPath);
    if (ctl.flowVideoNoCredits) return Promise.reject(new FakeFlowBrowserError("no credits for this video", "credits"));
    if (ctl.flowVideoFails) return Promise.reject(new FakeFlowBrowserError("flow video UI failure", "ui"));
    fs.writeFileSync(outPath, "mp4-bytes");
    return Promise.resolve(outPath);
  },
}));

vi.mock("./kie", () => ({
  generateImageUrl: (...a: unknown[]) => { kieGen.image(...a); return Promise.resolve("http://kie/img"); },
  generateVideoUrl: (...a: unknown[]) => { kieGen.video(...a); return Promise.resolve("http://kie/vid"); },
  downloadKie: (_url: string, out: string) => { fs.writeFileSync(out, "x"); return Promise.resolve(); },
}));
// Ken Burns is IMAGE-ONLY — spy so a video beat can be asserted to never touch it.
vi.mock("./ken-burns", () => ({ kenBurns: (...a: unknown[]) => { kb.used(...a); fs.writeFileSync(a[1] as string, "x"); } }));
vi.mock("./cost-ledger", () => ({
  recordKieImage: () => {}, recordKieVeo: () => {}, recordGemini: () => {},
  recordLabs69: () => {}, recordMagnificImage: () => {}, recordMagnificVideo: () => {},
}));

import { acquireVisual } from "./visual-source";
import type { Beat } from "./studio-plan";

const OUT = path.join(os.tmpdir(), `flow-media-routing-${process.pid}.mp4`);

function aiBeat(): Beat {
  return { index: 0, startMs: 0, endMs: 4000, text: "a widget on a bench", layout: "broll", visualQuery: "widget bench", source: "ai" } as Beat;
}

beforeEach(() => {
  kieGen.image.mockClear();
  kieGen.video.mockClear();
  flowGen.image.mockClear();
  flowGen.video.mockClear();
  kb.used.mockClear();
  ctl.flowImageFails = false;
  ctl.flowVideoFails = false;
  ctl.flowVideoNoCredits = false;
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  Object.assign(SETTINGS, {
    AI_PROVIDER: "flow_browser",
    GOOGLE_API_KEY: "", // no vision scoring — maxAttempts===1 short-circuits to score 100 anyway
    FLOW_REGEN_ATTEMPTS: "1",
    FLOW_FALLBACK_PROVIDER: "none",
    KIE_AI_MEDIA: "image",
  });
});

afterEach(() => {
  try { fs.unlinkSync(OUT); } catch {}
});

describe("Flow browser — resolveAiMedia() picks image vs video (no more image-only refusal)", () => {
  it("KIE_AI_MEDIA=image: generates via Flow's image path, applies Ken Burns, never calls the video path", async () => {
    SETTINGS.KIE_AI_MEDIA = "image";
    const r = await acquireVisual("run", aiBeat(), OUT, new Set(), {});
    expect(flowGen.image).toHaveBeenCalled();
    expect(flowGen.video).not.toHaveBeenCalled();
    expect(kb.used).toHaveBeenCalled(); // Ken Burns DID run for the still
    expect(r.provider).toBe("flow:nano-banana-pro");
    expect(r.kind).toBe("ai");
  });

  it("KIE_AI_MEDIA=video: generates via Flow's video path, and Ken Burns is NEVER called on a video", async () => {
    SETTINGS.KIE_AI_MEDIA = "video";
    const r = await acquireVisual("run", aiBeat(), OUT, new Set(), {});
    expect(flowGen.video).toHaveBeenCalled();
    expect(flowGen.image).not.toHaveBeenCalled();
    expect(kb.used).not.toHaveBeenCalled(); // Ken Burns is for STILLS only
    expect(r.provider).toBe("flow:veo3");
    expect(r.kind).toBe("ai");
  });
});

describe("Flow browser — fallback preserves the media KIND", () => {
  it("video beat + Flow video fails + fallback=none: fails closed, kie.ai is never billed", async () => {
    SETTINGS.KIE_AI_MEDIA = "video";
    SETTINGS.FLOW_FALLBACK_PROVIDER = "none";
    ctl.flowVideoFails = true;
    await expect(acquireVisual("run", aiBeat(), OUT, new Set(), {})).rejects.toThrow();
    expect(kieGen.video).not.toHaveBeenCalled();
    expect(kieGen.image).not.toHaveBeenCalled();
  });

  it("video beat + Flow video fails + fallback=kie: falls to kie.ai VEO (video), never kie.ai's image path", async () => {
    SETTINGS.KIE_AI_MEDIA = "video";
    SETTINGS.FLOW_FALLBACK_PROVIDER = "kie";
    SETTINGS.KIE_API_KEY = "test-key";
    ctl.flowVideoFails = true;
    await acquireVisual("run", aiBeat(), OUT, new Set(), {});
    expect(kieGen.video).toHaveBeenCalled();
    expect(kieGen.image).not.toHaveBeenCalled();
  });

  it("image beat + Flow image fails + fallback=none: fails closed, kie.ai is never billed", async () => {
    SETTINGS.KIE_AI_MEDIA = "image";
    SETTINGS.FLOW_FALLBACK_PROVIDER = "none";
    ctl.flowImageFails = true;
    await expect(acquireVisual("run", aiBeat(), OUT, new Set(), {})).rejects.toThrow();
    expect(kieGen.image).not.toHaveBeenCalled();
    expect(kieGen.video).not.toHaveBeenCalled();
  });

  it("image beat + Flow image fails + fallback=kie: falls to kie.ai nano-banana (image)", async () => {
    SETTINGS.KIE_AI_MEDIA = "image";
    SETTINGS.FLOW_FALLBACK_PROVIDER = "kie";
    SETTINGS.KIE_API_KEY = "test-key";
    ctl.flowImageFails = true;
    await acquireVisual("run", aiBeat(), OUT, new Set(), {});
    expect(kieGen.image).toHaveBeenCalled();
    expect(kieGen.video).not.toHaveBeenCalled();
  });
});

describe("Flow browser — out of Veo credits: the beat becomes a Flow IMAGE, never a wait or a paid video", () => {
  const videoBeat = (i: number): Beat => ({ ...aiBeat(), index: i, aiMedia: "video" } as Beat);

  it("renders the beat as a Flow image (Ken Burns), leaves kie.ai untouched, and skips Veo for the rest of the run", async () => {
    SETTINGS.KIE_AI_MEDIA = "auto";
    SETTINGS.FLOW_FALLBACK_PROVIDER = "kie";
    SETTINGS.KIE_API_KEY = "test-key";
    ctl.flowVideoNoCredits = true;
    const r1 = await acquireVisual("run-credits-a", videoBeat(0), OUT, new Set(), {});
    expect(flowGen.video).toHaveBeenCalledTimes(1);
    expect(flowGen.image).toHaveBeenCalledTimes(1);
    expect(kieGen.video).not.toHaveBeenCalled();
    expect(kieGen.image).not.toHaveBeenCalled();
    expect(kb.used).toHaveBeenCalled();
    expect(r1.provider).toBe("flow:nano-banana-pro");

    flowGen.video.mockClear();
    flowGen.image.mockClear();
    await acquireVisual("run-credits-a", videoBeat(1), OUT, new Set(), {});
    expect(flowGen.video).not.toHaveBeenCalled(); // no second 10-credit attempt, no second wait
    expect(flowGen.image).toHaveBeenCalledTimes(1);
  });

  it("does NOT degrade when the operator pinned Videos only", async () => {
    SETTINGS.KIE_AI_MEDIA = "video";
    SETTINGS.FLOW_FALLBACK_PROVIDER = "none";
    ctl.flowVideoNoCredits = true;
    await expect(acquireVisual("run-credits-b", videoBeat(0), OUT, new Set(), {})).rejects.toThrow();
    expect(flowGen.image).not.toHaveBeenCalled();
  });
});

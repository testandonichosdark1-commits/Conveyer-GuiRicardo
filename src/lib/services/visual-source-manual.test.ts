import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * AI_PROVIDER=manual — for an operator with no CDP/API access to the browser account they
 * want to generate with. A beat either finds an operator-supplied file already sitting in
 * `<runDir>/manual/` and uses it, or writes its prompt to `<runDir>/manual-prompts.txt` and
 * throws ManualGenerationPendingError (studio-pipeline.ts turns that into a run-wide pause,
 * not a per-beat failure — covered separately, this file is the visual-source.ts half).
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
const kb = vi.hoisted(() => ({ used: vi.fn() }));
const { RUN_DIR } = vi.hoisted(() => ({
  RUN_DIR: require("node:path").join(require("node:os").tmpdir(), `visual-source-manual-${process.pid}`),
}));

vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../run-paths", () => ({ getRunDir: () => RUN_DIR, DATA_DIR: RUN_DIR }));
vi.mock("./ken-burns", () => ({ kenBurns: (...a: unknown[]) => { kb.used(...a); fs.writeFileSync(a[1] as string, "ken-burns-bytes"); } }));
// No provider should ever be touched in manual mode — a call here is a test failure.
vi.mock("./flow-browser", () => ({ FlowBrowserError: class extends Error {}, generateFlowImage: vi.fn(), generateFlowVideo: vi.fn() }));
vi.mock("./vids-browser", () => ({ generateVidsImage: vi.fn(), generateVidsVideo: vi.fn() }));
vi.mock("./kie", () => ({ generateImageUrl: vi.fn(), generateVideoUrl: vi.fn(), downloadKie: vi.fn() }));
vi.mock("./cost-ledger", () => ({
  recordKieImage: () => {}, recordKieVeo: () => {}, recordGemini: () => {},
  recordLabs69: () => {}, recordMagnificImage: () => {}, recordMagnificVideo: () => {},
}));

import { acquireVisual } from "./visual-source";
import { manualMediaDir, manualPromptsPath } from "./manual-pending";
import type { Beat } from "./studio-plan";

const OUT = path.join(os.tmpdir(), `visual-source-manual-out-${process.pid}.mp4`);

function beat(overrides: Partial<Beat> = {}): Beat {
  return {
    index: 0, startMs: 0, endMs: 4000, text: "a widget on a bench",
    layout: "broll", visualQuery: "widget on a bench", source: "ai",
    ...overrides,
  } as Beat;
}

beforeEach(() => {
  kb.used.mockClear();
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  Object.assign(SETTINGS, {
    AI_PROVIDER: "manual",
    GOOGLE_API_KEY: "", // no vision scoring — maxAttempts===1 short-circuits to score 100
    AI_REGEN_ATTEMPTS: "1",
    KIE_AI_MEDIA: "image",
  });
});

afterEach(() => {
  try { fs.unlinkSync(OUT); } catch {}
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
});

describe("AI_PROVIDER=manual", () => {
  it("no manual file yet: writes the prompt and throws ManualGenerationPendingError", async () => {
    await expect(acquireVisual("run", beat(), OUT, new Set(), {})).rejects.toThrow("waiting for manual AI generation");
    const prompts = fs.readFileSync(manualPromptsPath(RUN_DIR), "utf8");
    expect(prompts).toContain("Beat 0000");
    expect(prompts).toContain("image");
  });

  it("re-attempting the same pending beat does not duplicate its prompt entry", async () => {
    await expect(acquireVisual("run", beat(), OUT, new Set(), {})).rejects.toThrow();
    await expect(acquireVisual("run", beat(), OUT, new Set(), {})).rejects.toThrow();
    const prompts = fs.readFileSync(manualPromptsPath(RUN_DIR), "utf8");
    expect(prompts.match(/Beat 0000/g)?.length).toBe(1);
  });

  it("an operator-supplied IMAGE file is used directly, via Ken Burns", async () => {
    fs.mkdirSync(manualMediaDir(RUN_DIR), { recursive: true });
    fs.writeFileSync(path.join(manualMediaDir(RUN_DIR), "beat_0000.png"), "png-bytes");
    const r = await acquireVisual("run", beat(), OUT, new Set(), {});
    expect(kb.used).toHaveBeenCalled();
    expect(r.kind).toBe("ai");
    expect(r.provider).toBe("manual:image");
  });

  it("an operator-supplied VIDEO file is copied through as-is (no Ken Burns)", async () => {
    SETTINGS.KIE_AI_MEDIA = "video";
    fs.mkdirSync(manualMediaDir(RUN_DIR), { recursive: true });
    fs.writeFileSync(path.join(manualMediaDir(RUN_DIR), "beat_0000.mp4"), "mp4-bytes");
    const r = await acquireVisual("run", beat(), OUT, new Set(), {});
    expect(kb.used).not.toHaveBeenCalled();
    expect(r.kind).toBe("ai");
    expect(r.provider).toBe("manual:video");
    expect(fs.readFileSync(OUT, "utf8")).toBe("mp4-bytes");
  });

  it("a beat pinned to video (KIE_AI_MEDIA=video) writes a video-labelled prompt, not image", async () => {
    SETTINGS.KIE_AI_MEDIA = "video";
    await expect(acquireVisual("run", beat({ index: 5 }), OUT, new Set(), {})).rejects.toThrow();
    const prompts = fs.readFileSync(manualPromptsPath(RUN_DIR), "utf8");
    expect(prompts).toContain("Beat 0005");
    expect(prompts).toContain("video");
  });
});

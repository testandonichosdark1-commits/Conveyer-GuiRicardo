import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * FLOW_FALLBACK_PROVIDER=vids — requested after a real run showed Flow occasionally
 * missing its own 240s window under FLOW_IMAGE_CONCURRENCY: when Flow itself fails, try
 * the free Google Vids source BEFORE any paid one, then fall through to the SAME
 * Cloudflare -> Pollinations -> Meta Muse -> kie.ai chain "chain" already runs if Vids
 * also has nothing — "vids" is a layer in FRONT of that chain, never a replacement that
 * leaves a beat stranded if the free source happens to be down too.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
const kieGen = vi.hoisted(() => ({ image: vi.fn() }));
const flowGen = vi.hoisted(() => ({ image: vi.fn() }));
const vidsGen = vi.hoisted(() => ({ image: vi.fn() }));
const cf = vi.hoisted(() => ({ image: vi.fn() }));
const kb = vi.hoisted(() => ({ used: vi.fn() }));
const ctl = vi.hoisted(() => ({ flowFails: true, vidsFails: false, cloudflareConfigured: false, flowFailCode: "ui" as string }));

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
    if (ctl.flowFails) return Promise.reject(new FakeFlowBrowserError("flow image failure", ctl.flowFailCode));
    fs.writeFileSync(outPath, "png-bytes");
    return Promise.resolve({ path: outPath, model: "nano banana pro" });
  },
  generateFlowVideo: () => Promise.reject(new FakeFlowBrowserError("not used", "ui")),
}));

vi.mock("./vids-browser", () => ({
  generateVidsImage: (_runId: string, _prompt: string, outPath: string) => {
    vidsGen.image(outPath);
    if (ctl.vidsFails) return Promise.reject(new FakeFlowBrowserError("vids image failed", "ui"));
    fs.writeFileSync(outPath, "vids-jpg-bytes");
    return Promise.resolve({ path: outPath, width: 1376, height: 768 });
  },
  generateVidsVideo: () => Promise.reject(new FakeFlowBrowserError("not used", "ui")),
}));

vi.mock("./kie", () => ({
  generateImageUrl: (...a: unknown[]) => { kieGen.image(...a); return Promise.resolve("http://kie/img"); },
  generateVideoUrl: () => Promise.resolve("http://kie/vid"),
  downloadKie: (_url: string, out: string) => { fs.writeFileSync(out, "x"); return Promise.resolve(); },
}));
vi.mock("./cloudflare-image", () => ({
  cloudflareImageConfigured: () => ctl.cloudflareConfigured,
  generateCloudflareImage: (_runId: string, _prompt: string, outPath: string) => {
    cf.image(outPath);
    fs.writeFileSync(outPath, "cf-bytes");
    return Promise.resolve({ path: outPath, profileLabel: "Primary" });
  },
}));
vi.mock("./ken-burns", () => ({ kenBurns: (...a: unknown[]) => { kb.used(...a); fs.writeFileSync(a[1] as string, "x"); } }));
vi.mock("./cost-ledger", () => ({
  recordKieImage: () => {}, recordKieVeo: () => {}, recordGemini: () => {},
  recordLabs69: () => {}, recordMagnificImage: () => {}, recordMagnificVideo: () => {},
}));

import { acquireVisual } from "./visual-source";
import type { Beat } from "./studio-plan";

const OUT = path.join(os.tmpdir(), `flow-vids-fallback-${process.pid}.mp4`);
const REF_PHOTO = path.join(os.tmpdir(), `flow-vids-fallback-ref-${process.pid}.jpg`);

function beat(overrides: Partial<Beat> = {}): Beat {
  return {
    index: 0, startMs: 0, endMs: 4000, text: "a widget on a bench",
    layout: "broll", visualQuery: "widget on a bench", source: "ai",
    ...overrides,
  } as Beat;
}

beforeEach(() => {
  kieGen.image.mockClear();
  flowGen.image.mockClear();
  vidsGen.image.mockClear();
  cf.image.mockClear();
  kb.used.mockClear();
  ctl.flowFails = true;
  ctl.vidsFails = false;
  ctl.cloudflareConfigured = false;
  ctl.flowFailCode = "ui";
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  fs.writeFileSync(REF_PHOTO, "jpg-bytes");
  Object.assign(SETTINGS, {
    AI_PROVIDER: "flow_browser",
    GOOGLE_API_KEY: "", // no vision scoring — maxAttempts===1 short-circuits to score 100
    FLOW_REGEN_ATTEMPTS: "1",
    FLOW_FALLBACK_PROVIDER: "vids",
    KIE_AI_MEDIA: "image",
    KIE_API_KEY: "test-key",
  });
});

afterEach(() => {
  try { fs.unlinkSync(OUT); } catch {}
  try { fs.unlinkSync(REF_PHOTO); } catch {}
});

describe("FLOW_FALLBACK_PROVIDER=vids", () => {
  // Each test uses its OWN run id. visual-source.ts tracks Flow/Vids health
  // (flowSpentRuns, vidsSpentRuns, vidsConsecutiveFailures) in module-level state keyed
  // by run id, which outlives any one test — reusing "run" across tests let an earlier
  // test's 3 consecutive Flow failures mark the run "spent" and made a LATER test skip
  // Flow entirely, never calling it at all. Real runs never share an id; neither should
  // these tests.
  it("Flow fails, Vids succeeds: the beat comes from Vids, kie/Cloudflare are never touched", async () => {
    const r = await acquireVisual("run-1", beat(), OUT, new Set(), {});
    expect(flowGen.image).toHaveBeenCalled();
    expect(vidsGen.image).toHaveBeenCalled();
    expect(kieGen.image).not.toHaveBeenCalled();
    expect(cf.image).not.toHaveBeenCalled();
    expect(r.provider).toBe("vids:nano-banana");
    expect(kb.used).toHaveBeenCalled();
  });

  it("Flow fails, Vids ALSO fails: falls through to the same chain 'chain' would run (Cloudflare here)", async () => {
    ctl.vidsFails = true;
    ctl.cloudflareConfigured = true;
    const r = await acquireVisual("run-2", beat(), OUT, new Set(), {});
    expect(flowGen.image).toHaveBeenCalled();
    expect(vidsGen.image).toHaveBeenCalled();
    expect(cf.image).toHaveBeenCalled(); // the chain still ran — never stranded
    expect(r.provider).toContain("cloudflare");
  });

  it("Flow fails, Vids also fails, and Cloudflare is not configured: still reaches kie.ai — never fails closed", async () => {
    ctl.vidsFails = true;
    ctl.cloudflareConfigured = false;
    const r = await acquireVisual("run-3", beat(), OUT, new Set(), {});
    expect(vidsGen.image).toHaveBeenCalled();
    expect(kieGen.image).toHaveBeenCalled();
    expect(r.provider).toBe("kie:nano-banana");
  });

  it("a character-reference beat NEVER tries Vids (its image panel has no reference input) — goes straight to kie", async () => {
    SETTINGS.AI_CHARACTER_REFERENCE_PATH = REF_PHOTO;
    SETTINGS.AI_CHARACTER_TERMS = "housekeeper";
    const r = await acquireVisual("run-4", beat({ visualQuery: "the housekeeper wipes a mirror" }), OUT, new Set(), {});
    expect(flowGen.image).toHaveBeenCalled();
    expect(vidsGen.image).not.toHaveBeenCalled();
    expect(kieGen.image).toHaveBeenCalled();
    expect(r.provider).toBe("kie:nano-banana");
  });

  it("once Flow is known spent for this run (a credits hit), a LATER beat skips Flow entirely but still tries Vids first — it must not jump straight to the paid chain", async () => {
    ctl.flowFailCode = "credits"; // trips flowSpentRuns on the very first beat
    ctl.vidsFails = true; // so the first beat falls through and we can see kie get used too
    ctl.cloudflareConfigured = true;
    const first = await acquireVisual("run-6", beat({ index: 0 }), OUT, new Set(), {});
    expect(flowGen.image).toHaveBeenCalledTimes(1);
    expect(vidsGen.image).toHaveBeenCalledTimes(1);
    expect(first.provider).toContain("cloudflare");

    flowGen.image.mockClear();
    vidsGen.image.mockClear();
    cf.image.mockClear();
    ctl.vidsFails = false; // this time Vids works, so we can see the beat actually came from it
    const second = await acquireVisual("run-6", beat({ index: 1 }), OUT, new Set(), {});
    expect(flowGen.image).not.toHaveBeenCalled(); // Flow itself is skipped — known spent
    expect(vidsGen.image).toHaveBeenCalledTimes(1); // but Vids is still tried, every beat
    expect(second.provider).toBe("vids:nano-banana");
  });

  it("FLOW_FALLBACK_PROVIDER=chain (not 'vids') never touches Vids at all — regression guard", async () => {
    SETTINGS.FLOW_FALLBACK_PROVIDER = "chain";
    ctl.cloudflareConfigured = true;
    const r = await acquireVisual("run-5", beat(), OUT, new Set(), {});
    expect(vidsGen.image).not.toHaveBeenCalled();
    expect(cf.image).toHaveBeenCalled();
    expect(r.provider).toContain("cloudflare");
  });
});

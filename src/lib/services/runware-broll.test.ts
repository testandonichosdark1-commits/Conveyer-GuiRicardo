import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Runware as a b-roll backend: it must be indistinguishable from the other providers
 * to everything downstream, and must not change what those providers send.
 *
 * The four properties under test:
 *   1. A Runware beat produces the SAME shape of result as a kie beat — a Ken Burns
 *      clip at `outPath` — so the planner/assembly cannot tell them apart.
 *   2. The scoring pipeline is untouched: identical regen-until-threshold and
 *      best-of-N selection as the kie path.
 *   3. The prompt SPLIT is correct — bans move to the native negativePrompt, the
 *      positive prompt stays clean — while kie's prompt stays BYTE-IDENTICAL.
 *   4. Cost is recorded from Runware's REAL reported amount.
 */

const { SETTINGS } = vi.hoisted(() => ({ SETTINGS: {} as Record<string, string> }));
const rw = vi.hoisted(() => ({ gen: vi.fn(), cost: vi.fn() }));
const kie = vi.hoisted(() => ({ image: vi.fn(), video: vi.fn() }));
const anim = vi.hoisted(() => ({ scene: vi.fn() }));
const vision = vi.hoisted(() => ({ scores: [] as number[] }));
// Per-attempt control: what Runware returns, and whether it fails.
const ctl = vi.hoisted(() => ({ fails: false, cost: 0.0051 as number | null }));

vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

vi.mock("./runware", () => ({
  generateRunwareImage: (runId: string, prompt: string, opts: Record<string, unknown>) => {
    rw.gen(prompt, opts);
    return ctl.fails
      ? Promise.reject(new Error("Runware 503 (imageInference): capacity"))
      : Promise.resolve({
          url: "https://im.runware.ai/img.png",
          cost: ctl.cost,
          model: "runware:101@1",
          width: 1920,
          height: 1088,
        });
  },
  downloadRunware: (_url: string, out: string) => {
    fs.writeFileSync(out, "img");
    return Promise.resolve();
  },
}));

vi.mock("./kie", () => ({
  generateImageUrl: (...a: unknown[]) => { kie.image(...a); return Promise.resolve("http://kie/img"); },
  generateVideoUrl: (...a: unknown[]) => { kie.video(...a); return Promise.resolve("http://kie/vid"); },
  downloadKie: (_url: string, out: string) => { fs.writeFileSync(out, "x"); return Promise.resolve(); },
}));

vi.mock("./img2vid", () => ({
  animateScene: (_runId: string, _scene: unknown, _img: unknown, dir: string) => {
    anim.scene();
    const p = path.join(dir, `floor-${process.pid}.mp4`);
    fs.writeFileSync(p, "v");
    return Promise.resolve(p);
  },
}));

vi.mock("./ken-burns", () => ({ kenBurns: (_src: string, out: string) => fs.writeFileSync(out, "kb") }));

// Magnific stays unconfigured so its cross-provider fallback never fires and the
// fall-through order under test is Runware → 69labs/Grok floor.
vi.mock("./magnific", () => ({
  generateMagnificImageUrl: () => Promise.reject(new Error("unused")),
  generateMagnificVideoUrl: () => Promise.reject(new Error("unused")),
  downloadMagnific: () => Promise.resolve(),
  magnificConfigured: () => false,
}));

vi.mock("./image-gen", () => ({ labs69Image: () => Promise.reject(new Error("unused")) }));

vi.mock("./cost-ledger", () => ({
  recordKieImage: () => {}, recordKieVeo: () => {}, recordGemini: () => {},
  recordLabs69: () => {}, recordMagnificImage: () => {}, recordMagnificVideo: () => {},
  recordRunwareImage: (...a: unknown[]) => rw.cost(...a),
}));

// Vision scoring: hand back the next queued score so the regen loop can be driven.
vi.mock("./gemini-models", () => ({
  callGemini: () => {
    const score = vision.scores.shift() ?? 100;
    return Promise.resolve({
      json: {
        candidates: [{ content: { parts: [{ text: JSON.stringify({ score }) }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      },
      model: "gemini-test",
    });
  },
  isRetiredGeminiModel: () => false,
  replacementForGeminiModel: (m: string) => m,
}));

import { acquireVisual, toNegativeTerms, keepPositiveClauses } from "./visual-source";
import type { Beat } from "./studio-plan";

const OUT = path.join(os.tmpdir(), `runware-broll-${process.pid}.mp4`);

/** A planned-AI beat goes straight to acquireAi — no stock retrieval involved. */
function beat(source: "real" | "ai" = "ai"): Beat {
  return {
    index: 0,
    startMs: 0,
    endMs: 4000,
    text: "a widget on a bench",
    layout: "broll",
    aiPrompt: "a widget on a bench",
    visualQuery: "widget bench",
    source,
  } as Beat;
}

const OPTS = { aiStyle: "cinematic", resolution: "1920x1080", videoContext: "widgets" };

/**
 * The EXACT prompt kie has always received, spelled out. If a refactor of the shared
 * prompt pieces changes this by even one character, this test fails — which is the
 * point: Runware's split must not alter what the existing providers send.
 */
const LEGACY_KIE_PROMPT =
  "a widget on a bench, in a documentary about: widgets, cinematic, " +
  "absolutely no text, no captions, no words, no letters, no numbers, no labels, no brand names, no logos, " +
  "no signs, no posters, no handwriting, no writing on any object, blank unlabeled plain packaging, no watermark";

beforeEach(() => {
  rw.gen.mockClear();
  rw.cost.mockClear();
  kie.image.mockClear();
  kie.video.mockClear();
  anim.scene.mockClear();
  vision.scores = [];
  ctl.fails = false;
  ctl.cost = 0.0051;
  for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
  Object.assign(SETTINGS, {
    FOOTAGE_SOURCES: "pexels",
    PEXELS_API_KEY: "test-key",
    GOOGLE_API_KEY: "", // vision off unless a test turns it on
    AI_PROVIDER: "runware",
    RUNWARE_API_KEY: "test-key",
    AI_REGEN_ATTEMPTS: "1",
    YT_DLP_ENABLED: "0",
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ videos: [], photos: [], hits: [] }), { status: 200 })) as unknown as typeof fetch);
});

afterEach(() => {
  try { fs.unlinkSync(OUT); } catch {}
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("prompt clause partitioning", () => {
  it("toNegativeTerms strips every form of negation we use", () => {
    expect(toNegativeTerms("absolutely no text, no captions, NOT sci-fi, no glowing magic")).toBe(
      "text, captions, sci-fi, glowing magic"
    );
  });

  it("keepPositiveClauses keeps only the non-ban clauses", () => {
    expect(keepPositiveClauses("absolutely no text, blank unlabeled plain packaging, no watermark")).toBe(
      "blank unlabeled plain packaging"
    );
  });

  it("the two are a partition — every clause lands in exactly one side", () => {
    const src = "absolutely no text, no captions, blank unlabeled plain packaging, NOT surreal, no watermark";
    const n = toNegativeTerms(src).split(", ").filter(Boolean);
    const p = keepPositiveClauses(src).split(", ").filter(Boolean);
    expect(n.length + p.length).toBe(src.split(",").length);
  });
});

describe("Runware b-roll generation", () => {
  it("produces a Ken Burns clip at outPath and reports itself as the provider", async () => {
    const r = await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    expect(rw.gen).toHaveBeenCalledTimes(1);
    expect(r.path).toBe(OUT);
    expect(r.kind).toBe("ai"); // same kind as every other AI backend
    expect(r.provider).toBe("runware");
    expect(fs.existsSync(OUT)).toBe(true);
  });

  it("passes the run's resolution through, so `format` stays threaded end-to-end", async () => {
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    expect(rw.gen.mock.calls[0][1]).toMatchObject({ resolution: "1920x1080" });
  });

  it("never generates AI video — Runware is image-only, so the video floor is untouched", async () => {
    SETTINGS.KIE_AI_MEDIA = "video"; // would push kie to Veo; must not affect Runware
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    expect(rw.gen).toHaveBeenCalled();
    expect(kie.video).not.toHaveBeenCalled();
    expect(anim.scene).not.toHaveBeenCalled();
  });
});

describe("AI_IMAGE_STYLE subject placeholder", () => {
  it("merges base into the style template instead of prepending it as its own clause", async () => {
    const opts = { ...OPTS, aiStyle: "Amateur smartphone photo of [INSIRA O ASSUNTO AQUI], casual snapshot, low sharpness" };
    await acquireVisual("run", beat(), OUT, new Set(), opts);
    const positive = rw.gen.mock.calls[0][0] as string;
    expect(positive).toBe(
      "Amateur smartphone photo of a widget on a bench, casual snapshot, low sharpness, " +
        "blank unlabeled plain packaging"
    );
    // base must not ALSO appear as its own leading clause — the placeholder consumed it.
    expect(positive.match(/a widget on a bench/g)?.length).toBe(1);
  });

  it("supports the English phrasing too", async () => {
    const opts = { ...OPTS, aiStyle: "A photo of [insert subject here], vintage film grain" };
    await acquireVisual("run", beat(), OUT, new Set(), opts);
    const positive = rw.gen.mock.calls[0][0] as string;
    expect(positive).toContain("A photo of a widget on a bench, vintage film grain");
  });

  it("without a placeholder, base still leads the prompt exactly as before", async () => {
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    const positive = rw.gen.mock.calls[0][0] as string;
    expect(positive.startsWith("a widget on a bench, in a documentary about: widgets, cinematic")).toBe(true);
  });
});

describe("prompt split", () => {
  it("the POSITIVE prompt is clean — no ban clauses leak into it", async () => {
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    const positive = rw.gen.mock.calls[0][0] as string;
    expect(positive).toBe(
      "a widget on a bench, in a documentary about: widgets, cinematic, blank unlabeled plain packaging"
    );
    expect(positive).not.toMatch(/\bno |NOT /);
  });

  it("the bans move to the native negativePrompt as BARE terms (not double negatives)", async () => {
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    const { negativePrompt } = rw.gen.mock.calls[0][1] as { negativePrompt: string };
    expect(negativePrompt).toBe(
      "text, captions, words, letters, numbers, labels, brand names, logos, signs, posters, handwriting, " +
        "writing on any object, watermark, fantasy, sci-fi, surreal, abstract, digital art, illustration, " +
        "3D render, glowing magic, neon"
    );
    // "no text" inside a negative prompt is a double negative — it would ASK for text.
    expect(negativePrompt).not.toMatch(/\bno\b|\bNOT\b/);
  });

  it("REGRESSION GUARD: kie's prompt is byte-identical to before the split", async () => {
    SETTINGS.AI_PROVIDER = "kie";
    SETTINGS.KIE_API_KEY = "test-key";
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    expect(kie.image).toHaveBeenCalledTimes(1);
    expect(kie.image.mock.calls[0][1]).toBe(LEGACY_KIE_PROMPT);
    expect(rw.gen).not.toHaveBeenCalled();
  });
});

describe("scoring pipeline is unchanged", () => {
  it("regenerates while below AI_MATCH_THRESHOLD and keeps the BEST attempt", async () => {
    SETTINGS.GOOGLE_API_KEY = "g";
    SETTINGS.AI_REGEN_ATTEMPTS = "3";
    SETTINGS.AI_MATCH_THRESHOLD = "80";
    vision.scores = [40, 72, 55]; // never clears the bar → all 3 attempts run, best = 72
    const r = await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    expect(rw.gen).toHaveBeenCalledTimes(3);
    expect(r.provider).toBe("runware");
  });

  it("early-exits as soon as an attempt clears the threshold", async () => {
    SETTINGS.GOOGLE_API_KEY = "g";
    SETTINGS.AI_REGEN_ATTEMPTS = "5";
    SETTINGS.AI_MATCH_THRESHOLD = "75";
    vision.scores = [50, 90];
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    expect(rw.gen).toHaveBeenCalledTimes(2);
  });

  it("uses a DIFFERENT prompt variant per attempt, exactly like the kie loop", async () => {
    SETTINGS.GOOGLE_API_KEY = "g";
    SETTINGS.AI_REGEN_ATTEMPTS = "3";
    SETTINGS.AI_MATCH_THRESHOLD = "99";
    vision.scores = [10, 10, 10];
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    const prompts = rw.gen.mock.calls.map((c) => c[0] as string);
    expect(new Set(prompts).size).toBe(3);
    expect(prompts[1]).toMatch(/alternative composition, different camera angle$/);
  });
});

describe("cost ledger", () => {
  it("records the REAL amount Runware reported, with the model, once per generation", async () => {
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    expect(rw.cost).toHaveBeenCalledTimes(1);
    expect(rw.cost).toHaveBeenCalledWith("run", 0.0051, "runware:101@1");
  });

  it("bills every regeneration attempt, not just the kept one", async () => {
    SETTINGS.GOOGLE_API_KEY = "g";
    SETTINGS.AI_REGEN_ATTEMPTS = "3";
    SETTINGS.AI_MATCH_THRESHOLD = "99";
    vision.scores = [10, 10, 10];
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    expect(rw.cost).toHaveBeenCalledTimes(3);
  });

  it("passes null through untouched when Runware reported no cost — never a fabricated number", async () => {
    ctl.cost = null;
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    expect(rw.cost).toHaveBeenCalledWith("run", null, "runware:101@1");
  });

  it("records nothing for a failed generation — Runware does not charge for those", async () => {
    ctl.fails = true;
    await acquireVisual("run", beat(), OUT, new Set(), OPTS).catch(() => {});
    expect(rw.cost).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  it("falls through to the 69labs/Grok floor rather than losing the beat", async () => {
    ctl.fails = true;
    const r = await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    expect(rw.gen).toHaveBeenCalled();
    expect(anim.scene).toHaveBeenCalled(); // the universal floor caught the beat
    expect(r.path).toBe(OUT);
  });

  it('a "Videos only" fallback skips Runware entirely instead of returning a still', async () => {
    // Runware is image-only, so it cannot honour "AI video and NOT images". It must step
    // aside for the video floor — the same promise the kie branch keeps at its Veo guard.
    SETTINGS.FALLBACK_AI_MEDIA = "video";
    const r = await acquireVisual("run", beat("real"), OUT, new Set(), OPTS);
    expect(rw.gen).not.toHaveBeenCalled();
    expect(anim.scene).toHaveBeenCalled();
    expect(r.path).toBe(OUT);
  });

  it('an "Images only" fallback still uses Runware and never reaches the video floor', async () => {
    SETTINGS.FALLBACK_AI_MEDIA = "image";
    const r = await acquireVisual("run", beat("real"), OUT, new Set(), OPTS);
    expect(rw.gen).toHaveBeenCalled();
    expect(anim.scene).not.toHaveBeenCalled();
    expect(r.provider).toBe("runware");
  });

  it('"Images only" + a total Runware outage degrades gracefully — never a surprise AI video', async () => {
    SETTINGS.FALLBACK_AI_MEDIA = "image";
    ctl.fails = true;
    await expect(acquireVisual("run", beat("real"), OUT, new Set(), OPTS)).rejects.toThrow(/Images only/i);
    expect(anim.scene).not.toHaveBeenCalled();
  });
});

/**
 * Product shots — a beat the planner marked with `product_label`.
 *
 * The bug this fixes is not a missing label, it is a missing PRODUCT. Measured on real
 * runs: a beat whose narration said "The brand name is Arm & Hammer Super Washing Soda",
 * and whose ai_prompt duly asked for that box with "the brand name clearly visible",
 * rendered as a featureless yellow cube on a shop floor. The cause is `blank unlabeled
 * plain packaging` — a POSITIVE clause, so it survives the split into the positive prompt
 * and describes the object's appearance, not just its text.
 *
 * Hence both assertions below: the label alone on an anonymous block is the same failure.
 */
describe("product shots carry the product, not just the lettering", () => {
  const productBeat = (): Beat => ({ ...beat(), productLabel: "Arm & Hammer" } as Beat);

  it("asks for a recognisable retail item AND the exact lettering", async () => {
    await acquireVisual("run", productBeat(), OUT, new Set(), OPTS);
    const positive = rw.gen.mock.calls[0][0] as string;
    expect(positive).toContain('clearly and correctly reads "Arm & Hammer"');
    // The identity half — without it the model is free to letter a plain coloured box.
    expect(positive).toMatch(/recognisable retail item of its category with authentic packaging design/);
    // "not a plain coloured box" leads with "not", so the existing split routes it to the
    // native negative side. Same instruction, correct half — asserted where it lands.
    const { negativePrompt } = rw.gen.mock.calls[0][1] as { negativePrompt: string };
    expect(negativePrompt).toContain("a plain coloured box");
  });

  it("drops 'blank unlabeled plain packaging' entirely — the clause that erased the product", async () => {
    await acquireVisual("run", productBeat(), OUT, new Set(), OPTS);
    const positive = rw.gen.mock.calls[0][0] as string;
    expect(positive).not.toContain("blank unlabeled plain packaging");
    const { negativePrompt } = rw.gen.mock.calls[0][1] as { negativePrompt: string };
    // It must not reappear on the negative side either — "labels"/"brand names" bans are
    // exactly what we are lifting for this beat.
    expect(negativePrompt).not.toContain("labels");
    expect(negativePrompt).not.toContain("brand names");
  });

  it("still bans every OTHER kind of text — this is a licence for packaging, not for captions", async () => {
    await acquireVisual("run", productBeat(), OUT, new Set(), OPTS);
    const { negativePrompt } = rw.gen.mock.calls[0][1] as { negativePrompt: string };
    for (const banned of ["captions", "subtitles", "signs", "posters", "handwriting", "gibberish lettering", "watermark"]) {
      expect(negativePrompt).toContain(banned);
    }
  });

  it("a beat WITHOUT a label is untouched — the pre-feature prompt, verbatim", async () => {
    await acquireVisual("run", beat(), OUT, new Set(), OPTS);
    const positive = rw.gen.mock.calls[0][0] as string;
    expect(positive).toContain("blank unlabeled plain packaging");
    expect(positive).not.toMatch(/reads "/);
  });
});

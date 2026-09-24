import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

/**
 * Unit tests for the pieces of the Flow/Veo browser adapter that don't require a live
 * Chrome + Google Flow session: Veo model-name normalization/matching, video candidate
 * selection, the pre-ffprobe HTML/JSON sniff, real ffprobe-backed file validation, the
 * separate image/video timeout settings, and the clear-then-attach reference sequencing
 * (driven with a fake Playwright Page/Locator — see the `FakePage` section below).
 *
 * Deliberately NOT covered here (needs a live Chrome + Flow session to verify against the
 * real DOM, per the module's own "not yet validated" notes): ensureFlowMediaMode,
 * ensureVeoModel's option-picking, ensureFlowAspectRatio/ensureFlowDuration's UI discovery,
 * and the network-response / official-download capture races in generateFlowVideo itself.
 */

const SETTINGS = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => SETTINGS.values[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import {
  normalizeFlowModelLabel,
  veoModelLabelMatches,
  flowModelLabelMatches,
  isModelIndependentFailure,
  isVideoResponseCandidate,
  newestVideoCandidate,
  looksLikeNonVideoBody,
  validateFlowVideoFile,
  flowImageTimeoutMs,
  flowVideoTimeoutMs,
  flowRequestedVideoDurationSec,
  chooseBestCapturedImage,
  prepareComposerReference,
  looksLikeReferenceEcho,
  classifyFlowFailureBody,
  failureBaselineOf,
  chipShowsModel,
  FlowBrowserError,
} from "./flow-browser";

beforeEach(() => {
  SETTINGS.values = {};
});

describe("normalizeFlowModelLabel", () => {
  it("lowercases, turns hyphens/underscores into spaces, and collapses whitespace", () => {
    expect(normalizeFlowModelLabel("veo-3.1-fast")).toBe("veo 3.1 fast");
    expect(normalizeFlowModelLabel("Veo_3.1_Fast")).toBe("veo 3.1 fast");
    expect(normalizeFlowModelLabel("  Veo   3.1   Fast  ")).toBe("veo 3.1 fast");
  });
});

describe("veoModelLabelMatches", () => {
  it("matches an exact (normalized) label", () => {
    expect(veoModelLabelMatches("veo-3.1-fast", "Veo 3.1 Fast")).toBe(true);
  });
  it("matches when the UI decorates the label (badge/suffix text)", () => {
    expect(veoModelLabelMatches("veo-3.1-fast", "Veo 3.1 Fast (Beta)")).toBe(true);
    expect(veoModelLabelMatches("veo-3.1-fast", "New: Veo 3.1 Fast")).toBe(true);
  });
  it("does NOT match a different tier — 'Veo 3' must never match 'veo-3.1'", () => {
    expect(veoModelLabelMatches("veo-3.1", "Veo 3")).toBe(false);
    expect(veoModelLabelMatches("veo-3", "Veo 3.1")).toBe(false);
  });
  it("does NOT match Fast vs Quality vs plain", () => {
    expect(veoModelLabelMatches("veo-3.1-fast", "Veo 3.1 Quality")).toBe(false);
    expect(veoModelLabelMatches("veo-3.1-quality", "Veo 3.1 Fast")).toBe(false);
    expect(veoModelLabelMatches("veo-3.1", "Veo 3.1 Fast")).toBe(false);
  });
  it("is empty-safe", () => {
    expect(veoModelLabelMatches("", "Veo 3.1 Fast")).toBe(false);
    expect(veoModelLabelMatches("veo-3.1-fast", "")).toBe(false);
  });
});

describe("flowModelLabelMatches — Nano Banana tiers (same matcher, shared with Veo)", () => {
  it("matches the exact tier", () => {
    expect(flowModelLabelMatches("nano-banana-2", "Nano Banana 2")).toBe(true);
    expect(flowModelLabelMatches("nano-banana-pro", "Nano Banana Pro")).toBe(true);
  });
  it("tolerates cosmetic decoration", () => {
    expect(flowModelLabelMatches("nano-banana-2", "Nano Banana 2 (New)")).toBe(true);
  });
  it("never lets the plain tier match Pro, or Pro match a numbered tier", () => {
    expect(flowModelLabelMatches("nano-banana", "Nano Banana Pro")).toBe(false);
    expect(flowModelLabelMatches("nano-banana-pro", "Nano Banana 2")).toBe(false);
    expect(flowModelLabelMatches("nano-banana-2", "Nano Banana Pro")).toBe(false);
  });
});

describe("chipShowsModel — which model does the composer chip / family select show as ACTIVE", () => {
  // Strings captured from the live Flow DOM (innerText, "\n" shown as newlines).
  const CHIP_2 = "🍌 Nano Banana 2\ncrop_16_9\nx1";
  const SELECT_2 = "🍌 Nano Banana 2\narrow_drop_down";

  it("reads the active model off the real chip and select text, ignoring the furniture", () => {
    expect(chipShowsModel(CHIP_2, "nano banana 2")).toBe(true);
    expect(chipShowsModel(SELECT_2, "nano-banana-2")).toBe(true);
  });

  it("does not report a different tier as active", () => {
    expect(chipShowsModel(CHIP_2, "nano banana pro")).toBe(false);
    expect(chipShowsModel(CHIP_2, "nano banana")).toBe(false); // "2" continues the name
    expect(chipShowsModel("🍌 Nano Banana 2 Lite\ncrop_16_9\nx1", "nano banana 2")).toBe(false);
    expect(chipShowsModel("🍌 Nano Banana Pro\ncrop_16_9\nx1", "nano banana 2")).toBe(false);
  });

  it("recognises Pro when it is the active one", () => {
    expect(chipShowsModel("🍌 Nano Banana Pro\ncrop_16_9\nx1", "nano banana pro")).toBe(true);
  });

  it("handles Veo-style names too", () => {
    expect(chipShowsModel("Veo 3.1 - Fast\ncrop_16_9\nx1", "veo 3.1 fast")).toBe(true);
    expect(chipShowsModel("Veo 3.1 - Fast\ncrop_16_9\nx1", "veo 3.1")).toBe(false);
    expect(chipShowsModel("Veo 3.1 - Quality\ncrop_16_9\nx1", "veo 3.1 fast")).toBe(false);
  });

  it("empty inputs are never a match", () => {
    expect(chipShowsModel("", "nano banana 2")).toBe(false);
    expect(chipShowsModel(CHIP_2, "")).toBe(false);
  });
});

describe("isModelIndependentFailure — which failures skip the fallback model", () => {
  it("login and config problems are never worth retrying with a different model", () => {
    expect(isModelIndependentFailure("login")).toBe(true);
    expect(isModelIndependentFailure("config")).toBe(true);
  });
  it("everything else is worth trying the fallback for — including an unrecognized/undefined code", () => {
    expect(isModelIndependentFailure("credits")).toBe(false);
    expect(isModelIndependentFailure("ui")).toBe(false);
    expect(isModelIndependentFailure("timeout")).toBe(false);
    expect(isModelIndependentFailure("capture")).toBe(false);
    expect(isModelIndependentFailure(undefined)).toBe(false);
  });
});

describe("isVideoResponseCandidate", () => {
  it("accepts a video/* content-type", () => {
    expect(isVideoResponseCandidate("video/mp4", "https://cdn.example.com/x")).toBe(true);
  });
  it("accepts a .mp4/.webm URL even with a generic content-type", () => {
    expect(isVideoResponseCandidate("application/octet-stream", "https://cdn.example.com/clip.mp4?sig=abc")).toBe(true);
    expect(isVideoResponseCandidate("", "https://cdn.example.com/clip.webm")).toBe(true);
  });
  it("rejects images and unrelated JSON", () => {
    expect(isVideoResponseCandidate("image/png", "https://cdn.example.com/x")).toBe(false);
    expect(isVideoResponseCandidate("application/json", "https://api.example.com/status")).toBe(false);
  });
});

describe("newestVideoCandidate", () => {
  it("returns null for an empty list", () => {
    expect(newestVideoCandidate([])).toBeNull();
  });
  it("picks the one with the latest capturedAt — 'identify the newest result'", () => {
    const a = { capturedAt: 100 };
    const b = { capturedAt: 300 };
    const c = { capturedAt: 200 };
    expect(newestVideoCandidate([a, b, c])).toBe(b);
  });
  it("is stable when several share the same timestamp (keeps the later push)", () => {
    const a = { capturedAt: 100 };
    const b = { capturedAt: 100 };
    expect(newestVideoCandidate([a, b])).toBe(b);
  });
});

describe("looksLikeNonVideoBody", () => {
  it("flags an HTML error page", () => {
    expect(looksLikeNonVideoBody(Buffer.from("<!DOCTYPE html><html>oops</html>"))).toBe(true);
  });
  it("flags a JSON error body", () => {
    expect(looksLikeNonVideoBody(Buffer.from('{"error":"not found"}'))).toBe(true);
    expect(looksLikeNonVideoBody(Buffer.from('[{"error":"not found"}]'))).toBe(true);
  });
  it("does not flag binary video bytes", () => {
    // A minimal mp4 'ftyp' box start — not text, not '<' / '{' / '['.
    expect(looksLikeNonVideoBody(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBe(false);
  });
});

describe("timeouts — image and video are independent and separately bounded", () => {
  it("defaults", () => {
    expect(flowImageTimeoutMs()).toBe(240_000);
    expect(flowVideoTimeoutMs()).toBe(600_000);
    expect(flowRequestedVideoDurationSec()).toBe(8);
  });
  it("reads its own setting and clamps to its own bounds — raising video never raises image", () => {
    SETTINGS.values.FLOW_GENERATION_TIMEOUT_SEC = "60";
    SETTINGS.values.FLOW_VIDEO_TIMEOUT_SEC = "1200";
    expect(flowImageTimeoutMs()).toBe(60_000);
    expect(flowVideoTimeoutMs()).toBe(1_200_000);
  });
  it("clamps video timeout to its own max (1800s), independent of the image max (900s)", () => {
    SETTINGS.values.FLOW_VIDEO_TIMEOUT_SEC = "999999";
    expect(flowVideoTimeoutMs()).toBe(1_800_000);
  });
  it("falls back on a non-numeric setting rather than producing NaN", () => {
    SETTINGS.values.FLOW_VIDEO_TIMEOUT_SEC = "not-a-number";
    expect(flowVideoTimeoutMs()).toBe(600_000);
  });
});

describe("chooseBestCapturedImage (regression guard — pre-existing behavior)", () => {
  it("prefers the aspect-matching image even if a mismatched one is bigger", () => {
    const wide = { buffer: Buffer.alloc(10), width: 1920, height: 1080, url: "a", capturedAt: 1 };
    const square = { buffer: Buffer.alloc(20), width: 2000, height: 2000, url: "b", capturedAt: 2 };
    expect(chooseBestCapturedImage([square, wide], "16:9")).toBe(wide);
  });
  it("returns null for an empty list", () => {
    expect(chooseBestCapturedImage([], "16:9")).toBeNull();
  });
});

// ── validateFlowVideoFile — real ffprobe against real fixture files ────────────────────

const TMP = path.join(os.tmpdir(), `flow-video-validate-${process.pid}`);
const VALID = path.join(TMP, "valid.mp4");
const EMPTY = path.join(TMP, "empty.mp4");
const HTML_BODY = path.join(TMP, "html-error.mp4");
const JSON_BODY = path.join(TMP, "json-error.mp4");
const AUDIO_ONLY = path.join(TMP, "audio-only.mp4");

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", VALID,
  ], { timeout: 30_000 });
  fs.writeFileSync(EMPTY, Buffer.alloc(0));
  fs.writeFileSync(HTML_BODY, "<!DOCTYPE html><html><body>404 Not Found</body></html>");
  fs.writeFileSync(JSON_BODY, JSON.stringify({ error: "expired" }));
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:a", "aac", AUDIO_ONLY,
  ], { timeout: 30_000 });
}, 60_000);

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("validateFlowVideoFile", () => {
  it("accepts a real video file and reports its shape", async () => {
    const probe = await validateFlowVideoFile(VALID);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(180);
    expect(probe.durationSec).toBeGreaterThan(0);
    expect(probe.codec).toBe("h264");
  });

  it("rejects a missing file", async () => {
    await expect(validateFlowVideoFile(path.join(TMP, "does-not-exist.mp4"))).rejects.toThrow(FlowBrowserError);
  });

  it("rejects an empty file", async () => {
    await expect(validateFlowVideoFile(EMPTY)).rejects.toThrow(/empty/i);
  });

  it("rejects an HTML error page wearing an .mp4 extension", async () => {
    await expect(validateFlowVideoFile(HTML_BODY)).rejects.toThrow(/html|json/i);
  });

  it("rejects a JSON error body wearing an .mp4 extension", async () => {
    await expect(validateFlowVideoFile(JSON_BODY)).rejects.toThrow(/html|json/i);
  });

  it("rejects a file with no video stream (audio-only)", async () => {
    await expect(validateFlowVideoFile(AUDIO_ONLY)).rejects.toThrow(/no video stream/i);
  });

  it("every rejection is a FlowBrowserError with code 'capture'", async () => {
    try {
      await validateFlowVideoFile(EMPTY);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FlowBrowserError);
      expect((e as InstanceType<typeof FlowBrowserError>).code).toBe("capture");
    }
  });
});

// ── looksLikeReferenceEcho — reject Flow echoing the attached photo as the "result" ────

describe("looksLikeReferenceEcho", () => {
  const REF = path.join(TMP, "reference.png");
  let refBuffer: Buffer;
  let differentBuffer: Buffer;

  beforeAll(async () => {
    // A busy, multi-region image (not a flat color) so a resize-based pixel comparison
    // is meaningful — a solid color would trivially "match" any other solid color at a
    // tiny thumbnail size regardless of hue.
    refBuffer = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 120, b: 60 } },
    })
      .composite([{ input: await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 20, g: 200, b: 20 } } }).png().toBuffer(), left: 20, top: 20 }])
      .png()
      .toBuffer();
    fs.writeFileSync(REF, refBuffer);
    differentBuffer = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 10, b: 200 } },
    })
      .composite([{ input: await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 220, g: 220, b: 10 } } }).png().toBuffer(), left: 300, top: 100 }])
      .png()
      .toBuffer();
  });

  it("no reference configured → never an echo", async () => {
    expect(await looksLikeReferenceEcho(refBuffer, undefined)) .toBe(false);
  });

  it("reference file missing on disk → never an echo (fails open, doesn't throw)", async () => {
    expect(await looksLikeReferenceEcho(refBuffer, path.join(TMP, "does-not-exist.png"))).toBe(false);
  });

  it("byte-identical to the reference → echo", async () => {
    expect(await looksLikeReferenceEcho(Buffer.from(refBuffer), REF)).toBe(true);
  });

  it("re-encoded/resized copy of the reference → still an echo", async () => {
    const reencoded = await sharp(refBuffer).resize(512, 384).jpeg({ quality: 90 }).toBuffer();
    expect(await looksLikeReferenceEcho(reencoded, REF)).toBe(true);
  });

  it("a genuinely different image → not an echo", async () => {
    expect(await looksLikeReferenceEcho(differentBuffer, REF)).toBe(false);
  });
});

// ── classifyFlowFailureBody — recognizing Flow's OWN failure cards ─────────────────────

describe("classifyFlowFailureBody", () => {
  it("recognizes the live PT-BR policy-violation card (regression: this exact string was previously missed entirely)", () => {
    const body = "Falha\nEsta geração talvez viole nossas políticas. Tente usar outro comando ou envie feedback.\nNão houve cobrança por esta geração.";
    const err = classifyFlowFailureBody(body, "image");
    expect(err).toBeInstanceOf(FlowBrowserError);
    expect(err!.code).toBe("policy");
    expect(err!.message).toMatch(/policy violation/i);
  });

  it("recognizes the English policy-violation phrasing", () => {
    const err = classifyFlowFailureBody("This generation may violate our policies.", "video");
    expect(err).toBeInstanceOf(FlowBrowserError);
    expect(err!.code).toBe("policy");
  });

  it("still recognizes credits exhaustion, in English and Portuguese", () => {
    expect(classifyFlowFailureBody("You are out of AI credits.")?.code).toBe("credits");
    expect(classifyFlowFailureBody("Você não tem créditos insuficientes para continuar.")?.code).toBe("credits");
  });

  it("still recognizes a generic generation failure", () => {
    expect(classifyFlowFailureBody("Generation failed. Please try again.")?.code).toBe("ui");
    expect(classifyFlowFailureBody("Não foi possível gerar. Tente novamente.")?.code).toBe("ui");
  });

  it("does not fire on ordinary page text", () => {
    expect(classifyFlowFailureBody("Generate a video of a cat playing piano.")).toBeNull();
    expect(classifyFlowFailureBody("")).toBeNull();
  });
});

// ── prepareComposerReference — clear-then-attach sequencing, with a fake Playwright Page ──
//
// This is not a DOM emulator: it implements just enough of the Locator/Page surface that
// clearFlowReferences / setReferenceOnFileInput / confirmReferenceAttached actually call,
// with a tiny bit of state (`chipVisible`) that flips on a successful setInputFiles() and
// flips off on a "remove" click — enough to prove the real ordering: clear → (maybe) attach
// → confirm, and that a later beat with no reference leaves no chip behind.

type FakeLocatorSpec = { kind: "fileInput" } | { kind: "removeButton" };

function makeFakePage(state: { chipVisible: boolean }) {
  function locatorFor(spec: FakeLocatorSpec) {
    const self = {
      count: async () => 1,
      nth: () => self,
      first: () => self,
      last: () => self,
      filter: () => self,
      isVisible: async () => {
        if (spec.kind === "fileInput") return true;
        if (spec.kind === "removeButton") return state.chipVisible;
        return false;
      },
      isEnabled: async () => true,
      getAttribute: async () => "",
      setInputFiles: async () => {
        state.chipVisible = true; // the browser accepted the file → a chip now exists
      },
      click: async () => {
        if (spec.kind === "removeButton") state.chipVisible = false;
      },
      evaluate: async () => undefined,
      innerText: async () => "",
      press: async () => undefined,
    };
    return self;
  }

  const page = {
    locator: (sel: string) => {
      // The asset-picker strategy runs first but finds nothing here (no "+" is visible), so the
      // file-input strategy is what attaches in this fake.
      if (sel.includes('input[type="file"]')) return locatorFor({ kind: "fileInput" });
      // Everything else (remove-reference selectors) behaves as the remove control.
      return locatorFor({ kind: "removeButton" });
    },
    getByRole: () => locatorFor({ kind: "removeButton" }),
    getByText: () => locatorFor({ kind: "removeButton" }),
    keyboard: { press: async () => undefined },
    waitForTimeout: async () => undefined,
    evaluate: async () => ({ names: [], testIds: [], fileInputs: 1 }),
  };
  return page;
}

describe("prepareComposerReference — clear before every beat, attach only when wanted", () => {
  it("a beat with a reference: clears first, then attaches and confirms", async () => {
    const state = { chipVisible: true }; // simulate a PREVIOUS beat's leftover chip
    const page = makeFakePage(state);
    const refFile = path.join(TMP, "ref.png");
    fs.writeFileSync(refFile, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // just needs to exist

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attached = await prepareComposerReference(page as any, page.locator("input") as any, refFile);
    expect(attached).toBe(true);
    expect(state.chipVisible).toBe(true); // re-attached by THIS call, not left over
  });

  it("a beat with no reference: clears any leftover chip and attaches nothing", async () => {
    const state = { chipVisible: true }; // leftover chip from the PREVIOUS (referenced) beat
    const page = makeFakePage(state);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attached = await prepareComposerReference(page as any, page.locator("input") as any, null);
    expect(attached).toBe(false);
    expect(state.chipVisible).toBe(false); // cleaned up — does not leak into this beat
  });
});

describe("isModelIndependentFailure — policy refusals", () => {
  it("never retries a different model tier after a policy refusal", () => {
    expect(isModelIndependentFailure("policy")).toBe(true);
    expect(isModelIndependentFailure("ui")).toBe(false);
  });
});

describe("failure baseline — a stale card from an earlier generation is not this generation failing", () => {
  const stale = "Falha\nEsta geração talvez viole nossas políticas. Tente usar outro comando.";
  it("ignores a refusal already on the page before submit", () => {
    const baseline = failureBaselineOf(stale);
    expect(classifyFlowFailureBody(stale, "image", baseline)).toBeNull();
  });
  it("still reports a NEW refusal that appears after the baseline", () => {
    const baseline = failureBaselineOf(stale);
    const err = classifyFlowFailureBody(stale + "\n" + stale, "image", baseline);
    expect(err?.code).toBe("policy");
  });
  it("without a baseline behaves exactly as before", () => {
    expect(classifyFlowFailureBody(stale)?.code).toBe("policy");
  });
});

describe("usage-limit card", () => {
  it("recognizes the live PT-BR limit card as credits exhaustion", () => {
    const body = "Falha\nVocê chegou ao limite de uso. Tente de novo mais tarde.\nNão houve cobrança por esta geração.";
    expect(classifyFlowFailureBody(body)?.code).toBe("credits");
  });
  it("ignores a limit card that was already there before submit (the limit may have reset)", () => {
    const body = "Falha\nVocê chegou ao limite de uso. Tente de novo mais tarde.";
    expect(classifyFlowFailureBody(body, "image", failureBaselineOf(body))).toBeNull();
  });
});

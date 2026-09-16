import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Planner JSON resilience (studio-plan.ts).
 *
 * Two things are under test:
 *  1. `parsePlannerArray` — the hardened replacement for the old greedy
 *     `/\[[\s\S]*\]/` + JSON.parse one-liner. The regression that motivated it is a
 *     model emitting the array TWICE in one body, which the greedy span turns into a
 *     `][` seam and `Expected ',' or ']' after array element in JSON at position …`.
 *  2. `requestPlanChunk`'s retry wiring — a malformed body must be a TRANSIENT retry
 *     (chunk saved), and `recordGemini` must fire once per HTTP attempt (metering
 *     guard: every 200 is billed by Google, including the ones we reject).
 *
 * Hermetic: fetch is stubbed, and the DB-backed logger / cost ledger are mocked.
 */

const meter = vi.hoisted(() => ({ calls: [] as { model: string; prompt: number; output: number }[] }));

// Controllable settings stub. Default behaviour is unchanged — every key returns "" — so all
// existing tests are unaffected; the overlays-OFF invariant block below sets GOOGLE_API_KEY to
// drive the real planner path, and clears it in afterEach.
const settingsStub = vi.hoisted(() => ({ overrides: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => settingsStub.overrides[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("./cost-ledger", () => ({
  recordGemini: (_runId: string, _cat: string, prompt: number, output: number, model: string) => {
    meter.calls.push({ model, prompt, output });
  },
}));

import { parsePlannerArray, requestPlanChunk, normalizeOverlay, detectVideoStructure, overlayLabel, applyStructureNumbering, numberStructuredOverlays, stripLeadingNumbering, findItemCueMs, findSentenceEndMs, scheduleOverlays, locateItemAnnouncements, locateFactSpoken, introRegionEndMs, assignVisualRoles, buildPlanPrompt, planBeats, splitBeatsAtAnnouncements, mergeShortSectionLeads, applyAiVideoRatio, normalizeProductLabel } from "./studio-plan";
import type { Beat, VideoStructure } from "./studio-plan";
import type { WordTiming } from "./elevenlabs-voiceover";
import { buildOverlayPlan } from "./overlay-renderer";
import os from "node:os";
import path from "node:path";

const ROW = (i: number) => ({ index: i, visual_query: `query ${i}`, ai_media: "image" });
const ARR = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ROW(i)));

describe("parsePlannerArray", () => {
  it("parses a clean JSON array", () => {
    const out = parsePlannerArray(ARR(3));
    expect(out).toHaveLength(3);
    expect(out?.[1].visual_query).toBe("query 1");
  });

  it("parses an array wrapped in markdown fences / surrounding prose", () => {
    expect(parsePlannerArray("```json\n" + ARR(2) + "\n```")).toHaveLength(2);
    expect(parsePlannerArray("Here you go:\n" + ARR(2) + "\nHope that helps.")).toHaveLength(2);
  });

  it("recovers a DUPLICATED/restarted array instead of throwing (the client bug)", () => {
    // The greedy first-[ .. last-] span produces a `][` seam that JSON.parse rejects.
    const glued = ARR(6) + ARR(6);
    expect(() => JSON.parse(glued)).toThrow(); // guard: the old one-liner really did die here
    const out = parsePlannerArray(glued);
    expect(out).toHaveLength(6);
    expect(out?.[0].index).toBe(0);
    expect(out?.[5].index).toBe(5);

    const newlineSeparated = ARR(4) + "\n" + ARR(4);
    expect(parsePlannerArray(newlineSeparated)).toHaveLength(4);
  });

  it("keeps the LARGEST recoverable array when the duplicates differ in length", () => {
    expect(parsePlannerArray(ARR(2) + "\n" + ARR(6))).toHaveLength(6);
  });

  it("is not fooled by a bracket inside a string value", () => {
    const out = parsePlannerArray('[{"index":0,"visual_query":"a ] b [ c"}]');
    expect(out).toHaveLength(1);
    expect(out?.[0].visual_query).toBe("a ] b [ c");
  });

  it("returns null for truncated, garbage or empty input", () => {
    expect(parsePlannerArray('[{"index":0,"visual_query":"a"},{"index":1,')).toBeNull();
    expect(parsePlannerArray("I'm sorry, I can't help with that.")).toBeNull();
    expect(parsePlannerArray("[]")).toBeNull(); // empty array is not a usable plan
    expect(parsePlannerArray("")).toBeNull();
    expect(parsePlannerArray("   ")).toBeNull();
  });
});

/** Minimal Gemini 200 body carrying `text` as the single answer part. */
function geminiBody(text: string, tokens = { p: 100, c: 200 }) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: tokens.p, candidatesTokenCount: tokens.c },
  };
}

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json, text: async () => "" } as unknown as Response;
}

/**
 * Drive a promise that sleeps on callGemini's backoff (4000·n) without waiting in real
 * time. advanceTimersByTimeAsync flushes microtasks between timers, so the stubbed
 * fetch resolves normally.
 */
async function runWithFakeClock<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const p = fn();
    await vi.advanceTimersByTimeAsync(30_000);
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

describe("requestPlanChunk — malformed body retries instead of losing the chunk", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    meter.calls.length = 0;
  });

  it("requests STRUCTURED OUTPUT — a responseSchema constraining the array shape (prevention layer)", async () => {
    let sentBody: unknown = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
      sentBody = JSON.parse(init?.body ?? "{}");
      return okResponse(geminiBody(ARR(6)));
    }));
    await requestPlanChunk("prompt", "run1", "key", "");
    const gc = (sentBody as { generationConfig?: Record<string, unknown> })?.generationConfig ?? {};
    expect(gc.responseMimeType).toBe("application/json");
    const schema = gc.responseSchema as { type?: string; items?: { type?: string; properties?: Record<string, unknown>; required?: string[] } } | undefined;
    expect(schema?.type).toBe("ARRAY"); // an array of planner objects, not free-form JSON
    expect(schema?.items?.type).toBe("OBJECT");
    // Encodes the planner object exactly — the same fields the prompt asks for.
    expect(Object.keys(schema?.items?.properties ?? {}).sort()).toEqual(
      ["ai_media", "ai_prompt", "footage_kind", "index", "product_label", "query_type", "visual_query", "youtube_query"]
    );
    expect(schema?.items?.required).toContain("index");
    // product_label is the only optional one: most shots are not product shots, and a
    // required field would push the model to invent packaging for landscapes and faces.
    expect(schema?.items?.required).not.toContain("product_label");
  });

  it("overlays OFF (default): the schema and prompt are byte-identical to today — no overlay field", async () => {
    let sentBody: unknown = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
      sentBody = JSON.parse(init?.body ?? "{}");
      return okResponse(geminiBody(ARR(6)));
    }));
    await requestPlanChunk("prompt", "run1", "key", "" /* overlays defaults to false */);
    const gc = (sentBody as { generationConfig?: { responseSchema?: { items?: { properties?: Record<string, unknown>; required?: string[] } } } })?.generationConfig ?? {};
    const props = gc.responseSchema?.items?.properties ?? {};
    expect(Object.keys(props)).not.toContain("overlay");
    expect(gc.responseSchema?.items?.required).not.toContain("overlay");
  });

  it("overlays ON: adds a NULLABLE overlay object to the schema, but never to `required`", async () => {
    let sentBody: unknown = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
      sentBody = JSON.parse(init?.body ?? "{}");
      return okResponse(geminiBody(ARR(6)));
    }));
    await requestPlanChunk("prompt", "run1", "key", "", true);
    const gc = (sentBody as { generationConfig?: { responseSchema?: { items?: { properties?: Record<string, { type?: string; nullable?: boolean; enum?: string[]; properties?: Record<string, unknown>; required?: string[] }>; required?: string[] } } } })?.generationConfig ?? {};
    const overlay = gc.responseSchema?.items?.properties?.overlay;
    expect(overlay?.type).toBe("OBJECT");
    expect(overlay?.nullable).toBe(true); // the model may return null → no card
    expect(Object.keys(overlay?.properties ?? {}).sort()).toEqual(["subtitle", "title", "type"]);
    // The card is OPTIONAL — forcing it into `required` would coerce a card onto every beat.
    expect(gc.responseSchema?.items?.required).not.toContain("overlay");
    // The base 7 fields are untouched.
    expect(gc.responseSchema?.items?.required).toContain("visual_query");
  });

  it("retries a malformed body and returns the next attempt's plan", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url.match(/models\/([^:]+):generateContent/)?.[1] ?? "");
      return okResponse(seen.length === 1 ? geminiBody("{ this is not an array") : geminiBody(ARR(6)));
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await runWithFakeClock(() => requestPlanChunk("prompt", "run1", "key", ""));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["gemini-3.5-flash", "gemini-3.1-flash-lite"]); // retry advances the ladder
    expect(out).not.toBeNull(); // NOT lost to the keyword fallback
    expect(out).toHaveLength(6);
    expect(out?.[3].visual_query).toBe("query 3");
  });

  it("meters EVERY billed HTTP attempt, exactly once each", async () => {
    const fetchMock = vi.fn(async () => okResponse(geminiBody("{ broken")));
    // first call malformed, second good — both are HTTP 200s Google bills
    let n = 0;
    fetchMock.mockImplementation(async () => okResponse(++n === 1 ? geminiBody("{ broken") : geminiBody(ARR(2))));
    vi.stubGlobal("fetch", fetchMock);

    const out = await runWithFakeClock(() => requestPlanChunk("prompt", "run1", "key", ""));

    expect(out).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(meter.calls).toHaveLength(2); // NOT 1 (unmetered failure) and NOT 3 (double-count)
    expect(meter.calls.map((c) => c.model)).toEqual(["gemini-3.5-flash", "gemini-3.1-flash-lite"]);
    expect(meter.calls.every((c) => c.prompt === 100 && c.output === 200)).toBe(true);
  });

  it("meters the successful single-attempt case exactly once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(geminiBody(ARR(6)))));
    const out = await requestPlanChunk("prompt", "run1", "key", "");
    expect(out).toHaveLength(6);
    expect(meter.calls).toHaveLength(1);
  });

  it("falls back (returns null) only after every live model returned an unusable body", async () => {
    const fetchMock = vi.fn(async () => okResponse(geminiBody("total garbage, no array here")));
    vi.stubGlobal("fetch", fetchMock);

    const out = await runWithFakeClock(() => requestPlanChunk("prompt", "run1", "key", ""));

    expect(out).toBeNull(); // outer catch → keyword planner, still the final resort
    expect(fetchMock).toHaveBeenCalledTimes(2); // one per live ladder model
    expect(meter.calls).toHaveLength(2); // both wasted attempts were still billed → still metered
  });

  it("ignores THOUGHT parts when assembling the answer text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      okResponse({
        candidates: [{ content: { parts: [{ text: "Let me think about this...", thought: true }, { text: ARR(3) }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      })
    ));
    const out = await requestPlanChunk("prompt", "run1", "key", "");
    expect(out).toHaveLength(3);
    expect(meter.calls).toHaveLength(1);
  });
});

/**
 * normalizeOverlay — the fail-closed gate that turns a raw planner card (or its absence,
 * or garbage) into a validated Overlay or `undefined`. This is what enforces "no
 * hallucinated overlays": null / unknown-type / empty-title all collapse to no card.
 */
describe("normalizeOverlay", () => {
  it("accepts a well-formed card and trims it", () => {
    expect(normalizeOverlay({ type: "date", title: "  1969  " })).toEqual({ type: "date", title: "1969" });
    expect(normalizeOverlay({ type: "person", title: "Albert Einstein", subtitle: " Physicist " })).toEqual({
      type: "person",
      title: "Albert Einstein",
      subtitle: "Physicist",
    });
  });

  it("is case-insensitive on type and drops a blank subtitle", () => {
    expect(normalizeOverlay({ type: "SECTION", title: "Chapter 4", subtitle: "   " })).toEqual({
      type: "section",
      title: "Chapter 4",
    });
  });

  it("returns undefined for null, non-objects, unknown types, and missing/blank titles", () => {
    expect(normalizeOverlay(null)).toBeUndefined(); // the model's "no card"
    expect(normalizeOverlay(undefined)).toBeUndefined();
    expect(normalizeOverlay("date")).toBeUndefined();
    expect(normalizeOverlay({ type: "weather", title: "Sunny" })).toBeUndefined(); // not in the enum
    expect(normalizeOverlay({ type: "date" })).toBeUndefined(); // no title
    expect(normalizeOverlay({ type: "date", title: "   " })).toBeUndefined(); // blank title
    expect(normalizeOverlay({ title: "1969" })).toBeUndefined(); // no type
  });

  it("accepts every supported type", () => {
    for (const type of ["date", "title", "person", "fact", "quote", "section"] as const) {
      expect(normalizeOverlay({ type, title: "x" })).toEqual({ type, title: "x" });
    }
  });
});

/**
 * Stage 2 — structured-video intelligence. The heuristic classifier, the label formatter,
 * and the deterministic numbering pass that together turn model-marked item boundaries into
 * "#10" / "Fact #3" / "Chapter 4" overlays.
 */
describe("detectVideoStructure", () => {
  it("reads a Top-N countdown from the title (counts down, total known)", () => {
    expect(detectVideoStructure("Top 10 Ancient Wonders")).toEqual({ kind: "countdown", direction: "down", total: 10 });
    expect(detectVideoStructure("The 7 Biggest Space Mysteries")).toEqual({ kind: "countdown", direction: "down", total: 7 });
  });

  it("reads labeled lists (facts / tips / lessons / secrets / steps), counting up", () => {
    expect(detectVideoStructure("5 Facts About Sleep")).toEqual({ kind: "facts", direction: "up", total: 5 });
    expect(detectVideoStructure("8 Productivity Tips")).toEqual({ kind: "tips", direction: "up", total: 8 });
    expect(detectVideoStructure("3 Lessons from History")).toEqual({ kind: "lessons", direction: "up", total: 3 });
    expect(detectVideoStructure("6 Secrets of the Ocean")).toEqual({ kind: "secrets", direction: "up", total: 6 });
    expect(detectVideoStructure("4 Steps to a Better Morning")).toEqual({ kind: "steps", direction: "up", total: 4 });
  });

  it("detects a format even without a count, and chapters", () => {
    expect(detectVideoStructure("Amazing facts about the deep sea")).toEqual({ kind: "facts", direction: "up" });
    expect(detectVideoStructure("A story in chapters")).toEqual({ kind: "chapters", direction: "up" });
  });

  it("returns null for ordinary (non-list) videos", () => {
    expect(detectVideoStructure("The History of the Roman Empire")).toBeNull();
    expect(detectVideoStructure("How volcanoes erupt")).toBeNull();
    expect(detectVideoStructure("")).toBeNull();
  });
});

/**
 * Evidence path 2 — cue-based fallback. When the title/lead phrasing finds nothing, the narrator
 * actually counting ("Number five … four … three") should classify the video. Strict grammar keeps
 * false positives out. This is the fix for run ebf174d5 (Ancient5): "counting down five … wonders"
 * (spelled number + unrecognized label) misses phrasing, but the spoken cues are unmistakable.
 */
describe("detectVideoStructure — cue-based fallback (evidence path 2)", () => {
  // `label n` spoken at `at` ms, ~800ms long.
  const cue = (label: string, n: string, at: number): WordTiming[] => [w(label, at, at + 400), w(n, at + 400, at + 800)];
  // Three consecutive descending "Number" cues, well spread across a ~40s narration.
  const countdown = [w("today", 0, 400), ...cue("Number", "five", 6000), ...cue("Number", "four", 20000), ...cue("Number", "three", 34000), w("thanks", 39600, 40000)];

  it("classifies the Ancient5 case: spoken 'Number five/four/three' → countdown, source=cue", () => {
    // Title "Ancient5" matches no phrasing pattern (this is exactly why the run missed).
    expect(detectVideoStructure("Ancient5", countdown)).toEqual({ kind: "countdown", direction: "down", total: 5, source: "cue" });
  });

  it("infers an ASCENDING labeled list and the right kind from the label", () => {
    const facts = [w("intro", 0, 400), ...cue("fact", "one", 5000), ...cue("fact", "two", 18000), ...cue("fact", "three", 33000), w("end", 38000, 39000)];
    expect(detectVideoStructure("Amazing things about the sea", facts)).toEqual({ kind: "facts", direction: "up", total: 3, source: "cue" });
  });

  it("TITLE WINS — when phrasing already classifies, the cue path never runs (backward compatible)", () => {
    // Same cue words, but a recognizable title → the phrasing result (NO source field) is returned.
    expect(detectVideoStructure("Top 5 Wonders", countdown)).toEqual({ kind: "countdown", direction: "down", total: 5 });
  });

  it("does not run without word timings (phrasing-only, unchanged)", () => {
    expect(detectVideoStructure("The History of Rome")).toBeNull();
  });

  describe("false-positive guards each return null", () => {
    it("fewer than 3 cues", () => {
      const two = [w("a", 0, 400), ...cue("Number", "five", 6000), ...cue("Number", "four", 30000), w("z", 39600, 40000)];
      expect(detectVideoStructure("doc", two)).toBeNull();
    });
    it("inconsistent labels (number / fact / tip)", () => {
      const mixed = [w("a", 0, 400), ...cue("Number", "five", 6000), ...cue("fact", "four", 20000), ...cue("tip", "three", 34000), w("z", 39600, 40000)];
      const msgs: string[] = [];
      expect(detectVideoStructure("doc", mixed, (m) => msgs.push(m))).toBeNull();
      expect(msgs.some((m) => /inconsistent labels/.test(m))).toBe(true);
    });
    it("non-monotonic / gapped numbering", () => {
      const gapped = [w("a", 0, 400), ...cue("Number", "five", 6000), ...cue("Number", "three", 20000), ...cue("Number", "one", 34000), w("z", 39600, 40000)];
      expect(detectVideoStructure("doc", gapped)).toBeNull();
    });
    it("cues clustered into one sentence (not spread across the timeline)", () => {
      const clustered = [w("a", 0, 400), ...cue("Number", "five", 6000), ...cue("Number", "four", 6900), ...cue("Number", "three", 7800), w("z", 39600, 40000)];
      const msgs: string[] = [];
      expect(detectVideoStructure("doc", clustered, (m) => msgs.push(m))).toBeNull();
      expect(msgs.some((m) => /clustered/.test(m))).toBe(true);
    });
    it("ambiguous localization labels ('at') are NOT detection labels — 'at 3/4/5' is not a countdown", () => {
      const times = [w("a", 0, 400), ...cue("at", "three", 6000), ...cue("at", "four", 20000), ...cue("at", "five", 34000), w("z", 39600, 40000)];
      expect(detectVideoStructure("a day trip", times)).toBeNull();
    });
    it("constant (non-strict) numbering — 'number one' repeated is not a sequence", () => {
      const constant = [w("a", 0, 400), ...cue("Number", "one", 6000), ...cue("Number", "one", 20000), ...cue("Number", "one", 34000), w("z", 39600, 40000)];
      expect(detectVideoStructure("doc", constant)).toBeNull();
    });
  });
});

describe("detectVideoStructure — ordinal-sequence fallback (evidence path 3)", () => {
  // A ~40s ancient-sites tour narrated with discourse markers and NO spoken numbers / list title.
  // Each marker is sentence-initial by virtue of a long pause before it (the gap after the prior word).
  const seq: WordTiming[] = [
    w("today", 0, 400), w("we", 400, 800), w("explore", 800, 1400),
    w("First", 6000, 6400), w("Tikal", 6400, 7000),
    w("Next", 18000, 18400), w("Petra", 18400, 19000),
    w("Then", 28000, 28400), w("Pompeii", 28400, 29000),
    w("Finally", 36000, 36400), w("Machu", 36400, 37000),
    w("thanks", 39600, 40000),
  ];

  it("classifies the reported ancient-sites case: First … Next … Then … Finally → name-only sequence", () => {
    expect(detectVideoStructure("Ancient Wonders of the World", seq)).toEqual({
      kind: "sequence", direction: "up", total: 4, source: "cue",
    });
  });

  it("uses trailing punctuation as the sentence-boundary signal when there is no pause (Whisper strips it, ElevenLabs keeps it)", () => {
    const punct: WordTiming[] = [
      w("we", 0, 300), w("start.", 300, 700),
      w("First", 750, 1150), w("a", 1150, 1400), //  gap 50ms — only "start." makes this sentence-initial
      w("stop.", 14000, 14400), w("Next", 14450, 14850), w("b", 14850, 15100),
      w("done.", 30000, 30400), w("Finally", 30450, 30850), w("c", 30850, 31100),
      w("end", 39000, 40000),
    ];
    expect(detectVideoStructure("doc", punct)).toEqual({ kind: "sequence", direction: "up", total: 3, source: "cue" });
  });

  it("NUMERIC cues win over ordinal markers — a counted list stays a countdown, not a sequence", () => {
    const both: WordTiming[] = [
      w("today", 0, 400),
      w("First", 6000, 6400), w("number", 6400, 6800), w("five", 6800, 7200),
      w("Next", 20000, 20400), w("number", 20400, 20800), w("four", 20800, 21200),
      w("Finally", 34000, 34400), w("number", 34400, 34800), w("three", 34800, 35200),
      w("thanks", 39600, 40000),
    ];
    expect(detectVideoStructure("doc", both)).toEqual({ kind: "countdown", direction: "down", total: 5, source: "cue" });
  });

  it("a recognizable title still wins — the ordinal path never runs", () => {
    expect(detectVideoStructure("Top 5 Wonders", seq)).toEqual({ kind: "countdown", direction: "down", total: 5 });
  });

  describe("false-positive guards each return null (ordinary prose must not flip into list mode)", () => {
    const at = (word: string, ms: number): WordTiming => w(word, ms, ms + 400);
    it("fewer than 3 markers", () => {
      const two = [at("intro", 0), at("First", 6000), at("x", 6400), at("Finally", 30000), at("y", 30400), at("end", 40000)];
      expect(detectVideoStructure("doc", two)).toBeNull();
    });
    it("not bookended — a run that never ends on a closer", () => {
      const noClose = [at("intro", 0), at("First", 6000), at("Next", 18000), at("Then", 30000), at("end", 40000)];
      const msgs: string[] = [];
      expect(detectVideoStructure("doc", noClose, (m) => msgs.push(m))).toBeNull();
      expect(msgs.some((m) => /bookended/.test(m))).toBe(true);
    });
    it("no opener — a run that starts mid-sequence", () => {
      const noOpen = [at("intro", 0), at("Next", 6000), at("Then", 18000), at("Finally", 30000), at("end", 40000)];
      expect(detectVideoStructure("doc", noOpen)).toBeNull();
    });
    it("two closers — an ambiguous double-finale is not a clean list", () => {
      const twoClose = [at("intro", 0), at("First", 6000), at("Finally", 20000), at("Finally", 34000), at("end", 40000)];
      expect(detectVideoStructure("doc", twoClose)).toBeNull();
    });
    it("numeric ordinals out of order (First … Third … Second)", () => {
      const jumbled = [at("intro", 0), at("First", 6000), at("Third", 18000), at("Second", 30000), at("Finally", 36000), at("end", 40000)];
      const msgs: string[] = [];
      expect(detectVideoStructure("doc", jumbled, (m) => msgs.push(m))).toBeNull();
      expect(msgs.some((m) => /out of order/.test(m))).toBe(true);
    });
    it("markers clustered into one breath, not spread across the timeline", () => {
      const clustered = [at("intro", 0), at("First", 6000), at("Next", 6900), at("Finally", 7800), at("end", 40000)];
      const msgs: string[] = [];
      expect(detectVideoStructure("doc", clustered, (m) => msgs.push(m))).toBeNull();
      expect(msgs.some((m) => /clustered/.test(m))).toBe(true);
    });
    it("markers NOT at a sentence start (mid-sentence, no pause, no punctuation) are ignored", () => {
      // Contiguous words, no gaps, no punctuation → only word[0] is sentence-initial → <3 markers.
      const mid: WordTiming[] = [];
      const flow = "and first the next thing then another and finally that".split(" ");
      flow.forEach((word, i) => mid.push(w(word, i * 300, i * 300 + 300)));
      expect(detectVideoStructure("doc", mid)).toBeNull();
    });
  });
});

describe("detectVideoStructure — natural-prose boundary (documents the sentence-initial guard)", () => {
  // WHY the heuristic requires markers to be SENTENCE-INITIAL: ordinary narration is full of
  // "first"/"then"/"finally" used mid-sentence as plain vocabulary, not as list cues. Those must
  // NEVER flip a normal script into sequence mode. Each trigger below sits mid-clause (preceded by an
  // ordinary word, no pause, no sentence punctuation), so none is collected and the video stays null.

  it("mid-sentence 'first … then … finally' does NOT classify — even though it is bookended and well spread", () => {
    // This is the load-bearing case: opener→continuer→closer, spread across 34s of a 40s narration.
    // If the sentence-initial requirement were ever dropped, this WOULD wrongly classify as a sequence.
    // It returns null for exactly ONE reason — none of the three trigger words starts its sentence.
    const prose: WordTiming[] = [
      w("our", 0, 300), w("first", 300, 700), w("stop", 700, 1100), w("was", 1100, 1500),
      w("we", 12000, 12300), w("then", 12300, 12700), w("moved", 12700, 13200), w("on", 13200, 13600),
      w("we", 34000, 34300), w("were", 34300, 34700), w("finally", 34700, 35200), w("done", 35200, 35700),
      w("bye", 39600, 40000),
    ];
    expect(detectVideoStructure("A walk through town", prose)).toBeNull();
  });

  it("a natural sentence using 'first' and 'finally' as ordinary words stays unstructured", () => {
    // "When the first settlers arrived, they struggled for years before they finally built a home."
    const prose: WordTiming[] = [
      w("when", 0, 300), w("the", 300, 600), w("first", 600, 1000), w("settlers", 1000, 1600), w("arrived", 1600, 2200),
      w("they", 15000, 15300), w("struggled", 15300, 15900), w("for", 15900, 16200), w("years", 16200, 16800),
      w("before", 33000, 33400), w("they", 33400, 33700), w("finally", 33700, 34200), w("built", 34200, 34700), w("a", 34700, 34900), w("home", 34900, 35500),
    ];
    expect(detectVideoStructure("The story of a settlement", prose)).toBeNull();
  });
});

describe("ordinal sequence — split, intro region, and NAME-ONLY cards", () => {
  const seq: WordTiming[] = [
    w("today", 0, 400), w("we", 400, 800), w("explore", 800, 1400),
    w("First", 6000, 6400), w("Tikal", 6400, 7000),
    w("Next", 18000, 18400), w("Petra", 18400, 19000),
    w("Then", 28000, 28400), w("Pompeii", 28400, 29000),
    w("Finally", 36000, 36400), w("Machu", 36400, 37000),
    w("thanks", 39600, 40000),
  ];
  const structure = { kind: "sequence", direction: "up", total: 4, source: "cue" } as const;
  const beat = (index: number, startMs: number, endMs: number, overlay?: Beat["overlay"]): Beat =>
    ({ index, startMs, endMs, text: "x", layout: "broll", visualQuery: "x", source: "ai", ...(overlay ? { overlay } : {}) } as Beat);

  it("introRegionEndMs is the FIRST ordinal marker (so the intro is everything before 'First')", () => {
    expect(introRegionEndMs([{ endMs: 4000 }], seq, structure)).toBe(6000);
  });

  it("splitBeatsAtAnnouncements cuts one big beat at every ordinal marker — the reported fix", () => {
    // Before: one beat spans the intro AND the first item → the Tikal card lands during the intro.
    const out = splitBeatsAtAnnouncements([beat(0, 0, 40000)], seq, structure);
    expect(out.map((b) => b.startMs)).toEqual([0, 6000, 18000, 28000, 36000]);
  });

  it("numbering makes each item card NAME-ONLY (no rank chip) and drops the intro mark", () => {
    const beats = [
      beat(0, 0, 6000, { type: "section", title: "Welcome" }), // intro preview → dropped
      beat(1, 6000, 18000, { type: "section", title: "Tikal" }),
      beat(2, 18000, 28000, { type: "section", title: "Petra" }),
      beat(3, 28000, 36000, { type: "section", title: "Pompeii" }),
      beat(4, 36000, 40000, { type: "section", title: "Machu Picchu" }),
    ];
    numberStructuredOverlays(beats, structure, seq);
    expect(beats[0].overlay).toBeUndefined(); //                 intro mark dropped
    expect(beats[1].overlay).toEqual({ type: "section", title: "Tikal" }); // name only, no subtitle
    expect(beats[4].overlay).toEqual({ type: "section", title: "Machu Picchu" });
  });

  it("scheduleOverlays(sequenceMode) times each establishing card at its item beat start (the marker)", () => {
    const beats = [
      beat(1, 6000, 18000, { type: "section", title: "Tikal" }),
      beat(2, 18000, 28000, { type: "section", title: "Petra" }),
    ];
    const rank = numberStructuredOverlays(beats, structure, seq);
    scheduleOverlays(beats, seq, undefined, rank, true);
    expect(beats[0].overlayStartMs).toBe(6000);
    expect(beats[1].overlayStartMs).toBe(18000);
  });
});

describe("mergeShortSectionLeads — a sub-BEAT_MIN_SEC section-leading beat merges forward (same section only)", () => {
  const MIN = 3000; // BEAT_MIN_SEC = 3s
  const bt = (index: number, startMs: number, endMs: number, overlay?: Beat["overlay"]): Beat =>
    ({ index, startMs, endMs, text: `t${index}`, layout: "broll", visualQuery: "q", source: "ai", ...(overlay ? { overlay } : {}) } as Beat);

  it("Test 1 — a section-leading beat EXACTLY BEAT_MIN_SEC is NOT merged (count unchanged, card stays)", () => {
    const beats = [
      bt(0, 0, 10000), //                                        intro (not a section start)
      bt(1, 10000, 13000, { type: "section", title: "A" }), //   lead = exactly 3000ms
      bt(2, 13000, 20000), //                                    continuation
    ];
    const out = mergeShortSectionLeads(beats, [10000], MIN);
    expect(out).toHaveLength(3); //                              no merge — 3000 is not < 3000
    expect(out[1].startMs).toBe(10000);
    expect(out[1].endMs).toBe(13000);
    expect(out[1].overlay).toEqual({ type: "section", title: "A" }); // establishing card stays on the first beat
  });

  it("Test 2 — a short lead of a LONG section merges with only the next beat; the section still spans multiple beats", () => {
    const beats = [
      bt(0, 0, 10000), //                                        intro
      bt(1, 10000, 11000, { type: "section", title: "Pompeii" }), // lead = 1000ms (< MIN)
      bt(2, 11000, 17000), //                                    continuation 1 (6000ms)
      bt(3, 17000, 25000), //                                    continuation 2 (8000ms)
    ];
    const out = mergeShortSectionLeads(beats, [10000], MIN);
    expect(out).toHaveLength(3); //                              4 → 3: only the short lead was absorbed
    // merged first beat: starts at the section onset, absorbs ONLY continuation 1, and reaches ≥ MIN
    expect(out[1].startMs).toBe(10000);
    expect(out[1].endMs).toBe(17000);
    expect(out[1].text).toBe("t1 t2");
    expect(out[1].overlay).toEqual({ type: "section", title: "Pompeii" }); // card rides onto the merged beat
    // continuation 2 SURVIVES → the section is still multi-visual, not collapsed into one giant beat
    expect(out[2].startMs).toBe(17000);
    expect(out[2].endMs).toBe(25000);
    expect(out[2].overlay).toBeUndefined();
    expect(out.map((x) => x.index)).toEqual([0, 1, 2]); // renumbered contiguously
  });

  it("never merges across a section boundary — a whole-short section is left as-is", () => {
    const beats = [
      bt(0, 0, 6000), //                                         intro
      bt(1, 6000, 7000, { type: "section", title: "X" }), //     section X lead = 1000ms (short)
      bt(2, 7000, 12000, { type: "section", title: "Y" }), //    section Y starts here (a DIFFERENT section)
    ];
    const out = mergeShortSectionLeads(beats, [6000, 7000], MIN);
    expect(out).toHaveLength(3); //                              X is short but its next beat is a new section → no merge
    expect(out[1]).toMatchObject({ startMs: 6000, endMs: 7000, overlay: { type: "section", title: "X" } });
    expect(out[2]).toMatchObject({ startMs: 7000, overlay: { type: "section", title: "Y" } });
  });
});

describe("announcement fallback — a 'Top N' countdown narrated with ordinal markers (numeric stays primary)", () => {
  // The reported run: title "Top 5 …" → countdown, but the narration announces items with
  // "First … Next … Then … After that … Finally" and NEVER speaks the numbers. Numeric announcement
  // lookup finds nothing, so the splitter + intro detection fall back to the ordinal-marker scanner.
  const structure: VideoStructure = { kind: "countdown", direction: "down", total: 5, source: "title" };
  const bt = (index: number, startMs: number, endMs: number): Beat =>
    ({ index, startMs, endMs, text: "x", layout: "broll", visualQuery: "x", source: "ai" } as Beat);

  // intro ("exploring five cities" — the only number, and it has no cue label) + 5 ordinal items.
  const cd: WordTiming[] = [
    w("today", 0, 400), w("exploring", 400, 1000), w("five", 1000, 1400), w("cities", 1400, 2000),
    w("First", 6000, 6400), w("Tikal", 6400, 7000),
    w("Next", 16000, 16400), w("Petra", 16400, 17000),
    w("Then", 26000, 26400), w("Pompeii", 26400, 27000),
    w("After", 36000, 36400), w("that", 36400, 36800), w("Athens", 36800, 37400),
    w("Finally", 46000, 46400), w("Rome", 46400, 47000),
    w("thanks", 54000, 55000),
  ];

  it("splits the coarse beat at every ordinal marker when no number is spoken — the reported fix", () => {
    const out = splitBeatsAtAnnouncements([bt(0, 0, 55000)], cd, structure);
    // intro + Tikal + Petra + Pompeii + Athens + Rome = 6 beats.
    expect(out.map((b) => b.startMs)).toEqual([0, 6000, 16000, 26000, 36000, 46000]);
  });

  it("introRegionEndMs falls back to the first ordinal marker (Tikal is an item, not intro)", () => {
    expect(introRegionEndMs([{ endMs: 4000 }], cd, structure)).toBe(6000);
  });

  // Numeric spoken cues remain PRIMARY: when the narrator counts, the ordinal fallback never runs.
  const cdNum: WordTiming[] = [
    w("today", 0, 400),
    w("First", 3000, 3400), w("some", 3400, 3800), w("intro", 3800, 4200), // stray sentence-initial "First"
    w("number", 8000, 8400), w("five", 8400, 9000), w("Tikal", 9000, 9600),
    w("number", 22000, 22400), w("four", 22400, 23000), w("Petra", 23000, 23600),
    w("number", 36000, 36400), w("three", 36400, 37000), w("Pompeii", 37000, 37600),
    w("thanks", 39600, 40000),
  ];

  it("uses the SPOKEN NUMBERS when present and ignores a stray ordinal word (numeric primary)", () => {
    const out = splitBeatsAtAnnouncements([bt(0, 0, 40000)], cdNum, structure);
    expect(out.map((b) => b.startMs)).toEqual([0, 8000, 22000, 36000]); // at the numbers, NOT the stray "First" @3000
  });

  it("introRegionEndMs uses the first SPOKEN number, not the stray ordinal", () => {
    expect(introRegionEndMs([{ endMs: 4000 }], cdNum, structure)).toBe(8000);
  });

  it("no numbers AND no ordinal markers → no split (today's behavior, unchanged)", () => {
    const plain: WordTiming[] = [w("today", 0, 400), w("we", 6000, 6400), w("look", 26000, 26400), w("done", 50000, 55000)];
    const out = splitBeatsAtAnnouncements([bt(0, 0, 55000)], plain, structure);
    expect(out).toHaveLength(1);
  });
});

describe("overlayLabel", () => {
  it("formats the label per structure kind", () => {
    expect(overlayLabel({ kind: "countdown", direction: "down", total: 10 }, 10)).toBe("#10");
    expect(overlayLabel({ kind: "facts", direction: "up" }, 3)).toBe("Fact #3");
    expect(overlayLabel({ kind: "lessons", direction: "up" }, 2)).toBe("Lesson #2");
    expect(overlayLabel({ kind: "chapters", direction: "up" }, 4)).toBe("Chapter 4");
  });
});

describe("applyStructureNumbering", () => {
  const sectionBeat = (index: number, title: string, subtitle?: string): Beat =>
    ({ index, startMs: index * 1000, endMs: index * 1000 + 900, text: "x", layout: "broll", visualQuery: "x", source: "ai", overlay: { type: "section", title, ...(subtitle ? { subtitle } : {}) } } as Beat);
  const plainBeat = (index: number): Beat =>
    ({ index, startMs: index * 1000, endMs: index * 1000 + 900, text: "x", layout: "broll", visualQuery: "x", source: "ai" } as Beat);

  it("numbers a Top-10 countdown DOWN with the heading primary and the rank in the subtitle", () => {
    const beats = [plainBeat(0), sectionBeat(1, "The Great Wall"), plainBeat(2), sectionBeat(3, "Machu Picchu")];
    applyStructureNumbering(beats, { kind: "countdown", direction: "down", total: 10 });
    expect(beats[1].overlay).toEqual({ type: "section", title: "The Great Wall", subtitle: "#10" });
    expect(beats[3].overlay).toEqual({ type: "section", title: "Machu Picchu", subtitle: "#9" });
    expect(beats[0].overlay).toBeUndefined(); // non-section beats untouched
  });

  it("numbers a labeled list UP from 1 (heading primary, rank secondary)", () => {
    const beats = [sectionBeat(0, "Sleep cycles"), sectionBeat(1, "Caffeine")];
    applyStructureNumbering(beats, { kind: "facts", direction: "up" });
    expect(beats[0].overlay).toEqual({ type: "section", title: "Sleep cycles", subtitle: "Fact #1" });
    expect(beats[1].overlay).toEqual({ type: "section", title: "Caffeine", subtitle: "Fact #2" });
  });

  it("leaves non-section overlays (dates, names) completely alone", () => {
    const dateBeat = { index: 0, startMs: 0, endMs: 900, text: "x", layout: "broll", visualQuery: "x", source: "ai", overlay: { type: "date", title: "1969" } } as Beat;
    const beats = [dateBeat, sectionBeat(1, "Topic")];
    applyStructureNumbering(beats, { kind: "countdown", direction: "down", total: 5 } as VideoStructure);
    expect(beats[0].overlay).toEqual({ type: "date", title: "1969" }); // untouched
    expect(beats[1].overlay).toEqual({ type: "section", title: "Topic", subtitle: "#5" });
  });

  it("never numbers below 1 even if more sections than the declared total", () => {
    const beats = [sectionBeat(0, "a"), sectionBeat(1, "b"), sectionBeat(2, "c")];
    applyStructureNumbering(beats, { kind: "countdown", direction: "down", total: 2 });
    expect(beats.map((b) => b.overlay?.subtitle)).toEqual(["#2", "#1", "#1"]); // rank clamps at 1 (secondary field)
  });

  it("does NOT double-number when the model already numbered the title", () => {
    // Model returned its own numbers; ours are authoritative and must not stack.
    const beats = [sectionBeat(0, "#3"), sectionBeat(1, "Fact #2: Caffeine"), sectionBeat(2, "10. Sleep cycles")];
    applyStructureNumbering(beats, { kind: "facts", direction: "up" });
    expect(beats[0].overlay).toEqual({ type: "section", title: "Fact #1" }); // "#3" stripped → heading empty → rank-only card
    expect(beats[1].overlay).toEqual({ type: "section", title: "Caffeine", subtitle: "Fact #2" });
    expect(beats[2].overlay).toEqual({ type: "section", title: "Sleep cycles", subtitle: "Fact #3" });
  });
});

describe("stripLeadingNumbering", () => {
  it("removes model-added enumeration prefixes", () => {
    expect(stripLeadingNumbering("#10")).toBe("");
    expect(stripLeadingNumbering("Fact #3: Sleep cycles")).toBe("Sleep cycles");
    expect(stripLeadingNumbering("10. The Great Wall")).toBe("The Great Wall");
    expect(stripLeadingNumbering("Chapter 4")).toBe("");
    expect(stripLeadingNumbering("Tip 7 - Drink water")).toBe("Drink water");
    expect(stripLeadingNumbering("Lesson #2 Consistency")).toBe("Consistency");
  });

  it("leaves real content that merely STARTS with a number alone", () => {
    expect(stripLeadingNumbering("1943 discovery")).toBe("1943 discovery"); // no label, no punctuation
    expect(stripLeadingNumbering("3 Gorges Dam")).toBe("3 Gorges Dam");
    expect(stripLeadingNumbering("Sleep cycles")).toBe("Sleep cycles");
  });
});

/**
 * Stage 2.1 — narration-synchronized overlay scheduling. Overlays follow the SPOKEN voice
 * (word timings), not the visual-segment boundaries, so a ranking card appears exactly when the
 * voice says "Number five" and lasts a reading-time hold regardless of a 15 s / 25 s beat.
 */
const w = (word: string, startMs: number, endMs: number): WordTiming => ({ word, startMs, endMs });

describe("findItemCueMs", () => {
  it("starts at the label when narration says 'Number five'", () => {
    const words = [w("and", 21000, 21400), w("number", 22000, 22400), w("five", 22400, 22800), w("is", 22800, 23000)];
    expect(findItemCueMs(words, 5)).toBe(22000); // the "Number", not the "five"
  });

  it("matches ordinals and digits, and falls back to the bare number with no label", () => {
    expect(findItemCueMs([w("our", 10000, 10300), w("fifth", 10300, 10800)], 5)).toBe(10300); // "our" isn't a cue label
    expect(findItemCueMs([w("fact", 30000, 30400), w("4", 30400, 30700)], 4)).toBe(30000); // digit + label
  });

  it("returns null when the item number is never spoken in the beat", () => {
    expect(findItemCueMs([w("the", 1000, 1200), w("wall", 1200, 1600)], 7)).toBeNull();
  });
});

/**
 * Stage A — narration-event binding. Ranking cards are timed to the GLOBAL item announcement in the
 * word stream ("Number five"), never to a beat's word window, so their timing is a fact of the SPEECH
 * — invariant to beat length / Seconds-per-Footage / how the item is split into visuals.
 */
describe("locateItemAnnouncements", () => {
  it("locates each rank's announcement globally, in spoken order", () => {
    const words = [
      w("number", 5000, 5400), w("five", 5400, 5800), w("wall.", 5800, 6400),
      w("number", 12000, 12400), w("four", 12400, 12800), w("petra.", 12800, 13400),
    ];
    expect(locateItemAnnouncements(words, [5, 4])).toEqual([
      { rank: 5, atMs: 5000 }, { rank: 4, atMs: 12000 },
    ]);
  });

  it("requires a cue LABEL — a total ('top five') or an incidental number is NOT an announcement", () => {
    const words = [w("the", 1000, 1200), w("top", 1200, 1600), w("five", 1600, 2000), w("wonders", 2000, 2400)];
    expect(locateItemAnnouncements(words, [5])).toEqual([null]); // "top five" is a total, not the #5 cue
  });

  it("is SEQUENCE-anchored — a recap of an earlier number does not create a phantom announcement", () => {
    const words = [
      w("number", 5000, 5400), w("five", 5400, 5800),
      w("that", 9000, 9200), w("was", 9200, 9400), w("number", 9400, 9800), w("five.", 9800, 10200), // recap
      w("number", 12000, 12400), w("four", 12400, 12800),
    ];
    // rank 5 → the first "number five" (5000); rank 4 → 12000, never the recap.
    expect(locateItemAnnouncements(words, [5, 4])).toEqual([
      { rank: 5, atMs: 5000 }, { rank: 4, atMs: 12000 },
    ]);
  });

  it("returns null for an unannounced rank and aligns positionally (duplicate ranks handled)", () => {
    const words = [w("number", 5000, 5400), w("one", 5400, 5800), w("number", 9000, 9400), w("one", 9400, 9800)];
    expect(locateItemAnnouncements(words, [1, 1, 1])).toEqual([
      { rank: 1, atMs: 5000 }, { rank: 1, atMs: 9000 }, null, // third #1 never announced
    ]);
  });
});

describe("scheduleOverlays — Stage A narration-event binding", () => {
  const bA = (index: number, startMs: number, endMs: number, overlay?: Beat["overlay"]): Beat =>
    ({ index, startMs, endMs, text: "x", layout: "broll", visualQuery: "x", source: "ai", ...(overlay ? { overlay } : {}) } as Beat);

  it("times the ranking card to the ANNOUNCEMENT, not the beat start — regardless of the visual cut", () => {
    const words = [w("number", 5000, 5400), w("five", 5400, 5800), w("wall.", 5800, 6400)];
    const a = [bA(0, 3000, 20000, { type: "section", title: "#5" })]; // visual cut at 3s
    const b = [bA(0, 4000, 25000, { type: "section", title: "#5" })]; // visual cut at 4s, SAME words
    scheduleOverlays(a, words);
    scheduleOverlays(b, words);
    expect(a[0].overlayStartMs).toBe(5000); // the spoken announcement, not 3000
    expect(b[0].overlayStartMs).toBe(5000); // the spoken announcement, not 4000
  });

  it("finds the announcement even when it falls OUTSIDE the overlay beat's window (old drift bug)", () => {
    // The number is spoken at 5s, but the marked item beat's visual starts at 8s (the announcement
    // landed in the previous beat). The old beat-window scan missed it → drifted to 8s; now it binds
    // to the global 5s.
    const words = [w("number", 5000, 5400), w("five", 5400, 5800), w("wall.", 5800, 6400)];
    const beats = [bA(0, 8000, 20000, { type: "section", title: "#5" })];
    scheduleOverlays(beats, words);
    expect(beats[0].overlayStartMs).toBe(5000);
  });

  it("INVARIANT: identical narration → identical ranking windows at any Seconds-per-Footage", () => {
    const words = [
      w("number", 5000, 5400), w("five", 5400, 5800), w("wall.", 5800, 6400),
      w("number", 20000, 20400), w("four", 20400, 20800), w("petra.", 20800, 21400),
    ];
    // Two beat layouts for the SAME audio: short footage (10 beats) vs long footage (2 beats).
    const shortFootage: Beat[] = [
      bA(0, 3000, 8000, { type: "section", title: "#5" }),
      bA(1, 8000, 13000),
      bA(2, 13000, 18000, { type: "section", title: "#4" }),
      bA(3, 18000, 23000),
    ];
    const longFootage: Beat[] = [
      bA(0, 3000, 18000, { type: "section", title: "#5" }),
      bA(1, 18000, 40000, { type: "section", title: "#4" }),
    ];
    scheduleOverlays(shortFootage, words);
    scheduleOverlays(longFootage, words);
    const est = (beats: Beat[]) => beats.filter((b) => b.overlay).map((b) => [b.overlayStartMs, b.overlayEndMs]);
    expect(est(shortFootage)).toEqual([[5000, 7500], [20000, 22500]]);
    expect(est(longFootage)).toEqual([[5000, 7500], [20000, 22500]]); // byte-identical despite 5× fewer beats
  });
});

describe("scheduleOverlays", () => {
  const beat = (index: number, startMs: number, endMs: number, overlay?: Beat["overlay"]): Beat =>
    ({ index, startMs, endMs, text: "x", layout: "broll", visualQuery: "x", source: "ai", ...(overlay ? { overlay } : {}) } as Beat);

  it("syncs a ranking card to the spoken cue deep inside a long (25 s) beat — not the beat start", () => {
    // Beat runs 10s→35s; the voice says "number five" at 22s.
    const beats = [beat(0, 10000, 35000, { type: "section", title: "#5", subtitle: "The Great Wall" })];
    const words = [w("number", 22000, 22400), w("five", 22400, 22800)];
    scheduleOverlays(beats, words);
    expect(beats[0].overlayStartMs).toBe(22000); // the cue, NOT 10000
    // Lifetime is a reading-time hold (well under the 25 s visual), not the beat duration.
    expect(beats[0].overlayEndMs! - beats[0].overlayStartMs!).toBeLessThanOrEqual(6000);
    expect(beats[0].overlayEndMs).toBeLessThan(35000);
  });

  it("gives a non-ranking card a beat-start + reading-hold window (decoupled from beat length)", () => {
    const beats = [beat(0, 5000, 30000, { type: "date", title: "1969" })];
    scheduleOverlays(beats, []);
    expect(beats[0].overlayStartMs).toBe(5000);
    expect(beats[0].overlayEndMs).toBeLessThan(30000); // not the full 25 s beat
    expect(beats[0].overlayEndMs! - 5000).toBeGreaterThanOrEqual(2500); // minimum readable hold
  });

  it("never lets a card overrun into the next card's beat", () => {
    const beats = [
      beat(0, 10000, 20000, { type: "section", title: "#5" }),
      beat(1, 20000, 40000, { type: "section", title: "#4" }),
    ];
    const words = [w("number", 18500, 18900), w("five", 18900, 19300)]; // cue late in beat 0
    scheduleOverlays(beats, words);
    expect(beats[0].overlayEndMs).toBeLessThanOrEqual(20000); // clamped to beat 1's start
  });

  it("is deterministic — identical input yields identical windows (Resume-safe)", () => {
    const mk = () => [beat(0, 0, 8000, { type: "section", title: "#3", subtitle: "Topic" })];
    const words = [w("number", 3000, 3400), w("three", 3400, 3800)];
    const a = mk(); scheduleOverlays(a, words);
    const b = mk(); scheduleOverlays(b, words);
    expect(a[0].overlayStartMs).toBe(b[0].overlayStartMs);
    expect(a[0].overlayEndMs).toBe(b[0].overlayEndMs);
    expect(a[0].overlayStartMs).toBe(3000);
  });

  it("leaves beats without an overlay untouched", () => {
    const beats = [beat(0, 0, 5000)];
    scheduleOverlays(beats, []);
    expect(beats[0].overlayStartMs).toBeUndefined();
    expect(beats[0].overlayEndMs).toBeUndefined();
  });

  it("ends the card at the SENTENCE boundary when punctuation is present", () => {
    // Card starts at 0; the sentence it labels ends on "amazing." at 4600ms.
    const beats = [beat(0, 0, 20000, { type: "section", title: "#3", subtitle: "The Wall" })];
    const words = [w("number", 0, 400), w("three", 400, 800), w("is", 3800, 4000), w("amazing.", 4000, 4600), w("next", 5000, 5400)];
    scheduleOverlays(beats, words);
    expect(beats[0].overlayStartMs).toBe(0);
    expect(beats[0].overlayEndMs).toBe(4600); // aligned to "amazing.", not a fixed hold
  });

  it("clamps a very long sentence to the max lifetime", () => {
    const beats = [beat(0, 0, 40000, { type: "date", title: "1969" })];
    const words = [w("the", 0, 300), w("end.", 30000, 30400)]; // sentence ends at 30.4s
    scheduleOverlays(beats, words);
    expect(beats[0].overlayEndMs).toBe(6000); // capped at OVERLAY_HOLD_MAX_MS from start
  });

  it("extends a too-short sentence up to the minimum lifetime", () => {
    const beats = [beat(0, 0, 20000, { type: "date", title: "1969" })];
    const words = [w("hi.", 0, 400)]; // sentence ends at 400ms — far below the min
    scheduleOverlays(beats, words);
    expect(beats[0].overlayEndMs).toBe(2500); // lifted to OVERLAY_HOLD_MIN_MS
  });
});

/**
 * Bugs 1–3 regression — the FULL structured-overlay contract, end to end:
 *   Bug 1: the intro never shows a ranking overlay; the first countdown card appears only at the
 *          spoken cue ("Number five"), never during the introductory sentence.
 *   Bug 2: every number stays permanently attached to its section — section 1 = #5, section 2 = #4…
 *   Bug 3: numbering runs as ONE pass before scheduling, and is duration-independent.
 * It exercises numberStructuredOverlays() (intro guards + numbering) then scheduleOverlays(), the
 * exact order planBeats() runs them in.
 */
describe("structured overlays — intro suppression + numbering + scheduling (Bugs 1–3)", () => {
  const bt = (index: number, startMs: number, endMs: number, overlay?: Beat["overlay"], layout: Beat["layout"] = "broll"): Beat =>
    ({ index, startMs, endMs, text: `beat ${index}`, layout, visualQuery: "x", source: "ai", ...(overlay ? { overlay } : {}) } as Beat);
  const sec = (title: string, subtitle?: string): Beat["overlay"] => ({ type: "section", title, ...(subtitle ? { subtitle } : {}) });
  const CUE = ["five", "four", "three", "two", "one"]; // spoken number for item #5…#1

  /**
   * A Top-5 countdown: 5 item beats each `durMs` long, each announced "number <five…one>" 2 s in.
   * Optionally prefixed by an avatar hook (a stray `section` mark on beat 0) and/or an intro PREVIEW
   * beat that only says "the top five" (a total, not the "#5" cue). Same items, any `durMs`.
   */
  function countdown(durMs: number, opts: { hook?: boolean; preview?: boolean } = {}) {
    const beats: Beat[] = [];
    const words: WordTiming[] = [];
    let t = 0;
    if (opts.hook) {
      beats.push(bt(beats.length, t, t + 3000, sec("Hook"), "avatar"));
      words.push(w("welcome", t + 500, t + 1000));
      t += 3000;
    }
    if (opts.preview) {
      beats.push(bt(beats.length, t, t + 4000, sec("Preview")));
      words.push(w("the", t + 200, t + 400), w("top", t + 400, t + 800), w("five", t + 800, t + 1200), w("tips", t + 1200, t + 1600));
      t += 4000;
    }
    const firstItemStart = t;
    for (let k = 0; k < 5; k++) {
      const s = t;
      beats.push(bt(beats.length, s, s + durMs, sec(`Topic ${k}`)));
      words.push(w("number", s + 2000, s + 2400), w(CUE[k], s + 2400, s + 2800), w("matters.", s + 2800, s + 3400));
      t += durMs;
    }
    return { beats, words, firstItemStart };
  }

  // Stage 0: the rank LABEL is now the SECONDARY field (subtitle); the item heading is the title.
  const labels = (beats: Beat[]) => beats.map((b) => b.overlay?.subtitle);

  it("Bug 1+2: drops the intro hook's ranking mark and numbers section 1..5 as #5..#1", () => {
    const { beats, words } = countdown(6000, { hook: true });
    numberStructuredOverlays(beats, { kind: "countdown", direction: "down", total: 5 }, words);
    expect(beats[0].overlay).toBeUndefined(); // hook is never a ranked item
    expect(labels(beats.slice(1))).toEqual(["#5", "#4", "#3", "#2", "#1"]);
  });

  it("Bug 3: numbering is IDENTICAL regardless of beat duration (6 s vs 25 s items)", () => {
    const short = countdown(6000, { hook: true });
    const long = countdown(25000, { hook: true });
    const S: VideoStructure = { kind: "countdown", direction: "down", total: 5 };
    numberStructuredOverlays(short.beats, S, short.words);
    numberStructuredOverlays(long.beats, S, long.words);
    expect(labels(short.beats)).toEqual(labels(long.beats));
    expect(labels(long.beats)).toEqual([undefined, "#5", "#4", "#3", "#2", "#1"]);
  });

  it("Bug 1+2: Guard 2 drops an intro PREVIEW ('the top five') even when it is NOT beat 0 — #5 stays free", () => {
    // beat 0 = avatar hook (no overlay → Guard 1 is a no-op); beat 1 = a preview that says the TOTAL
    // ("the top five"), never the "#5" cue; beats 2.. = the real items. Only Guard 2 can catch beat 1.
    const beats: Beat[] = [
      bt(0, 0, 3000, undefined, "avatar"),
      bt(1, 3000, 7000, sec("Preview")),
      bt(2, 7000, 13000, sec("Topic 0")),
      bt(3, 13000, 19000, sec("Topic 1")),
      bt(4, 19000, 25000, sec("Topic 2")),
    ];
    const words: WordTiming[] = [
      w("the", 3200, 3400), w("top", 3400, 3800), w("five", 3800, 4200), w("tips", 4200, 4600), // total, no cue label
      w("number", 9000, 9400), w("five", 9400, 9800), // beat 2 announces #5
      w("number", 15000, 15400), w("four", 15400, 15800),
      w("number", 21000, 21400), w("three", 21400, 21800),
    ];
    const rankByIndex = numberStructuredOverlays(beats, { kind: "countdown", direction: "down", total: 5 }, words);
    expect(beats[1].overlay).toBeUndefined(); // preview suppressed — did NOT steal #5
    expect(beats.slice(2).map((b) => b.overlay?.subtitle)).toEqual(["#5", "#4", "#3"]); // rank in the secondary field
    expect(beats.slice(2).map((b) => rankByIndex.get(b.index))).toEqual([5, 4, 3]); // transient rank map for the scheduler
  });

  it("Bug 1: after numbering, the first card (#5) starts at the spoken cue — never during the intro", () => {
    const { beats, words, firstItemStart } = countdown(10000, { hook: true });
    const S: VideoStructure = { kind: "countdown", direction: "down", total: 5 };
    const rankByIndex = numberStructuredOverlays(beats, S, words);
    scheduleOverlays(beats, words, undefined, rankByIndex); // MUST run after numbering; pass the rank map
    const firstCard = beats.find((b) => b.overlay?.subtitle === "#5")!;
    expect(firstCard.overlayStartMs).toBe(firstItemStart + 2000); // the "number five" cue, not the beat start
    expect(firstCard.overlayStartMs).toBeGreaterThan(firstItemStart); // strictly after the visual cut
    // No ranking card is ever visible during the introductory region (before the first item begins).
    const rankingCards = beats.filter((b) => /^#\d/.test(b.overlay?.subtitle ?? ""));
    for (const c of rankingCards) expect(c.overlayStartMs!).toBeGreaterThanOrEqual(firstItemStart);
  });

  it("Bug 2: each number stays attached to its own section — heading + rank match on-screen order exactly", () => {
    const { beats, words } = countdown(8000, { hook: true });
    numberStructuredOverlays(beats, { kind: "countdown", direction: "down", total: 5 }, words);
    // Section headings (title) stay paired with their own rank (subtitle) — no drift between number and content.
    expect(beats.slice(1).map((b) => [b.overlay?.title, b.overlay?.subtitle])).toEqual([
      ["Topic 0", "#5"], ["Topic 1", "#4"], ["Topic 2", "#3"], ["Topic 3", "#2"], ["Topic 4", "#1"],
    ]);
  });

  it("counts a labeled list UP (Fact #1, #2, …) with the same intro guarantees", () => {
    const beats: Beat[] = [
      bt(0, 0, 3000, sec("Hook"), "avatar"),
      bt(1, 3000, 9000, sec("Sleep cycles")),
      bt(2, 9000, 15000, sec("Caffeine")),
      bt(3, 15000, 21000, sec("REM")),
    ];
    numberStructuredOverlays(beats, { kind: "facts", direction: "up" }, []);
    expect(beats[0].overlay).toBeUndefined();
    expect(labels(beats.slice(1))).toEqual(["Fact #1", "Fact #2", "Fact #3"]);
  });

  /**
   * Stage 1 — the establishing card is GUARANTEED. In a structured countdown the code, not the LLM,
   * owns the first (and, for now, only) overlay of every item: it is ALWAYS the ranking + title.
   * A date / fact / person / quote the model chose can never stand in as an item's first card — it
   * is dropped here (it becomes a SUPPORTING role in Stage 2).
   */
  describe("Stage 1 — guaranteed establishing card", () => {
    const S: VideoStructure = { kind: "countdown", direction: "down", total: 5 };

    it("drops a model-chosen date/fact so the establishing card is ALWAYS heading + rank", () => {
      const beats: Beat[] = [
        bt(0, 0, 3000, sec("Hook"), "avatar"),        // intro hook → dropped
        bt(1, 3000, 9000, sec("The Great Wall")),     // item → heading + #5
        bt(2, 9000, 12000, { type: "date", title: "700 BC" }),        // model chose a DATE → dropped
        bt(3, 12000, 18000, sec("Petra")),            // item → heading + #4
        bt(4, 18000, 21000, { type: "fact", title: "Carved from solid rock" }), // FACT → dropped
        bt(5, 21000, 27000, sec("Machu Picchu")),     // item → heading + #3
      ];
      numberStructuredOverlays(beats, S, []);
      expect(beats[0].overlay).toBeUndefined();
      expect(beats[1].overlay).toEqual({ type: "section", title: "The Great Wall", subtitle: "#5" });
      expect(beats[2].overlay).toBeUndefined(); // date can't be an establishing card
      expect(beats[3].overlay).toEqual({ type: "section", title: "Petra", subtitle: "#4" });
      expect(beats[4].overlay).toBeUndefined(); // fact can't be an establishing card
      expect(beats[5].overlay).toEqual({ type: "section", title: "Machu Picchu", subtitle: "#3" });
    });

    it("EVERY surviving overlay in a structured video is a ranking establishing card", () => {
      const beats: Beat[] = [
        bt(0, 0, 3000, sec("A")),                                 // beat 0 = intro → dropped
        bt(1, 3000, 9000, { type: "person", title: "Qin Shi Huang" }), // person → dropped
        bt(2, 9000, 15000, sec("The Great Wall")),                // item → #5
        bt(3, 15000, 21000, { type: "quote", title: "'Wonders'" }),    // quote → dropped
        bt(4, 21000, 27000, sec("Petra")),                        // item → #4
      ];
      numberStructuredOverlays(beats, S, []);
      const survivors = beats.filter((b) => b.overlay);
      expect(survivors.every((b) => b.overlay!.type === "section")).toBe(true);
      expect(survivors.every((b) => /^#\d+$/.test(b.overlay!.subtitle ?? ""))).toBe(true); // rank in secondary field
      expect(survivors.map((b) => b.overlay!.title)).toEqual(["The Great Wall", "Petra"]); // heading is primary
      expect(survivors.map((b) => b.overlay!.subtitle)).toEqual(["#5", "#4"]);
    });

    it("is deterministic — a second identical pass yields the identical overlays (Resume-safe)", () => {
      const mk = (): Beat[] => [
        bt(0, 0, 3000, sec("Hook"), "avatar"),
        bt(1, 3000, 9000, sec("Wall")),
        bt(2, 9000, 12000, { type: "date", title: "700 BC" }),
        bt(3, 12000, 18000, sec("Petra")),
      ];
      const a = mk(); numberStructuredOverlays(a, S, []);
      const b = mk(); numberStructuredOverlays(b, S, []);
      expect(a.map((x) => x.overlay)).toEqual(b.map((x) => x.overlay));
      expect(a.map((x) => x.overlay?.subtitle)).toEqual([undefined, "#5", undefined, "#4"]);
    });

    it("keeps the item NAME the model supplied as the establishing card's HEADING (title)", () => {
      // The LLM decides the item name; the code puts it in `title` and the rank in `subtitle`.
      const beats: Beat[] = [bt(0, 0, 3000, undefined, "avatar"), bt(1, 3000, 9000, sec("The Colosseum"))];
      numberStructuredOverlays(beats, S, []);
      expect(beats[1].overlay).toEqual({ type: "section", title: "The Colosseum", subtitle: "#5" });
    });
  });

  /**
   * Stage 2 — the optional SUPPORTING card. The model supplies one short fact as the item's
   * `subtitle`; the code splits it out into `b.supporting` (content) and scheduleOverlays() times it
   * AFTER the establishing card + a breathing gap, anchored to the next narrated sentence.
   */
  describe("Stage 2 — supporting overlay (content split)", () => {
    const S: VideoStructure = { kind: "countdown", direction: "down", total: 5 };

    it("splits the model's subtitle into a supporting FACT card; establishing card = heading + rank", () => {
      const beats: Beat[] = [
        bt(0, 0, 3000, undefined, "avatar"),
        bt(1, 3000, 30000, { type: "section", title: "The Great Wall", subtitle: "21,000 km long" }),
      ];
      numberStructuredOverlays(beats, S, []);
      expect(beats[1].overlay).toEqual({ type: "section", title: "The Great Wall", subtitle: "#5" });
      // Stage B UX: the fact is the title; the item NAME rides along as a subtle secondary label.
      expect(beats[1].supporting).toEqual({ type: "fact", title: "21,000 km long", subtitle: "The Great Wall" });
    });

    it("adds NO supporting card when the model gave no fact (no subtitle)", () => {
      const beats: Beat[] = [bt(0, 0, 3000, undefined, "avatar"), bt(1, 3000, 30000, sec("The Great Wall"))];
      numberStructuredOverlays(beats, S, []);
      expect(beats[1].supporting).toBeUndefined();
    });

    it("adds NO supporting card when the 'fact' is just the item name repeated (dedup)", () => {
      const beats: Beat[] = [
        bt(0, 0, 3000, undefined, "avatar"),
        bt(1, 3000, 30000, { type: "section", title: "The Great Wall", subtitle: "the great wall" }),
      ];
      numberStructuredOverlays(beats, S, []);
      expect(beats[1].supporting).toBeUndefined();
    });
  });

  describe("Stage 2 — supporting overlay (timing)", () => {
    const S: VideoStructure = { kind: "countdown", direction: "down", total: 5 };
    // One long item beat, narration = an establishing sentence ("… great wall.") then, after a pause,
    // an elaborating sentence ("It is 21,000 kilometres long.").
    const itemWords: WordTiming[] = [
      w("number", 5000, 5400), w("five", 5400, 5800), w("the", 5800, 6100), w("great", 6100, 6400), w("wall.", 6400, 6900),
      w("it", 9000, 9200), w("is", 9200, 9400), w("21,000", 9400, 9900), w("kilometres", 9900, 10200), w("long.", 10200, 10800),
    ];
    const mkBeats = (): Beat[] => [
      bt(0, 0, 3000, undefined, "avatar"),
      bt(1, 3000, 30000, { type: "section", title: "The Great Wall", subtitle: "21,000 km long" }),
    ];

    it("appears AFTER the establishing card + a breathing gap, anchored to the next spoken sentence", () => {
      const beats = mkBeats();
      const rankByIndex = numberStructuredOverlays(beats, S, itemWords);
      scheduleOverlays(beats, itemWords, undefined, rankByIndex);
      const b = beats[1];
      expect(b.overlayStartMs).toBe(5000); // establishing at the "number five" cue
      expect(b.supportingStartMs).toBe(9000); // the start of the NEXT sentence ("It is …")
      // Breathing gap: the supporting card never appears back-to-back with the establishing card.
      expect(b.supportingStartMs! - b.overlayEndMs!).toBeGreaterThanOrEqual(1500);
      expect(b.supportingEndMs!).toBeGreaterThan(b.supportingStartMs!);
      expect(b.supportingStartMs!).toBeGreaterThan(b.overlayEndMs!); // never overlaps the establishing card
    });

    it("skips the supporting card when there is no sentence boundary to anchor to (fail-open)", () => {
      // Same fact, but the narration carries no punctuation → no natural continuation point.
      const noPunct: WordTiming[] = [
        w("number", 5000, 5400), w("five", 5400, 5800), w("great", 5800, 6400), w("wall", 6400, 6900),
        w("it", 9000, 9200), w("is", 9200, 9400), w("long", 9400, 10800),
      ];
      const beats = mkBeats();
      const rankByIndex = numberStructuredOverlays(beats, S, noPunct);
      scheduleOverlays(beats, noPunct, undefined, rankByIndex);
      expect(beats[1].supporting).toBeDefined();          // content is attached
      expect(beats[1].supportingStartMs).toBeUndefined(); // …but no window was scheduled
    });

    it("skips the supporting card when the next item leaves no room (no card spam)", () => {
      // Two items back-to-back: item #5's fact would collide with item #4's establishing cue.
      const words: WordTiming[] = [
        w("number", 5000, 5400), w("five", 5400, 5800), w("wall.", 5800, 6400),
        w("number", 7000, 7400), w("four", 7400, 7800), w("petra.", 7800, 8400), // #4 starts almost immediately
      ];
      const beats: Beat[] = [
        bt(0, 0, 3000, undefined, "avatar"),
        bt(1, 3000, 7000, { type: "section", title: "The Great Wall", subtitle: "21,000 km long" }),
        bt(2, 7000, 12000, sec("Petra")),
      ];
      numberStructuredOverlays(beats, S, words);
      scheduleOverlays(beats, words);
      expect(beats[1].supportingStartMs).toBeUndefined(); // no room before #4 → skipped
    });

    it("is deterministic — identical input yields identical supporting windows (Resume-safe)", () => {
      const a = mkBeats(); numberStructuredOverlays(a, S, itemWords); scheduleOverlays(a, itemWords);
      const b = mkBeats(); numberStructuredOverlays(b, S, itemWords); scheduleOverlays(b, itemWords);
      expect(a[1].supportingStartMs).toBe(b[1].supportingStartMs);
      expect(a[1].supportingEndMs).toBe(b[1].supportingEndMs);
    });
  });
});

/**
 * Stage B — the supporting card is a first-class narration event (FactSpoken), exactly like the
 * ranking card became in Stage A. It is timed to when the narrator BEGINS delivering the fact — not
 * to the establishing card's lifetime, an artificial gap, or any beat.
 */
describe("locateFactSpoken", () => {
  it("anchors to the sentence that delivers a NUMBER/date fact, tolerant of wording differences", () => {
    // Fact card text "21,000 km long" vs narration "It stretches for more than 21,000 kilometres."
    const words = [
      w("it", 9000, 9200), w("stretches", 9200, 9600), w("for", 9600, 9800), w("more", 9800, 10000),
      w("than", 10000, 10200), w("21,000", 10200, 10800), w("kilometres.", 10800, 11400),
    ];
    // atMs is the START of the sentence ("It …"), not the number itself.
    expect(locateFactSpoken(words, "21,000 km long", 0, 20000)).toEqual({ atMs: 9000 });
  });

  it("anchors a NO-number fact only on a cluster of ≥2 content words (single word ≠ match)", () => {
    const words = [
      w("this", 3000, 3200), w("is", 3200, 3400), w("a", 3400, 3500), w("unesco", 3500, 4000),
      w("world", 4000, 4400), w("heritage", 4400, 4900), w("site.", 4900, 5400),
    ];
    expect(locateFactSpoken(words, "UNESCO World Heritage Site", 0, 20000)).toEqual({ atMs: 3000 });
    // A single incidental content word is not enough to fire.
    expect(locateFactSpoken([w("the", 0, 200), w("site", 200, 600)], "UNESCO World Heritage Site", 0, 20000)).toBeNull();
  });

  it("searches ONLY inside the given span — a fact spoken in the next item is not matched", () => {
    const words = [w("built", 100, 400), w("in", 400, 600), w("1372.", 600, 1200)];
    expect(locateFactSpoken(words, "Built in 1372", 0, 100)).toBeNull(); // span ends before the fact
    expect(locateFactSpoken(words, "Built in 1372", 0, 2000)).toEqual({ atMs: 100 });
  });

  it("returns null when the fact is never spoken (→ no supporting card)", () => {
    const words = [w("a", 0, 200), w("different", 200, 600), w("sentence.", 600, 1200)];
    expect(locateFactSpoken(words, "42 metres tall", 0, 20000)).toBeNull();
  });
});

describe("scheduleOverlays — Stage B supporting = FactSpoken event", () => {
  const bB = (index: number, startMs: number, endMs: number, overlay?: Beat["overlay"], supporting?: Beat["supporting"]): Beat =>
    ({ index, startMs, endMs, text: "x", layout: "broll", visualQuery: "x", source: "ai", ...(overlay ? { overlay } : {}), ...(supporting ? { supporting } : {}) } as Beat);

  // #5 announced at 5s ("Number five, the Great Wall."), fact spoken at 12s ("It runs 21,000 km.").
  const words: WordTiming[] = [
    w("number", 5000, 5400), w("five", 5400, 5800), w("the", 5800, 6100), w("great", 6100, 6400), w("wall.", 6400, 6900),
    w("it", 12000, 12200), w("runs", 12200, 12600), w("21,000", 12600, 13200), w("km.", 13200, 13800),
    w("number", 30000, 30400), w("four", 30400, 30800), w("petra.", 30800, 31400),
  ];
  const mk = (): Beat[] => [
    bB(0, 0, 3000, undefined),
    bB(1, 3000, 28000, { type: "section", title: "#5", subtitle: "The Great Wall" }, { type: "fact", title: "21,000 km", subtitle: "The Great Wall" }),
    bB(2, 28000, 40000, { type: "section", title: "#4", subtitle: "Petra" }),
  ];

  it("schedules the supporting card FROM FactSpoken (12s), NOT from the establishing card's lifetime", () => {
    const beats = mk();
    scheduleOverlays(beats, words);
    const b = beats[1];
    expect(b.overlayStartMs).toBe(5000);      // ranking at the announcement
    expect(b.supportingStartMs).toBe(12000);  // supporting at the FACT's sentence start — a 6s gap after the ranking's window
    expect(b.supportingStartMs!).toBeGreaterThan(b.overlayEndMs!); // no collision with the establishing card
  });

  it("INVARIANT: supporting timestamps do not change with Seconds-per-Footage (beat layout)", () => {
    // Same audio, different footage segmentation of item #5 (1 long beat vs 3 short beats).
    const longFootage = mk();
    const shortFootage: Beat[] = [
      bB(0, 0, 3000, undefined),
      bB(1, 3000, 13000, { type: "section", title: "#5", subtitle: "The Great Wall" }, { type: "fact", title: "21,000 km", subtitle: "The Great Wall" }),
      bB(2, 13000, 20000),
      bB(3, 20000, 28000),
      bB(4, 28000, 40000, { type: "section", title: "#4", subtitle: "Petra" }),
    ];
    scheduleOverlays(longFootage, words);
    scheduleOverlays(shortFootage, words);
    expect(shortFootage[1].supportingStartMs).toBe(longFootage[1].supportingStartMs);
    expect(shortFootage[1].supportingEndMs).toBe(longFootage[1].supportingEndMs);
    expect(longFootage[1].supportingStartMs).toBe(12000);
  });

  it("never lets the supporting card cross into the next item", () => {
    // Fact spoken very late in item #5, right before #4 is announced.
    const late: WordTiming[] = [
      w("number", 5000, 5400), w("five", 5400, 5800), w("wall.", 5800, 6400),
      w("it", 9000, 9200), w("runs", 9200, 9600), w("21,000", 9600, 10200), w("km.", 10200, 11800),
      w("number", 12000, 12400), w("four", 12400, 12800), w("petra.", 12800, 13400), // #4 at 12s
    ];
    const beats = mk();
    scheduleOverlays(beats, late);
    const b = beats[1];
    if (b.supportingStartMs != null) {
      expect(b.supportingEndMs!).toBeLessThanOrEqual(12000); // clamped to #4's announcement
    }
  });

  it("is deterministic — identical input yields identical supporting windows (Resume-safe)", () => {
    const a = mk(); scheduleOverlays(a, words);
    const b = mk(); scheduleOverlays(b, words);
    expect(a[1].supportingStartMs).toBe(b[1].supportingStartMs);
    expect(a[1].supportingEndMs).toBe(b[1].supportingEndMs);
  });

  it("keeps the item NAME on the supporting card as a subtle secondary label (re-anchoring)", () => {
    const beats = mk();
    scheduleOverlays(beats, words);
    expect(beats[1].supporting).toMatchObject({ type: "fact", title: "21,000 km", subtitle: "The Great Wall" });
  });

  it("skips the supporting card (and logs a debug line) when the fact is spoken INSIDE the establishing window", () => {
    // Degenerate script: the number AND the fact are in one breath ("Number five, the Great Wall,
    // which runs 21,000 km."), so the fact's sentence == the announcement sentence → it would stack
    // on the establishing card. The collision guard skips it and reports why.
    const oneBreath: WordTiming[] = [
      w("number", 5000, 5400), w("five", 5400, 5800), w("the", 5800, 6100), w("great", 6100, 6400),
      w("wall", 6400, 6800), w("which", 6800, 7100), w("runs", 7100, 7400), w("21,000", 7400, 8000), w("km.", 8000, 8600),
      w("number", 20000, 20400), w("four", 20400, 20800), w("petra.", 20800, 21400),
    ];
    const beats = mk();
    const debug: string[] = [];
    scheduleOverlays(beats, oneBreath, (m) => debug.push(m));
    expect(beats[1].supportingStartMs).toBeUndefined(); // not scheduled
    expect(debug.some((m) => /overlaps the establishing card/.test(m))).toBe(true);
  });

  it("does NOT log a collision when the supporting card is normally scheduled", () => {
    const beats = mk();
    const debug: string[] = [];
    scheduleOverlays(beats, words, (m) => debug.push(m)); // `words`: fact at 12s, well clear of the card
    expect(beats[1].supportingStartMs).toBe(12000);
    expect(debug).toEqual([]); // no collision skip
  });

  it("introduces NO AI/network call — overlay scheduling is pure and offline", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const beats = mk();
      numberStructuredOverlays(beats, { kind: "countdown", direction: "down", total: 5 }, words);
      scheduleOverlays(beats, words);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Stage C — the explicit INTRO REGION [0, introRegionEndMs) replaces the old Guard 1 / Guard 2
 * heuristics. Its end is a narration event (the first ItemAnnouncement). No ranking or supporting
 * overlay may ever live before it; the first ranked item begins exactly at that announcement.
 */
describe("introRegionEndMs", () => {
  const S: VideoStructure = { kind: "countdown", direction: "down", total: 5 };
  const bt = (index: number, startMs: number, endMs: number, layout: Beat["layout"] = "broll"): Beat =>
    ({ index, startMs, endMs, text: "x", layout, visualQuery: "x", source: "ai" } as Beat);

  it("ends at the first ItemAnnouncement (a total 'top five' does NOT close the intro)", () => {
    const words = [
      w("the", 500, 700), w("top", 700, 1100), w("five", 1100, 1500), w("wonders.", 1500, 2000), // intro: a total
      w("number", 8000, 8400), w("five", 8400, 8800), // the real #5 announcement
    ];
    expect(introRegionEndMs([bt(0, 0, 3000, "avatar")], words, S)).toBe(8000);
  });

  it("falls back to the end of the hook (beat 0) when the first item is never verbally announced", () => {
    expect(introRegionEndMs([bt(0, 0, 3000, "avatar"), bt(1, 3000, 9000)], [], S)).toBe(3000);
  });
});

describe("Stage C — intro region excludes every overlay", () => {
  const S: VideoStructure = { kind: "countdown", direction: "down", total: 5 };
  const bt = (index: number, startMs: number, endMs: number, overlay?: Beat["overlay"], layout: Beat["layout"] = "broll"): Beat =>
    ({ index, startMs, endMs, text: "x", layout, visualQuery: "x", source: "ai", ...(overlay ? { overlay } : {}) } as Beat);
  const sec = (title: string, subtitle?: string): Beat["overlay"] => ({ type: "section", title, ...(subtitle ? { subtitle } : {}) });

  // Intro = hook (beat 0) + a preview beat ("top five wonders"); items announced from 8s.
  const words: WordTiming[] = [
    w("the", 3200, 3400), w("top", 3400, 3800), w("five", 3800, 4200), w("wonders.", 4200, 4800), // preview: a total
    w("number", 8000, 8400), w("five", 8400, 8800), w("the", 8800, 9100), w("wall.", 9100, 9600),
    w("it", 13000, 13200), w("spans", 13200, 13600), w("21,000", 13600, 14200), w("km.", 14200, 14800),
    w("number", 32000, 32400), w("four", 32400, 32800), w("petra.", 32800, 33400),
  ];
  const mk = (): Beat[] => [
    bt(0, 0, 3000, sec("Hook"), "avatar"),                                    // hook (section) → intro
    bt(1, 3000, 6000, sec("Preview", "should not become a fact")),           // preview → intro
    bt(2, 6000, 30000, sec("The Great Wall", "21,000 km")),                   // item #5 + fact
    bt(3, 30000, 50000, sec("Petra")),                                       // item #4
  ];

  it("numbers only real items — the hook and the preview are dropped (replaces Guard 1 + Guard 2)", () => {
    const beats = mk();
    numberStructuredOverlays(beats, S, words);
    expect(beats.map((b) => b.overlay?.subtitle)).toEqual([undefined, undefined, "#5", "#4"]); // rank in secondary field
    expect(beats.map((b) => b.overlay?.title)).toEqual([undefined, undefined, "The Great Wall", "Petra"]); // heading primary
    expect(beats[1].supporting).toBeUndefined(); // a dropped intro preview never yields a supporting card
  });

  it("NO ranking or supporting overlay is ever scheduled inside the intro region", () => {
    const beats = mk();
    const rankByIndex = numberStructuredOverlays(beats, S, words);
    scheduleOverlays(beats, words, undefined, rankByIndex);
    const introEnd = introRegionEndMs(beats, words, S); // 8000 — the first announcement
    expect(introEnd).toBe(8000);
    for (const b of beats) {
      if (b.overlayStartMs != null) expect(b.overlayStartMs).toBeGreaterThanOrEqual(introEnd);
      if (b.supportingStartMs != null) expect(b.supportingStartMs).toBeGreaterThanOrEqual(introEnd);
    }
  });

  it("the first ranked item begins EXACTLY at the first ItemAnnouncement", () => {
    const beats = mk();
    const rankByIndex = numberStructuredOverlays(beats, S, words);
    scheduleOverlays(beats, words, undefined, rankByIndex);
    const firstItem = beats.find((b) => b.overlay?.subtitle === "#5")!;
    expect(firstItem.overlayStartMs).toBe(8000); // the "Number five" cue — not any earlier intro moment
  });

  it("intro region end is INVARIANT to beat segmentation (Seconds-per-Footage)", () => {
    // Same audio, item #5 split differently; numbering + intro exclusion are identical.
    const wide = mk();
    const split: Beat[] = [
      bt(0, 0, 3000, sec("Hook"), "avatar"),
      bt(1, 3000, 6000, sec("Preview", "x")),
      bt(2, 6000, 12000, sec("The Great Wall", "21,000 km")),
      bt(3, 12000, 30000),
      bt(4, 30000, 50000, sec("Petra")),
    ];
    numberStructuredOverlays(wide, S, words);
    numberStructuredOverlays(split, S, words);
    expect(wide.map((b) => b.overlay?.subtitle).filter(Boolean)).toEqual(["#5", "#4"]);
    expect(split.map((b) => b.overlay?.subtitle).filter(Boolean)).toEqual(["#5", "#4"]);
  });

  it("is deterministic — a second identical pass yields identical overlays and windows (Resume-safe)", () => {
    const a = mk(); const ra = numberStructuredOverlays(a, S, words); scheduleOverlays(a, words, undefined, ra);
    const b = mk(); const rb = numberStructuredOverlays(b, S, words); scheduleOverlays(b, words, undefined, rb);
    expect(a.map((x) => [x.overlay?.title, x.overlay?.subtitle, x.overlayStartMs, x.supportingStartMs]))
      .toEqual(b.map((x) => [x.overlay?.title, x.overlay?.subtitle, x.overlayStartMs, x.supportingStartMs]));
  });
});

/**
 * Stage 0 — narration-driven numbering. The card's HEADING (item name) is the primary field and the
 * rank label ("#5") is secondary, and the rank (number + kind) comes from the SPOKEN CUE in each
 * item's own narration — which corrects a mis-detected structure. This is the fix for the reported
 * "Secret #1" (while the voice says "Number five") mismatch. Deterministic ordinal fallback when the
 * items are not verbally numbered.
 */
describe("Stage 0 — narration-driven numbering (heading primary; spoken rank corrects mis-detection)", () => {
  const sectionBeat = (index: number, startMs: number, endMs: number, name: string): Beat =>
    ({ index, startMs, endMs, text: "x", layout: "broll", visualQuery: "x", source: "ai", overlay: { type: "section", title: name } } as Beat);
  const cue = (label: string, num: string, at: number): WordTiming[] => [w(label, at, at + 300), w(num, at + 300, at + 700)];
  // Three items, each announced "Number five/four/three: …", spread across the timeline.
  const countdownWords = [...cue("Number", "five", 6000), ...cue("Number", "four", 20000), ...cue("Number", "three", 34000)];
  const items = (): Beat[] => [
    sectionBeat(0, 5000, 14000, "Tikal"),
    sectionBeat(1, 19000, 28000, "Petra"),
    sectionBeat(2, 33000, 42000, "The Colosseum"),
  ];

  it("REPORTED BUG resolved: structure mis-detected 'secrets/up', but the voice says 'Number five' → heading + '#5', never 'Secret #1'", () => {
    const beats = items();
    // Global detection got it wrong (secrets, counting up 1/2/3). The per-item SPOKEN cue must win.
    const rankByIndex = applyStructureNumbering(beats, { kind: "secrets", direction: "up", total: 3 }, countdownWords);
    expect(beats.map((b) => b.overlay)).toEqual([
      { type: "section", title: "Tikal", subtitle: "#5" },
      { type: "section", title: "Petra", subtitle: "#4" },
      { type: "section", title: "The Colosseum", subtitle: "#3" },
    ]);
    expect([...rankByIndex.values()]).toEqual([5, 4, 3]);           // the spoken numbers
    expect(beats.every((b) => !/secret/i.test(b.overlay?.subtitle ?? ""))).toBe(true); // never "Secret #N"
  });

  it("heading is the PRIMARY field (title); rank is SECONDARY (subtitle)", () => {
    const beats = items();
    applyStructureNumbering(beats, { kind: "countdown", direction: "down", total: 5 }, countdownWords);
    expect(beats.map((b) => b.overlay?.title)).toEqual(["Tikal", "Petra", "The Colosseum"]);
    expect(beats.map((b) => b.overlay?.subtitle)).toEqual(["#5", "#4", "#3"]);
  });

  it("spoken rank OVERRIDES a wrong ordinal (detected total 3 down would number #3/#2/#1)", () => {
    const beats = items();
    applyStructureNumbering(beats, { kind: "countdown", direction: "down", total: 3 }, countdownWords);
    expect(beats.map((b) => b.overlay?.subtitle)).toEqual(["#5", "#4", "#3"]); // spoken 5/4/3, not ordinal 3/2/1
  });

  it("falls back to the ORDINAL sequence (and structure kind) when the items are not verbally numbered", () => {
    const beats = items();
    applyStructureNumbering(beats, { kind: "facts", direction: "up", total: 3 }, []); // no words → ordinal
    expect(beats.map((b) => b.overlay)).toEqual([
      { type: "section", title: "Tikal", subtitle: "Fact #1" },
      { type: "section", title: "Petra", subtitle: "Fact #2" },
      { type: "section", title: "The Colosseum", subtitle: "Fact #3" },
    ]);
  });

  it("scheduleOverlays binds the ranking card to the spoken cue via the transient rank map (title is the heading, not a number)", () => {
    const beats = items();
    const rankByIndex = applyStructureNumbering(beats, { kind: "secrets", direction: "up", total: 3 }, countdownWords);
    scheduleOverlays(beats, countdownWords, undefined, rankByIndex);
    expect(beats[0].overlayStartMs).toBe(6000);  // "Number five" cue, even though title = "Tikal"
    expect(beats[2].overlayStartMs).toBe(34000); // "Number three" cue
  });

  it("a lone/misheard number does not drive the sequence — <2 coherent anchors → ordinal", () => {
    const beats = items();
    // Only one beat carries a spoken number, and it is not a consecutive run → ordinal fallback.
    const stray = [w("welcome", 0, 400), ...cue("Number", "seven", 20000)];
    applyStructureNumbering(beats, { kind: "countdown", direction: "down", total: 3 }, stray);
    expect(beats.map((b) => b.overlay?.subtitle)).toEqual(["#3", "#2", "#1"]); // ordinal, the stray "7" ignored
  });
});

/**
 * Visual Stage 1 — the visual planner consumes the SAME Item Timeline as the overlays. Each beat is
 * tagged INTRO (before the first item is announced) or ITEM, and that role is passed into the planner
 * prompt so the intro requests establishing/theme footage and items request the ranked object.
 */
describe("assignVisualRoles", () => {
  const S: VideoStructure = { kind: "countdown", direction: "down", total: 5 };
  const bt = (index: number, startMs: number, endMs: number): Pick<Beat, "index" | "endMs"> & { startMs: number } =>
    ({ index, startMs, endMs });
  // Intro (hook + preview) then items; #5 announced at 8s.
  const words = [w("the", 3200, 3400), w("top", 3400, 3800), w("five", 3800, 4200), w("wonders.", 4200, 4800), w("number", 8000, 8400), w("five", 8400, 8800)];

  it("tags beats before the first ItemAnnouncement INTRO and the rest ITEM", () => {
    const beats = [bt(0, 0, 3000), bt(1, 3000, 6000), bt(2, 6000, 30000), bt(3, 30000, 50000)];
    const roles = assignVisualRoles(beats, words, S);
    expect([...roles.entries()]).toEqual([[0, "intro"], [1, "intro"], [2, "item"], [3, "item"]]);
  });

  it("returns NO roles for a non-structured video (prompt stays unchanged)", () => {
    expect(assignVisualRoles([bt(0, 0, 3000), bt(1, 3000, 9000)], words, null).size).toBe(0);
  });

  it("is INVARIANT to beat segmentation — the intro/item split follows the timeline, not beat count", () => {
    const wide = [bt(0, 0, 3000), bt(1, 3000, 6000), bt(2, 6000, 30000)];
    const split = [bt(0, 0, 3000), bt(1, 3000, 6000), bt(2, 6000, 12000), bt(3, 12000, 30000)];
    const intro = (bs: (Pick<Beat, "index" | "endMs"> & { startMs: number })[]) =>
      [...assignVisualRoles(bs, words, S)].filter(([, r]) => r === "intro").map(([i]) => i);
    expect(intro(wide)).toEqual([0, 1]);  // both layouts: the two beats before 8s are intro,
    expect(intro(split)).toEqual([0, 1]); // regardless of how the item region is chopped up
  });
});

describe("buildPlanPrompt — Visual Stage 1 role guidance", () => {
  it("tags each line and asks for ESTABLISHING footage on intro, the object on items", () => {
    const chunk = [
      { index: 0, text: "welcome to our countdown", role: "intro" as const },
      { index: 1, text: "the great wall of china", role: "item" as const },
    ];
    const prompt = buildPlanPrompt(chunk, undefined, undefined, "", false, "");
    expect(prompt).toContain("[0] (INTRO) welcome to our countdown");
    expect(prompt).toContain("[1] (ITEM) the great wall of china");
    expect(prompt).toContain("VISUAL ROLE");
    expect(prompt).toMatch(/ESTABLISHING|establishing/);
    expect(prompt).toContain("must NOT depict any specific object");
  });

  it("adds NO role block and leaves lines untagged when beats carry no role (byte-identical path)", () => {
    const prompt = buildPlanPrompt([{ index: 0, text: "hello world" }], undefined, undefined, "", false, "");
    expect(prompt).toContain("[0] hello world"); // untagged, exactly as before
    expect(prompt).not.toContain("VISUAL ROLE");
    expect(prompt).not.toContain("(INTRO)");
  });
});

/**
 * ARCHITECTURAL INVARIANT (never regress) — Informational Overlays = OFF is byte-identical to the
 * pre-overlay pipeline.
 *
 * The overlay / ItemAnnouncement timeline is a DERIVED layer that must be completely inert when the
 * operator has overlays off: no structure detection, no visual roles, no overlay/role text in the
 * planner request, no overlay fields on any beat, and nothing for the renderer to composite. This
 * block pins that end-to-end — planning AND rendering — so a future change to the overlay path can
 * never silently alter a plain (overlays-off) render.
 *
 * The proof is deliberately NON-VACUOUS: the SAME structured script ("Top 10 …") is planned once
 * OFF and once ON, and the ON run is asserted to DO all the things the OFF run must not — otherwise
 * "OFF produces nothing" would pass even if the feature were dead.
 */
describe("INVARIANT: overlays OFF ⇒ byte-identical planning + rendering", () => {
  // A structured ("Top 10") narration: OFF must ignore the structure entirely; ON must detect it.
  const NARRATION: WordTiming[] = [
    w("welcome", 0, 500), w("to", 500, 900), w("the", 900, 1200), w("greatest", 1200, 2000), w("ancient", 2000, 2800), w("wonders.", 2800, 4000),
    w("number", 5000, 5500), w("ten", 5500, 6000), w("is", 6000, 6300), w("the", 6300, 6600), w("great", 6600, 7200), w("wall.", 7200, 9000),
    w("it", 10000, 10400), w("stretches", 10400, 11200), w("thousands", 11200, 12200), w("of", 12200, 12500), w("miles.", 12500, 14000),
  ];
  const TITLE = "Top 10 Ancient Wonders";
  // Every overlay-scheduling field that must stay undefined on an overlays-OFF beat.
  const OVERLAY_FIELDS = ["overlay", "overlayStartMs", "overlayEndMs", "supporting", "supportingStartMs", "supportingEndMs"] as const;
  // The markers the overlay/role path injects into the planner prompt — none may appear when OFF.
  const OVERLAY_MARKERS = ["\"overlay\"", "(INTRO)", "(ITEM)", "VISUAL ROLE", "STRUCTURED VIDEO"];

  const planReply = (withOverlay: boolean) =>
    JSON.stringify([0, 1, 2, 3, 4, 5].map((i) => ({
      index: i, visual_query: `query ${i}`, ai_media: "image",
      ...(withOverlay ? { overlay: { type: "section", title: "the great wall" } } : {}),
    })));

  // Drive the REAL planBeats path with a stubbed planner, capturing every prompt actually sent.
  async function runPlan(overlays: boolean | undefined) {
    settingsStub.overrides.GOOGLE_API_KEY = "test-key"; // make planVisualQueries call the (stubbed) model
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { contents: { parts: { text: string }[] }[] };
      prompts.push(body.contents[0].parts[0].text);
      return okResponse(geminiBody(planReply(overlays === true)));
    }));
    const beats = await planBeats(NARRATION, {
      secondsPerVisual: 4, avatarPercent: 0, realPercent: 0, hasAvatar: false, runId: "run",
      ...(overlays !== undefined ? { overlays } : {}),
      title: TITLE,
    });
    return { beats, prompts };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    settingsStub.overrides = {};
    meter.calls.length = 0;
  });

  it("OFF: no beat carries any overlay-scheduling field (default AND explicit false)", async () => {
    for (const overlays of [undefined, false] as const) {
      const { beats } = await runPlan(overlays);
      expect(beats.length).toBeGreaterThan(1);
      for (const b of beats) {
        for (const f of OVERLAY_FIELDS) expect(b[f]).toBeUndefined();
        // The ordinary pipeline still ran — layout + a visual query are present as before.
        expect(b.layout).toBeDefined();
        expect(typeof b.visualQuery).toBe("string");
      }
    }
  });

  it("OFF: the planner prompt contains no overlay or role instruction (byte-identical request)", async () => {
    const { prompts } = await runPlan(false);
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) for (const m of OVERLAY_MARKERS) expect(p).not.toContain(m);
  });

  it("OFF: the resulting beats produce NOTHING for the renderer to composite", async () => {
    const { beats } = await runPlan(false);
    const plan = await buildOverlayPlan(beats, { w: 1920, h: 1080 }, path.join(os.tmpdir(), "inv-off"), "run");
    expect(plan).toBeNull(); // no cards → the overlay ffmpeg pass is a no-op → render is unchanged
  });

  it("ON (same script): the gate is REAL — overlays are detected, requested, and attached", async () => {
    const { beats, prompts } = await runPlan(true);
    // The very markers the OFF prompt lacked ARE present when ON — so "OFF is empty" is meaningful.
    for (const m of OVERLAY_MARKERS) expect(prompts.some((p) => p.includes(m))).toBe(true);
    // And at least one beat actually receives an overlay (a numbered ranking card).
    expect(beats.some((b) => b.overlay !== undefined)).toBe(true);
  });

  it("buildPlanPrompt: an overlays-OFF prompt cannot leak overlay/structure content, whatever the hint", () => {
    const chunk = [{ index: 0, text: "welcome to our countdown" }, { index: 1, text: "the great wall of china" }];
    const off = buildPlanPrompt(chunk, undefined, undefined, "", false, "");
    // A structure hint is silently dropped when overlays are OFF → byte-identical output.
    expect(buildPlanPrompt(chunk, undefined, undefined, "", false, structurePromptHintSample)).toBe(off);
    for (const m of OVERLAY_MARKERS) expect(off).not.toContain(m);
  });
});

const structurePromptHintSample =
  "STRUCTURED VIDEO — this narration is a Top 10 list made of numbered ranked entrys. …";

/**
 * splitBeatsAtAnnouncements (Issue 2) — additive post-processing that pins an item's visual cut to
 * its spoken cue. buildBeats() is untouched; this only splits a beat that STRADDLES an announcement.
 * Fixture mirrors the real trace: #5 and #4 land on beat starts (aligned, no split); #4's short tail
 * ("it still amazes.") folded #3's opening into one straddle beat, so #3 @17000 sits mid-beat.
 */
describe("splitBeatsAtAnnouncements — announcement-aligned beat cuts (Issue 2)", () => {
  const S: VideoStructure = { kind: "countdown", direction: "down", total: 5 };
  const words = [
    w("number", 5000, 5500), w("five", 5500, 6000), w("wall.", 6000, 6800),
    w("number", 11000, 11500), w("four", 11500, 11900), w("petra.", 11900, 12600),
    w("it", 15600, 15800), w("still", 15800, 16100), w("amazes.", 16100, 16600),
    w("number", 17000, 17500), w("three", 17500, 17900), w("colosseum.", 17900, 18700),
  ];
  const beat = (index: number, startMs: number, endMs: number, text: string) => ({ index, startMs, endMs, text });
  // Tiled beats: #5 aligned @5000, #4 aligned @11000, #3 straddles the last beat (starts @15600).
  const input = () => [
    beat(0, 5000, 11000, "number five wall."),
    beat(1, 11000, 15600, "number four petra."),
    beat(2, 15600, 18700, "it still amazes. number three colosseum."),
  ];

  it("splits ONLY the straddle beat, exactly at the announcement (17000)", () => {
    const out = splitBeatsAtAnnouncements(input(), words, S);
    expect(out).toHaveLength(4); // one beat added
    // The Colosseum beat now BEGINS at the spoken cue — this is the whole fix.
    expect(out[3]).toMatchObject({ index: 3, startMs: 17000, endMs: 18700, text: "number three colosseum." });
    // Its sibling is the previous item's tail, ending where the cut begins.
    expect(out[2]).toMatchObject({ index: 2, startMs: 15600, endMs: 16600, text: "it still amazes." });
  });

  it("leaves aligned/non-announcement beats byte-identical (no other boundary moves)", () => {
    const src = input();
    const out = splitBeatsAtAnnouncements(src, words, S);
    // #5 @5000 and #4 @11000 already sit on a beat start → those beats pass through unchanged.
    expect(out[0]).toEqual(src[0]);
    expect(out[1]).toEqual(src[1]);
  });

  it("preserves the outer beat boundaries — only an INTERNAL boundary is added", () => {
    const out = splitBeatsAtAnnouncements(input(), words, S);
    expect(out[0].startMs).toBe(5000); //  first start unchanged
    expect(out[out.length - 1].endMs).toBe(18700); // last end unchanged
    expect(out.map((b) => b.index)).toEqual([0, 1, 2, 3]); // contiguous re-indexing
  });

  it("is idempotent — re-running finds the new boundary on a beat start and splits nothing (Resume-safe)", () => {
    const once = splitBeatsAtAnnouncements(input(), words, S);
    const twice = splitBeatsAtAnnouncements(once, words, S);
    expect(twice).toEqual(once);
  });

  it("returns the input untouched when no announcement is located (fail-open)", () => {
    const src = input();
    expect(splitBeatsAtAnnouncements(src, [], S)).toBe(src); // empty word stream → same array, no work
  });
});

describe("findSentenceEndMs", () => {
  it("returns the end of the first sentence at/after the mark", () => {
    const words = [w("a", 0, 200), w("world.", 1000, 1400), w("next", 2000, 2400)];
    expect(findSentenceEndMs(words, 0)).toBe(1400);
    expect(findSentenceEndMs(words, 1500)).toBeNull(); // nothing terminal after 1500
  });

  it("handles ! ? and trailing quotes/brackets", () => {
    expect(findSentenceEndMs([w("wow!", 0, 500)], 0)).toBe(500);
    expect(findSentenceEndMs([w('done."', 0, 500)], 0)).toBe(500);
    expect(findSentenceEndMs([w("mid", 0, 500), w("word", 500, 900)], 0)).toBeNull();
  });
});

/**
 * applyAiVideoRatio — the per-run "AI photo / video balance" slider on the create page,
 * shown when AI media is set to "auto".
 *
 * Shaped like the real/AI split deliberately: same `spread()`, same "percent of the pool
 * this actually controls" rule. The two things worth pinning are what the denominator is
 * (get it wrong and the slider silently under-delivers) and that an unset ratio changes
 * nothing at all, so runs created before the control existed still plan identically.
 */
describe("applyAiVideoRatio — the AI photo / video split", () => {
  const B = (index: number, layout: "broll" | "split" | "avatar", source: "ai" | "real") =>
    ({ index, startMs: index * 1000, endMs: (index + 1) * 1000, text: `line ${index}`, layout, visualQuery: "q", source } as Beat);

  const tenAi = () => Array.from({ length: 10 }, (_, i) => B(i, "broll", "ai"));

  it("renders the requested share as video and pins it against the planner", () => {
    const beats = tenAi();
    applyAiVideoRatio(beats, 40, "run");
    expect(beats.filter((b) => b.aiMedia === "video").length).toBe(4);
    expect(beats.filter((b) => b.aiMedia === "image").length).toBe(6);
    // Pinned is what stops resolveAiMedia treating this as a planner verdict it may revisit.
    expect(beats.every((b) => b.aiMediaPinned)).toBe(true);
  });

  it("0 means photos only — a real choice, not 'unset'", () => {
    const beats = tenAi();
    applyAiVideoRatio(beats, 0, "run");
    expect(beats.filter((b) => b.aiMedia === "video")).toHaveLength(0);
    expect(beats.every((b) => b.aiMedia === "image" && b.aiMediaPinned)).toBe(true);
  });

  it("does nothing at all when the operator set no ratio", () => {
    const beats = tenAi();
    beats[0].aiMedia = "video"; // the planner's own verdict
    applyAiVideoRatio(beats, null, "run");
    expect(beats[0].aiMedia).toBe("video");
    expect(beats.some((b) => b.aiMediaPinned)).toBe(false);
    expect(beats.filter((b) => b.aiMedia !== undefined)).toHaveLength(1);
  });

  it("counts only the beats it can control — not avatar or real-footage beats", () => {
    // 4 plain AI beats + 2 this ratio does not govern. 50% must mean 2 of 4, not 3 of 6.
    const beats = [
      B(0, "avatar", "ai"),
      B(1, "broll", "real"),
      B(2, "broll", "ai"),
      B(3, "broll", "ai"),
      B(4, "broll", "ai"),
      B(5, "split", "ai"),
    ];
    applyAiVideoRatio(beats, 50, "run");
    expect(beats.filter((b) => b.aiMedia === "video").length).toBe(2);
    // The excluded two are left exactly as they were.
    for (const i of [0, 1]) {
      expect(beats[i].aiMedia).toBeUndefined();
      expect(beats[i].aiMediaPinned).toBeUndefined();
    }
  });

  it("spreads the video beats across the timeline rather than bunching them", () => {
    const beats = tenAi();
    applyAiVideoRatio(beats, 50, "run");
    const vid = beats.filter((b) => b.aiMedia === "video").map((b) => b.index);
    expect(vid).toHaveLength(5);
    expect(Math.max(...vid)).toBeGreaterThan(6); // reaches the back half
  });

  it("clamps a nonsense percentage instead of throwing", () => {
    const over = tenAi();
    applyAiVideoRatio(over, 500, "run");
    expect(over.every((b) => b.aiMedia === "video")).toBe(true);
    const under = tenAi();
    applyAiVideoRatio(under, -20, "run");
    expect(under.every((b) => b.aiMedia === "image")).toBe(true);
  });
});

/**
 * normalizeProductLabel — the gate on wording we are willing to print on a pack.
 *
 * This value is handed to an image model as text to RENDER, which makes it unlike the
 * planner's other fields: a bad value does not degrade a decision, it draws scribble
 * across the product. Two rejections carry the weight — length (a sentence renders as
 * unreadable smear) and narration echo (rendering the spoken line onto the props is the
 * exact bug the blanket text ban was written to stop).
 */
describe("normalizeProductLabel", () => {
  it("keeps a brand as written", () => {
    expect(normalizeProductLabel("Arm & Hammer")).toBe("Arm & Hammer");
    expect(normalizeProductLabel("BORAX")).toBe("BORAX");
    expect(normalizeProductLabel("LAUNDRY BOOSTER")).toBe("LAUNDRY BOOSTER");
  });

  it("strips the quotes models like to wrap the value in", () => {
    expect(normalizeProductLabel('"Tide"')).toBe("Tide");
    expect(normalizeProductLabel("«Tide»")).toBe("Tide");
    expect(normalizeProductLabel("  Tide  ")).toBe("Tide");
  });

  it("collapses whitespace and newlines rather than rendering them", () => {
    expect(normalizeProductLabel("Arm &\n  Hammer")).toBe("Arm & Hammer");
  });

  it("rejects a line of the narration — the bug the text ban exists to prevent", () => {
    expect(normalizeProductLabel("The brand name is Arm & Hammer Super Washing Soda.")).toBeUndefined();
    expect(normalizeProductLabel("It comes in a bright yellow box")).toBeUndefined();
  });

  it("rejects sentence punctuation even when it is short", () => {
    expect(normalizeProductLabel("Tide. Now")).toBeUndefined();
    expect(normalizeProductLabel("Buy it!")).toBeUndefined();
  });

  it("rejects anything too long to render legibly", () => {
    expect(normalizeProductLabel("SUPER CONCENTRATED LAUNDRY DETERGENT POWDER")).toBeUndefined();
  });

  it("treats empty and non-strings as 'not a product shot' — the common case", () => {
    expect(normalizeProductLabel("")).toBeUndefined();
    expect(normalizeProductLabel("   ")).toBeUndefined();
    expect(normalizeProductLabel(undefined)).toBeUndefined();
    expect(normalizeProductLabel(null)).toBeUndefined();
    expect(normalizeProductLabel(42)).toBeUndefined();
  });
});

/**
 * Regression: the caps were first set to 32 chars / 4 words, and a live planner run rejected
 * "Arm & Hammer Super Washing Soda" — the very brand the ENTITY RULE uses as its example, and
 * the one this feature was built for. The caps exist to stop a SENTENCE being rendered, not to
 * stop a long brand.
 */
describe("normalizeProductLabel accepts real brand names", () => {
  it("keeps the canonical long brand", () => {
    expect(normalizeProductLabel("Arm & Hammer Super Washing Soda")).toBe("Arm & Hammer Super Washing Soda");
  });

  it("still rejects narration of a similar length", () => {
    expect(normalizeProductLabel("It comes in a bright yellow box")).toBeUndefined();
  });
});

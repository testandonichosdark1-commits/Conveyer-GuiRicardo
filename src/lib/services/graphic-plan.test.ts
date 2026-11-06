import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Graphic beats — the planner pass (graphic-plan.ts) and its one hook in planBeats.
 *
 *  - applyGraphicPicks: the deterministic rules (schema gate, merge clamp, no repeat, cap,
 *    reindex, no card on a graphic) without any model.
 *  - planBeats: OFF sends exactly the prompts it sent before the feature and returns no
 *    graphic; ON asks once more and applies the answer.
 *
 * Hermetic: settings, logger and cost ledger are mocked, fetch is stubbed.
 */
const settingsStub = vi.hoisted(() => ({ overrides: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => settingsStub.overrides[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("./cost-ledger", () => ({ recordGemini: () => {} }));

import { applyGraphicPicks, parseGraphicPicks, buildGraphicPrompt, type GraphicPick } from "./graphic-plan";
import { planBeats, type Beat } from "./studio-plan";

function beat(i: number, startS: number, endS: number, extra: Partial<Beat> = {}): Beat {
  return { index: i, startMs: startS * 1000, endMs: endS * 1000, text: `sentence ${i}.`, layout: "broll", visualQuery: `q${i}`, source: "real", ...extra };
}
const quote = (text = "Something that good gets copied.") => ({ text, highlight: ["copied"] });
const OPTS = { percent: 100, maxSec: 20, listMaxSec: 45 };

describe("applyGraphicPicks", () => {
  const beats = () => [beat(0, 0, 4), beat(1, 4, 8), beat(2, 8, 12), beat(3, 12, 16), beat(4, 16, 40), beat(5, 40, 44)];

  it("turns a valid pick into a graphic beat that keeps its b-roll fields", () => {
    const out = applyGraphicPicks(beats(), [{ index: 1, through: 1, template: "kinetic_quote", data: quote() }], OPTS);
    expect(out[1].layout).toBe("graphic");
    expect(out[1].graphic?.template).toBe("kinetic_quote");
    expect(out[1].graphic?.data).toMatchObject({ style: "outline-fill", bg: "parchment" }); // zod defaults applied
    expect(out[1].visualQuery).toBe("q1"); // the fallback
    expect(out[1].source).toBe("real");
  });

  it("drops a pick its schema rejects (the beat stays b-roll)", () => {
    const out = applyGraphicPicks(beats(), [{ index: 1, through: 1, template: "kinetic_quote", data: { text: "x", oops: 1 } }], OPTS);
    expect(out.every((b) => b.layout === "broll")).toBe(true);
  });

  it("merges following beats up to the limit, joins the text and reindexes", () => {
    const out = applyGraphicPicks(beats(), [{ index: 0, through: 3, template: "kinetic_quote", data: quote() }], { ...OPTS, maxSec: 10 });
    expect(out[0].endMs).toBe(8000); // 0..8s fits 10s, 0..12s would not
    expect(out[0].text).toBe("sentence 0. sentence 1.");
    expect(out.map((b) => b.index)).toEqual([0, 1, 2, 3, 4]);
    expect(out[1].text).toBe("sentence 2.");
  });

  it("gives list templates the longer limit", () => {
    const data = { title: "What changed", items: [{ text: "Pocket clips", state: "check" }] };
    const out = applyGraphicPicks(beats(), [{ index: 3, through: 4, template: "checklist_card", data }], OPTS);
    expect(out[3].endMs).toBe(40000); // 12..40s = 28s: over 20, under 45
  });

  it("never repeats a template in consecutive beats", () => {
    const picks: GraphicPick[] = [
      { index: 0, through: 0, template: "kinetic_quote", data: quote() },
      { index: 1, through: 1, template: "kinetic_quote", data: quote("Built to outlast you.") },
      { index: 2, through: 2, template: "kinetic_quote", data: quote("Again.") },
    ];
    const out = applyGraphicPicks(beats(), picks, OPTS);
    expect(out.map((b) => b.layout)).toEqual(["graphic", "broll", "graphic", "broll", "broll", "broll"]);
  });

  it("caps graphic screen time at percent + 10, dropping from dense stretches first", () => {
    const picks: GraphicPick[] = [
      { index: 0, through: 0, template: "kinetic_quote", data: quote() },
      { index: 1, through: 1, template: "impact_bars", data: { lines: [{ text: "Copied" }] } },
      { index: 5, through: 5, template: "kinetic_quote", data: quote() },
    ];
    // total 44s, 3 picks of 4s = 12s = 27%; cap at 10% + 10 = 20% (8.8s) → one must go
    const out = applyGraphicPicks(beats(), picks, { ...OPTS, percent: 10 });
    const g = out.filter((b) => b.layout === "graphic");
    expect(g).toHaveLength(2);
    expect(out[5].layout).toBe("graphic"); // the isolated one survives
  });

  it("removes lower-third cards from a graphic beat and skips avatar beats", () => {
    const bs = beats();
    bs[2].overlay = { type: "fact", title: "x" };
    bs[2].overlayStartMs = 8000;
    bs[4].layout = "split";
    const out = applyGraphicPicks(bs, [
      { index: 2, through: 2, template: "kinetic_quote", data: quote() },
      { index: 4, through: 4, template: "impact_bars", data: { lines: [{ text: "x" }] } },
    ], OPTS);
    expect(out[2].overlay).toBeUndefined();
    expect(out[2].overlayStartMs).toBeUndefined();
    expect(out[4].layout).toBe("split");
  });

  it("does not merge into an avatar beat", () => {
    const bs = beats();
    bs[1].layout = "avatar";
    const out = applyGraphicPicks(bs, [{ index: 0, through: 2, template: "kinetic_quote", data: quote() }], OPTS);
    expect(out[0].endMs).toBe(4000);
    expect(out[1].layout).toBe("avatar");
  });
});

describe("parseGraphicPicks / prompt", () => {
  it("keeps only well-formed picks", () => {
    const picks = parseGraphicPicks(`noise [{"index":1,"template":"counter","data":{"value":5}},{"index":"x"},{"index":2,"through":1,"template":"counter","data":{}},{"index":3,"template":"nope","data":{}}]`);
    expect(picks).toEqual([{ index: 1, through: 1, template: "counter", data: { value: 5 } }]);
    expect(parseGraphicPicks("no json")).toBeNull();
  });
  it("tells the model the target, the limits and the previous template", () => {
    const p = buildGraphicPrompt([{ index: 3, text: "Hello there.", durSec: 4 }], 65, 20, 45, "counter");
    expect(p).toContain("About 65% of SCREEN TIME");
    expect(p).toContain("Max 20s");
    expect(p).toContain("go to 45s");
    expect(p).toContain("ended with: counter");
    expect(p).toContain("[3] (4.0s) Hello there.");
  });
});

describe("planBeats hook", () => {
  const W = (word: string, s: number) => ({ word, startMs: s, endMs: s + 300 });
  const NARRATION = [
    W("Something", 0), W("that", 400), W("good", 800), W("gets", 1200), W("copied.", 1600),
    W("Maglite", 4000), W("sued", 4400), W("them", 4800), W("all", 5200), W("in", 5600), W("court.", 6000),
    W("The", 8000), W("case", 8400), W("took", 8800), W("five", 9200), W("long", 9600), W("years.", 10000),
  ];
  const gemini = (text: string) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => "" });

  async function run(graphics?: { percent: number }) {
    settingsStub.overrides.GOOGLE_API_KEY = "k";
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: { body?: string }) => {
      const text = JSON.parse(init?.body ?? "{}").contents[0].parts[0].text as string;
      prompts.push(text);
      if (text.includes("graphics editor")) {
        return gemini(JSON.stringify([{ index: 0, through: 0, template: "kinetic_quote", data: { text: "Something that good gets copied.", highlight: ["copied"] } }]));
      }
      return gemini(JSON.stringify([0, 1, 2, 3].map((i) => ({ index: i, visual_query: `query ${i}` }))));
    }));
    const beats = await planBeats(NARRATION, { secondsPerVisual: 3, avatarPercent: 0, realPercent: 50, hasAvatar: false, runId: "r", ...(graphics ? { graphics } : {}) });
    return { beats, prompts };
  }
  afterEach(() => { vi.unstubAllGlobals(); settingsStub.overrides = {}; });

  it("OFF: no graphic prompt is sent and no beat is a graphic", async () => {
    const { beats, prompts } = await run();
    expect(prompts.some((p) => p.includes("graphics editor"))).toBe(false);
    expect(beats.some((b) => b.layout === "graphic" || b.graphic)).toBe(false);
  });

  it("ON: the graphic pass runs after the ordinary plan and applies its picks", async () => {
    const off = await run();
    const on = await run({ percent: 100 }); // the tiny narration plans as ONE beat; 100% keeps it under the cap
    expect(on.prompts.filter((p) => !p.includes("graphics editor"))).toEqual(off.prompts); // ordinary planning unchanged
    expect(on.beats[0].layout).toBe("graphic");
    expect(on.beats[0].graphic?.template).toBe("kinetic_quote");
    expect(on.beats[0].visualQuery).toBe(off.beats[0].visualQuery);
  });
});

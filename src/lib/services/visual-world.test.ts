import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Visual world (services/visual-world.ts) + its planner wiring.
 *
 * The invariant that matters most: with no world, buildPlanPrompt is byte-identical to before
 * — the feature only ever ADDS a block and a rule. Hermetic: fetch is stubbed, DB-backed
 * logger / cost ledger are mocked.
 */
const settingsStub = vi.hoisted(() => ({ overrides: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => settingsStub.overrides[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("./cost-ledger", () => ({ recordGemini: () => {} }));

import {
  normalizeVisualWorld,
  formatVisualWorld,
  visualWorldAnchor,
  withWorldAnchor,
  readVisualWorld,
  visualWorldPath,
  buildVisualWorld,
  type VisualWorld,
} from "./visual-world";
import { buildPlanPrompt } from "./studio-plan";

const FAMILIES = [
  "Akkadian cylinder seal impression",
  "Assyrian palace relief",
  "cuneiform clay tablet",
  "Babylonian kudurru boundary stone",
  "archival excavation photograph",
  "Assyriologist reading a tablet under a lamp",
];
const RAW = {
  topic: "Sumerian scorpion-man myth in Mesopotamian art",
  era: "c. 3000-500 BC",
  region: "Mesopotamia",
  families: FAMILIES,
  avoid: ["fantasy creature art", "generic office workers"],
};
const WORLD = normalizeVisualWorld(RAW) as VisualWorld;

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json, text: async () => "" } as unknown as Response;
}
function geminiBody(text: string) {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  settingsStub.overrides = {};
});

describe("normalizeVisualWorld", () => {
  it("accepts a well-formed world", () => {
    expect(WORLD.topic).toBe(RAW.topic);
    expect(WORLD.families).toEqual(FAMILIES);
    expect(WORLD.avoid).toHaveLength(2);
  });

  it("rejects a world with no topic or too few families — worse than none", () => {
    expect(normalizeVisualWorld({ ...RAW, topic: "  " })).toBeNull();
    expect(normalizeVisualWorld({ ...RAW, families: FAMILIES.slice(0, 4) })).toBeNull();
    expect(normalizeVisualWorld(null)).toBeNull();
    expect(normalizeVisualWorld("text")).toBeNull();
  });

  it("dedupes, trims and drops non-strings in the family list", () => {
    const w = normalizeVisualWorld({ ...RAW, families: [...FAMILIES, " cuneiform  clay tablet ", 3, ""] });
    expect(w?.families).toEqual(FAMILIES);
  });
});

describe("anchor", () => {
  it("names topic, era and region in one line", () => {
    expect(visualWorldAnchor(WORLD)).toBe("Sumerian scorpion-man myth in Mesopotamian art — c. 3000-500 BC, Mesopotamia");
  });

  it("leads the context, and leaves it untouched with no world", () => {
    expect(withWorldAnchor(WORLD, "I want to start with a carving.")).toMatch(/^Sumerian scorpion-man myth.*\. I want to start/);
    expect(withWorldAnchor(null, "I want to start with a carving.")).toBe("I want to start with a carving.");
  });
});

describe("buildPlanPrompt + visual world", () => {
  const chunk = [{ index: 0, text: "A secret is hard to find because someone is hiding it." }];

  it("no world → byte-identical to the pre-feature prompt (default and archive)", () => {
    expect(buildPlanPrompt(chunk, undefined, "ctx", "", false, "", "")).toBe(buildPlanPrompt(chunk, undefined, "ctx", "", false, "", "", ""));
    expect(buildPlanPrompt(chunk, undefined, "ctx", "", true, "", "archive")).toBe(buildPlanPrompt(chunk, undefined, "ctx", "", true, "", "archive", "  "));
  });

  it("with a world → the world block and the on-topic rule are both in the prompt", () => {
    const p = buildPlanPrompt(chunk, undefined, "ctx", "", false, "", "", formatVisualWorld(WORLD));
    expect(p).toContain("VISUAL WORLD of this video");
    expect(p).toContain("Akkadian cylinder seal impression");
    expect(p).toContain("Off-topic for this video: fantasy creature art");
    expect(p).toContain("ON-TOPIC WORLD RULE");
    // the original rule is still there — the new one states it overrides its priority order
    expect(p).toContain("ABSTRACT SCENE RULE");
  });
});

describe("buildPlanPrompt — shot variety", () => {
  const chunk = [{ index: 6, text: "What he had found was a flood story." }];
  const recent = ["cuneiform clay tablet museum catalogue photograph", "Epic of Gilgamesh flood tablet museum photograph"];

  it("with a world: the variety rule and the previous chunk's recent shots are in the prompt", () => {
    const p = buildPlanPrompt(chunk, undefined, "ctx", "x", false, "", "", formatVisualWorld(WORLD), recent);
    expect(p).toContain("SHOT VARIETY RULE");
    expect(p).toContain(`Recent shots (the lines just before these): ${recent.join("; ")}`);
  });

  it("without a world: recent shots are ignored and the prompt is byte-identical to before", () => {
    expect(buildPlanPrompt(chunk, undefined, "ctx", "x", false, "", "", "", recent)).toBe(buildPlanPrompt(chunk, undefined, "ctx", "x", false, "", ""));
  });
});

describe("buildVisualWorld", () => {
  it("off unless VISUAL_WORLD=1, and never calls Gemini then", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    settingsStub.overrides = { GOOGLE_API_KEY: "k" };
    expect(await buildVisualWorld("r", "some script")).toBeNull();
    settingsStub.overrides = { VISUAL_WORLD: "1" }; // no key
    expect(await buildVisualWorld("r", "some script")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the parsed world and sends the whole script", async () => {
    let sent = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: { body?: string }) => {
      sent = init?.body ?? "";
      return okResponse(geminiBody(JSON.stringify(RAW)));
    }));
    settingsStub.overrides = { VISUAL_WORLD: "1", GOOGLE_API_KEY: "k" };
    const w = await buildVisualWorld("r", "opening words ... the very last sentence of the script", "Scorpion Men");
    expect(w).toEqual(WORLD);
    expect(sent).toContain("the very last sentence of the script");
    expect(sent).toContain("Scorpion Men");
  });
});

describe("persistence for Resume", () => {
  it("round-trips through visual-world.json, null when absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vw-"));
    expect(readVisualWorld(dir)).toBeNull();
    fs.writeFileSync(visualWorldPath(dir), JSON.stringify(WORLD));
    expect(readVisualWorld(dir)).toEqual(WORLD);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

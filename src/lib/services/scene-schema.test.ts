import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Beat } from "./studio-plan";
import {
  SCENE_PLAN_V1_FILENAME,
  beatToScene,
  beatsToScenePlan,
  scenePlanV1Schema,
  writeScenePlanV1,
} from "./scene-schema";

const META = { runId: "run-1", totalDurationMs: 9400, generatedAt: "2026-10-02T12:00:00.000Z" };

/** A tiled, planned run as studio-pipeline holds it right before beats.json is written. */
function plannedBeats(): Beat[] {
  return [
    {
      index: 0,
      startMs: 0,
      endMs: 3120,
      text: "In 1947, a small workshop in Ohio changed how America cleaned its homes.",
      layout: "avatar",
      visualQuery: "",
      source: "real",
      domain: "history",
    },
    {
      index: 1,
      startMs: 3120,
      endMs: 6480,
      text: "The brand name is Arm & Hammer Super Washing Soda.",
      layout: "broll",
      visualQuery: "Arm & Hammer Super Washing Soda box on a shelf",
      aiPrompt: "A yellow box of Arm & Hammer Super Washing Soda on a wooden laundry shelf, soft daylight",
      productLabel: "Arm & Hammer",
      aiMedia: "image",
      aiMediaPinned: true,
      queryType: "entity",
      footageKind: "contemporary",
      source: "ai",
      domain: "business",
      overlay: { type: "fact", title: "Arm & Hammer", subtitle: "Since 1846" },
      overlayStartMs: 3300,
      overlayEndMs: 6100,
    },
    {
      index: 2,
      startMs: 6480,
      endMs: 9400,
      text: "Steel mill workers kept the furnaces running through the night.",
      layout: "split",
      visualQuery: "steel mill workers 1940s",
      youtubeQuery: "1940s steel mill newsreel",
      queryType: "generic",
      footageKind: "archival",
      source: "real",
      topicKey: "archival::steel mill workers 1940s",
    },
  ];
}

describe("beatToScene", () => {
  it("A. projects a beat onto a scene", () => {
    const s = beatToScene(plannedBeats()[1]);
    expect(s).toMatchObject({
      id: "scene_0001",
      index: 1,
      text: "The brand name is Arm & Hammer Super Washing Soda.",
      layout: "broll",
      source: "ai",
      visualQuery: "Arm & Hammer Super Washing Soda box on a shelf",
      aiPrompt: expect.stringContaining("Arm & Hammer"),
      productLabel: "Arm & Hammer",
      queryType: "entity",
      footageKind: "contemporary",
      overlay: { type: "fact", title: "Arm & Hammer", subtitle: "Since 1846" },
    });
  });

  it("B. preserves timestamps exactly", () => {
    for (const b of plannedBeats()) {
      const s = beatToScene(b);
      expect([s.startMs, s.endMs]).toEqual([b.startMs, b.endMs]);
    }
    const s = beatToScene(plannedBeats()[1]);
    expect([s.overlayStartMs, s.overlayEndMs]).toEqual([3300, 6100]);
  });

  it("C. derives durationMs = endMs - startMs (beats carry no duration)", () => {
    expect(beatToScene(plannedBeats()[0]).durationMs).toBe(3120);
    expect(beatToScene(plannedBeats()[2]).durationMs).toBe(2920);
    const fractional = { ...plannedBeats()[0], startMs: 10.5, endMs: 20.25 };
    expect(beatToScene(fractional).durationMs).toBe(9.75);
  });

  it("D. copies optional fields only when present — absent stays absent, never defaulted", () => {
    const avatar = beatToScene(plannedBeats()[0]);
    for (const k of ["aiPrompt", "productLabel", "aiMedia", "aiMediaPinned", "queryType", "footageKind", "overlay", "youtubeQuery", "topicKey"]) {
      expect(k in avatar).toBe(false);
    }
    const archival = beatToScene(plannedBeats()[2]);
    expect(archival.youtubeQuery).toBe("1940s steel mill newsreel");
    expect(archival.topicKey).toBe("archival::steel mill workers 1940s");
    expect("overlay" in archival).toBe(false);
  });

  it("F. does not mutate the beat, and the overlay is copied, not shared", () => {
    const beats = plannedBeats();
    const before = JSON.stringify(beats);
    const plan = beatsToScenePlan(beats, META);
    expect(JSON.stringify(beats)).toBe(before);
    // The pipeline later rewrites a failed avatar beat's layout in place; that must not
    // reach an already-built plan, nor may editing the plan reach the beats.
    beats[1].overlay!.title = "changed";
    beats[0].layout = "broll";
    expect(plan.scenes[1].overlay!.title).toBe("Arm & Hammer");
    expect(plan.scenes[0].layout).toBe("avatar");
  });
});

describe("beatsToScenePlan", () => {
  it("E. produces version 1 and one scene per beat, in order", () => {
    const plan = beatsToScenePlan(plannedBeats(), META);
    expect(plan.version).toBe(1);
    expect(plan.runId).toBe("run-1");
    expect(plan.totalDurationMs).toBe(9400);
    expect(plan.scenes.map((s) => s.id)).toEqual(["scene_0000", "scene_0001", "scene_0002"]);
  });

  it("G. zod rejects structurally invalid plans", () => {
    const good = beatsToScenePlan(plannedBeats(), META);
    const bad = (mutate: (p: any) => void) => {
      const p = JSON.parse(JSON.stringify(good));
      mutate(p);
      return scenePlanV1Schema.safeParse(p).success;
    };
    expect(scenePlanV1Schema.safeParse(good).success).toBe(true);
    expect(bad((p) => (p.version = 2))).toBe(false);
    expect(bad((p) => (p.scenes = []))).toBe(false);
    expect(bad((p) => delete p.scenes[0].startMs)).toBe(false);
    expect(bad((p) => (p.scenes[0].layout = "fullscreen"))).toBe(false);
    expect(bad((p) => (p.scenes[1].endMs = 100))).toBe(false); // end before start
    expect(bad((p) => (p.scenes[1].durationMs = 1))).toBe(false); // inconsistent duration
    expect(bad((p) => (p.scenes[2].index = 1))).toBe(false); // duplicate index (and id mismatch)
    expect(bad((p) => (p.scenes = [p.scenes[1], p.scenes[0]]))).toBe(false); // out of order
    expect(bad((p) => (p.scenes[0].unknownField = 1))).toBe(false); // strict
    expect(bad((p) => (p.scenes[1].overlay.type = "banner"))).toBe(false);
    expect(bad((p) => (p.generatedAt = "yesterday"))).toBe(false);
    // beatsToScenePlan itself throws on bad beats rather than writing them.
    expect(() => beatsToScenePlan([], META)).toThrow();
    expect(() => beatsToScenePlan([{ ...plannedBeats()[0], startMs: 50, endMs: 10 }], META)).toThrow();
  });
});

describe("writeScenePlanV1", () => {
  it("H. writes its own file and leaves beats.json byte-identical", () => {
    expect(SCENE_PLAN_V1_FILENAME).toBe("scene-plan.v1.json");
    expect(SCENE_PLAN_V1_FILENAME).not.toBe("scenes.json"); // legacy pipeline's file, different shape
    expect(SCENE_PLAN_V1_FILENAME).not.toBe("beats.json");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-plan-"));
    try {
      const beats = plannedBeats();
      // Exactly how studio-pipeline writes beats.json.
      const beatsPath = path.join(dir, "beats.json");
      fs.writeFileSync(beatsPath, JSON.stringify(beats, null, 2), "utf-8");
      const beatsBytes = fs.readFileSync(beatsPath);

      const out = path.join(dir, SCENE_PLAN_V1_FILENAME);
      writeScenePlanV1(out, beats, { runId: "run-1", totalDurationMs: 9400 });

      expect(fs.readFileSync(beatsPath).equals(beatsBytes)).toBe(true);
      expect(JSON.stringify(beats, null, 2)).toBe(beatsBytes.toString("utf-8"));
      expect(fs.readdirSync(dir).sort()).toEqual(["beats.json", "scene-plan.v1.json"]); // no .tmp left over
      const onDisk = scenePlanV1Schema.parse(JSON.parse(fs.readFileSync(out, "utf-8")));
      expect(onDisk.scenes).toHaveLength(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws (for the caller's fail-open catch) and writes nothing on invalid beats", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-plan-"));
    try {
      const out = path.join(dir, SCENE_PLAN_V1_FILENAME);
      expect(() => writeScenePlanV1(out, [], { runId: "run-1", totalDurationMs: 0 })).toThrow();
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

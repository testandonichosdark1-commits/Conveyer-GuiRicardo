import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kenBurnsFilter, variedMotion } from "./ken-burns";
import { planAnchorBeats, anchorTermsRegex, listAnchorImages } from "./anchor-images";
import { themeForOverlay, buildCardSvg } from "./overlay-renderer";
import { ARCHIVE_LABEL_THEME, ARCHIVE_STATEMENT_THEME, ARCHIVE_CALLOUT_THEME, PRESTIGE_THEME, DEFAULT_OVERLAY_THEME } from "./overlay-themes";
import { buildPlanPrompt } from "./studio-plan";
import { NO_CHARACTER_REFERENCE } from "../character-reference";
import { channelSettingOverrides, ARCHIVE_STYLE_OVERRIDES, type Channel } from "../channels";

/**
 * The archive (historical-documentary) edit style. Every piece is OFF unless asked for, so the
 * first assertion in each block is "default = byte-identical to before".
 */

describe("Ken Burns — archive motion", () => {
  it("is byte-identical to the original chain when no options are passed", () => {
    const a = kenBurnsFilter(1920, 1080, 150, 30, false);
    expect(a).toContain("z='min(1.0+on*");
    expect(a).toContain("x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'");
    expect(a).toContain("1.1800");
  });

  it("honours a gentler range", () => {
    const f = kenBurnsFilter(1920, 1080, 300, 30, false, { range: 0.06 });
    expect(f).toContain("1.0600");
    expect(f).not.toContain("1.1800");
  });

  it("tilt-up holds the zoom and moves y from the bottom to the top", () => {
    const f = kenBurnsFilter(1920, 1080, 301, 30, false, { range: 0.06, motion: "up" });
    expect(f).toContain("z='1.0600'");
    expect(f).toContain("y='(ih-ih/zoom)*(1-on/300)'");
  });

  it("pan holds the zoom and moves x left to right", () => {
    const f = kenBurnsFilter(1920, 1080, 301, 30, false, { range: 0.06, motion: "pan" });
    expect(f).toContain("x='(iw-iw/zoom)*on/300'");
  });

  it("top-biases the cover crop for portraits, still before zoompan", () => {
    const f = kenBurnsFilter(1920, 1080, 150, 30, false, { topBias: true });
    expect(f).toContain(":'(iw-ow)/2':'(ih-oh)*0.2'");
    expect(f.indexOf("crop=")).toBeLessThan(f.indexOf("zoompan="));
  });

  it("cycles four moves deterministically", () => {
    expect([0, 1, 2, 3, 4].map(variedMotion)).toEqual(["in", "out", "up", "pan", "in"]);
  });
});

describe("anchor images", () => {
  const beat = (index: number, startSec: number, text: string, layout = "broll") =>
    ({ index, startMs: startSec * 1000, endMs: (startSec + 10) * 1000, text, layout }) as never;

  it("is empty with no images", () => {
    expect(planAnchorBeats([beat(0, 0, "Wanrong")], [], null, 75000).size).toBe(0);
  });

  it("places anchors only on protagonist beats, spaced, and always on the last beat", () => {
    const beats = [
      beat(0, 0, "In 1922 Wanrong married"),
      beat(1, 10, "Wanrong smiled"), // too close to beat 0
      beat(2, 20, "The palace was cold"),
      beat(3, 90, "Wanrong wrote letters"), // ≥ 75 s after beat 0
      beat(4, 200, "The war ended"), // last beat — always an anchor
    ];
    const plan = planAnchorBeats(beats, ["/a.jpg", "/b.jpg"], anchorTermsRegex("Wanrong, empress"), 75000);
    expect([...plan.keys()]).toEqual([0, 3, 4]);
    expect(plan.get(0)).toBe("/a.jpg");
    expect(plan.get(3)).toBe("/b.jpg");
    expect(plan.get(4)).toBe("/a.jpg");
  });

  it("never anchors an avatar or graphic beat", () => {
    const beats = [beat(0, 0, "Wanrong", "avatar"), beat(1, 100, "Wanrong", "graphic"), beat(2, 200, "Wanrong")];
    expect([...planAnchorBeats(beats, ["/a.jpg"], null, 75000).keys()]).toEqual([2]);
  });

  it("lists only image files, sorted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anchors-"));
    for (const n of ["b.png", "a.jpg", "notes.txt", ".hidden.jpg"]) fs.writeFileSync(path.join(dir, n), "x");
    expect(listAnchorImages(dir).map((p) => path.basename(p))).toEqual(["a.jpg", "b.png"]);
    expect(listAnchorImages(path.join(dir, "missing"))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("archive overlay cards", () => {
  it("keeps today's themes when the style is not archive", () => {
    expect(themeForOverlay({ type: "date", title: "1969" })).toBe(PRESTIGE_THEME);
    expect(themeForOverlay({ type: "person", title: "X" })).toBe(DEFAULT_OVERLAY_THEME);
  });

  it("maps types to label / statement / callout in archive style", () => {
    expect(themeForOverlay({ type: "date", title: "Vienna, Austria - 1673" }, "archive")).toBe(ARCHIVE_LABEL_THEME);
    expect(themeForOverlay({ type: "person", title: "Philip IV, King of Spain" }, "archive")).toBe(ARCHIVE_LABEL_THEME);
    expect(themeForOverlay({ type: "quote", title: "Dead at twenty-one." }, "archive")).toBe(ARCHIVE_STATEMENT_THEME);
    expect(themeForOverlay({ type: "fact", title: "Only one survived." }, "archive")).toBe(ARCHIVE_CALLOUT_THEME);
  });

  it("puts the statement in the middle of the frame with no visible box", () => {
    const { geo, svg } = buildCardSvg({ type: "quote", title: "Dead at twenty-one." }, { w: 1920, h: 1080 }, ARCHIVE_STATEMENT_THEME);
    expect(Math.abs(geo.y + geo.h / 2 - 540)).toBeLessThanOrEqual(1);
    expect(Math.abs(geo.x + geo.w / 2 - 960)).toBeLessThanOrEqual(1);
    expect(svg).toContain('fill-opacity="0"');
  });

  it("puts the label bottom-left", () => {
    const { geo } = buildCardSvg({ type: "date", title: "Vienna, Austria - 1673" }, { w: 1920, h: 1080 }, ARCHIVE_LABEL_THEME);
    expect(geo.x).toBeLessThan(200);
    expect(geo.y + geo.h).toBeGreaterThan(900);
  });
});

describe("archive planner prompt", () => {
  const chunk = [{ index: 0, text: "In 1922 Wanrong married the last emperor." }];
  it("is byte-identical without the style", () => {
    expect(buildPlanPrompt(chunk, undefined, undefined, "", true, "")).toBe(buildPlanPrompt(chunk, undefined, undefined, "", true, "", ""));
  });
  it("swaps in period-authentic AI prompts, archive queries and archive cards", () => {
    const p = buildPlanPrompt(chunk, undefined, undefined, "", true, "", "archive");
    expect(p).toContain("AUTHENTIC PERIOD SOURCE");
    expect(p).not.toContain("PHOTOREALISTIC, real-world documentary");
    expect(p).toContain("ARCHIVE SEARCH RULE");
    expect(p).toContain("ARCHIVE DOCUMENTARY CARDS");
  });
  it("adds no card rules when overlays are off", () => {
    expect(buildPlanPrompt(chunk, undefined, undefined, "", false, "", "archive")).not.toContain("ARCHIVE DOCUMENTARY CARDS");
  });
});

describe("archive channel preset", () => {
  const ch = (over: Partial<Channel>): Channel =>
    ({ id: 1, name: "c", visual_mode: "mix", ai_style: null, visual_prompt: null, voice_id: null, voice_speed: null, voice_provider: null,
       character_reference_path: null, character_terms: null, api_keys_json: null, interval_sec: 10, format: "1920x1080", avatar_id: null,
       graphics_enabled: null, graphic_percent: null, graphic_theme: null, edit_style: null, anchor_dir: null, created_at: "", updated_at: "", ...over }) as Channel;
  it("adds no archive preset for a standard channel", () => {
    expect(channelSettingOverrides(ch({}))).toEqual({ AI_CHARACTER_REFERENCE_PATH: NO_CHARACTER_REFERENCE });
  });
  it("applies the whole preset + the anchor folder", () => {
    const o = channelSettingOverrides(ch({ edit_style: "archive", anchor_dir: "/x/anchors" }));
    expect(o).toMatchObject(ARCHIVE_STYLE_OVERRIDES);
    expect(o.ANCHOR_IMAGES_DIR).toBe("/x/anchors");
    expect(o.SCENE_TRANSITIONS).toBe("crossfade");
  });
});

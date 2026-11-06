import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Which runs get graphic beats: channel value first, the global setting second, OFF unless
 * one of them says on — and a run that gets none must not carry a `graphics` key at all.
 * Hermetic: the DB and settings are stubbed (no studio.db is touched).
 */
const settingsStub = vi.hoisted(() => ({ overrides: {} as Record<string, string> }));
vi.mock("./settings", () => ({
  getSetting: (k: string) => settingsStub.overrides[k] ?? "",
  isSecretKey: () => false,
  shortMask: (s: string) => s,
}));
vi.mock("./db", () => ({ default: { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }) } }));

import { resolveChannelGraphics, parseChannelGraphics, type Channel } from "./channels";

const ch = (g: Partial<Pick<Channel, "graphics_enabled" | "graphic_percent" | "graphic_theme">>) => ({ graphics_enabled: null, graphic_percent: null, graphic_theme: null, ...g }) as Channel;

afterEach(() => { settingsStub.overrides = {}; });

describe("resolveChannelGraphics", () => {
  it("is off by default (no channel, channel following the default)", () => {
    expect(resolveChannelGraphics(null)).toBeUndefined();
    expect(resolveChannelGraphics(ch({}))).toBeUndefined();
  });

  it("follows the global switch and its defaults when the channel says nothing", () => {
    settingsStub.overrides = { GRAPHICS_ENABLED: "1", GRAPHIC_BEAT_PERCENT: "60" };
    expect(resolveChannelGraphics(ch({}))).toEqual({ percent: 60, theme: "arden" });
    expect(resolveChannelGraphics(null)).toEqual({ percent: 60, theme: "arden" });
  });

  it("lets the channel turn it on or off over the global", () => {
    expect(resolveChannelGraphics(ch({ graphics_enabled: "1", graphic_percent: 70 }))).toEqual({ percent: 70, theme: "arden" });
    settingsStub.overrides = { GRAPHICS_ENABLED: "1" };
    expect(resolveChannelGraphics(ch({ graphics_enabled: "0" }))).toBeUndefined();
  });

  it("treats 0% as off", () => {
    expect(resolveChannelGraphics(ch({ graphics_enabled: "1", graphic_percent: 0 }))).toBeUndefined();
  });
});

describe("parseChannelGraphics", () => {
  it("absent stays absent (a save without the fields changes nothing)", () => {
    expect(parseChannelGraphics(undefined)).toBeUndefined();
  });
  it("reads the form", () => {
    expect(parseChannelGraphics({ enabled: true, percent: "65", theme: "arden" })).toEqual({ enabled: true, percent: 65, theme: "arden" });
    expect(parseChannelGraphics({ enabled: "yes" })).toEqual({ enabled: null, percent: null, theme: null });
  });
});

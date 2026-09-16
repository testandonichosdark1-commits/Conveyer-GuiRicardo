import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Consistency between the footage-source CHECKBOXES and the provider REGISTRY.
 *
 * These two lists are edited in different files and drift silently in a way that destroys
 * settings: footageList() keeps only ids present in the checkbox list and writeFootage()
 * saves that filtered list back, so a source the pipeline supports but the UI doesn't list
 * is erased from FOOTAGE_SOURCES the moment anyone toggles any other checkbox.
 */

vi.mock("../settings", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, getSetting: (k: string) => (k === "FOOTAGE_SOURCES" ? "pexels" : "") };
});
vi.mock("../logger", () => ({ log: () => {} }));

import { __testing } from "./visual-source";
import { DEFAULTS, SETTING_KEYS, isSecretKey } from "../settings";

const COMPONENT = join(process.cwd(), "src/app/settings/_components/FootageSources.tsx");
const source = readFileSync(COMPONENT, "utf8");

/** Ids as the checkbox list declares them, read from the component rather than imported —
 *  it is a client component, and parsing keeps React out of this test entirely. */
function checkboxIds(): string[] {
  const block = /const ALL_FOOTAGE[\s\S]*?\n\];/.exec(source)?.[0] ?? "";
  return [...block.matchAll(/id:\s*"([a-z0-9_-]+)"/g)].map((m) => m[1]);
}

describe("footage source registry", () => {
  it("finds the checkbox list", () => {
    expect(checkboxIds().length).toBeGreaterThan(5);
  });

  it("every checkbox maps to a real provider", () => {
    const providers = new Set(Object.keys(__testing.PROVIDERS));
    for (const id of checkboxIds()) {
      // youtube is the one source handled by its own branch rather than the registry.
      if (id === "youtube") continue;
      expect(providers, `checkbox "${id}" has no provider`).toContain(id);
    }
  });

  it("lists wigolo, so ticking another source cannot silently erase it", () => {
    expect(checkboxIds()).toContain("wigolo");
  });

  it("does NOT mark wigolo opt-in, so the fallback list matches the shipped defaults", () => {
    // Reversed 2026-08-11 with the default flip: the fallback stands in for "what this build
    // ships with", and excluding a default source there would silently plan without it on any
    // DB whose FOOTAGE_SOURCES holds only values this build doesn't know.
    expect(/id:\s*"wigolo"[^}]*optIn:\s*true/.test(source)).toBe(false);
  });
});

describe("wigolo settings wiring", () => {
  const KEYS = ["WIGOLO_URL", "WIGOLO_API_TOKEN", "WIGOLO_EXCLUDE_DOMAINS", "WIGOLO_MIN_PX", "WIGOLO_BIN"];

  it("registers every key, or POST /api/settings would silently drop it", () => {
    // The settings route ignores unknown keys (`if (!allowed.has(k)) continue`), so a key
    // missing here would appear to save and simply never persist.
    for (const k of KEYS) expect(SETTING_KEYS as readonly string[]).toContain(k);
  });

  it("seeds a default for every key", () => {
    for (const k of KEYS) expect(DEFAULTS).toHaveProperty(k);
  });

  it("ships wigolo ON in the default source list", () => {
    // Owner's decision, 2026-08-11. A fresh install plans WITH wigolo; existing installs are
    // brought along by _migration_wigolo_default_on, since DEFAULTS never revisit a seeded key.
    expect(DEFAULTS.FOOTAGE_SOURCES).toContain("wigolo");
  });

  it("treats the daemon token as a secret", () => {
    expect(isSecretKey("WIGOLO_API_TOKEN")).toBe(true);
    expect(isSecretKey("WIGOLO_URL")).toBe(false); // an address is not a secret
  });
});

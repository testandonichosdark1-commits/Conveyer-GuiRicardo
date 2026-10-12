import { describe, it, expect, vi, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regression for run f1abab6b (2026-10-12): beats 19 and 23 were delivered as exact copies of
 * beats 3 and 9, generated earlier in the same Flow window. A beat's result must be the tile
 * that is NEW in its project since the click, never an older tile, and never a picture some
 * other beat already received.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-new-tile-"));
process.env.FACELESS_STUDIO_DATA_DIR = dir;
vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

type Mod = typeof import("./flow-browser");
let mod: Mod;
beforeAll(async () => {
  mod = await import("./flow-browser");
});

const tile = (mediaId: string, caption = "") => ({ mediaId, caption, src: `https://flow-content.google/image/${mediaId}?sig=x` });

describe("pickNewFlowTile", () => {
  it("ignores every tile that was already in the project before the click", () => {
    const before = new Set(["beat3", "beat9"]);
    expect(mod.pickNewFlowTile([tile("beat3"), tile("beat9")], before, "baseboard heater and propane tank")).toBeNull();
  });

  it("returns the one tile that appeared after the click, wherever it sits in the grid", () => {
    const before = new Set(["beat3", "beat9"]);
    const picked = mod.pickNewFlowTile([tile("beat3"), tile("beat19"), tile("beat9")], before, "baseboard heater and propane tank");
    expect(picked?.mediaId).toBe("beat19");
  });

  it("never returns the uploaded character reference, which also shows up as a new tile", () => {
    // Live shape (2026-10-12): the upload's tile is captioned with its file name.
    const picked = mod.pickNewFlowTile(
      [tile("upload", "character-reference-78e3edc9.jpg"), tile("gen", "Electrician testing wires in attic")],
      new Set(),
      "A licensed electrician testing old wires inside a dusty attic"
    );
    expect(picked?.mediaId).toBe("gen");
    expect(mod.pickNewFlowTile([tile("upload", "character-reference-78e3edc9.jpg")], new Set(), "x")).toBeNull();
  });

  it("with two new tiles (Flow on x2), prefers the caption that matches the prompt", () => {
    const picked = mod.pickNewFlowTile(
      [tile("a", "Hands writing numbers next to a calculator"), tile("b", "Electric baseboard heater and propane tank")],
      new Set(),
      "A dual composition of a residential electric baseboard heater indoors and a propane storage tank outside"
    );
    expect(picked?.mediaId).toBe("b");
  });
});

describe("isDeliveredImage", () => {
  it("is false for a picture never used, and true once some beat received it", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#3a6" } }).png().toBuffer();
    expect(mod.isDeliveredImage(png)).toBe(false);
    // Delivering goes through attemptFlowImage's save(); exercise the same registry via a
    // persisted file the module reads, as a restarted app would.
    const crypto = await import("node:crypto");
    fs.writeFileSync(
      path.join(dir, "flow-delivered-images.json"),
      JSON.stringify({ ids: ["beat3"], hashes: [crypto.createHash("sha256").update(png).digest("hex")] })
    );
    vi.resetModules();
    const fresh = await import("./flow-browser");
    expect(fresh.isDeliveredImage(png)).toBe(true);
    // A tile already handed to a beat is never "new" again, even if it re-enters the DOM.
    expect(fresh.pickNewFlowTile([tile("beat3")], new Set(), "anything")).toBeNull();
  });
});

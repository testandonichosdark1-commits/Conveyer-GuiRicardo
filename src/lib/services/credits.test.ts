import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCredits, readCredits, creditFrom, type CreditEntry } from "./credits";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "credits-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf-8");

describe("creditFrom", () => {
  it("keeps the page and the file apart", () => {
    // These are different things and only one of them survives a licence question: the page
    // is where the terms live, the file is a CDN path that can move or vanish.
    const e = creditFrom(3, {
      kind: "image",
      provider: "wigolo",
      attribution: {
        sourceUrl: "https://example.org/photos/loris",
        url: "https://cdn.example.org/a/b/loris-1200.jpg",
        author: "A. Photographer",
        license: "Web (user responsibility)",
      },
    });
    expect(e).toEqual({
      beat: 3,
      kind: "image",
      provider: "wigolo",
      sourceUrl: "https://example.org/photos/loris",
      fileUrl: "https://cdn.example.org/a/b/loris-1200.jpg",
      author: "A. Photographer",
      license: "Web (user responsibility)",
    });
  });

  it("records an AI beat too, with no invented attribution", () => {
    // A missing line would be indistinguishable from a beat we failed to record.
    const e = creditFrom(1, { kind: "ai", provider: "kie:veo" });
    expect(e).toEqual({ beat: 1, kind: "ai", provider: "kie:veo" });
    expect("sourceUrl" in e).toBe(false);
  });
});

describe("writeCredits", () => {
  const entries: CreditEntry[] = [
    { beat: 2, kind: "image", provider: "wigolo", sourceUrl: "https://example.org/b" },
    { beat: 0, kind: "video", provider: "pexels", sourceUrl: "https://example.org/a", author: "Jo" },
  ];

  it("writes both files, sorted by beat", () => {
    writeCredits(dir, "run-1", entries);
    const json = JSON.parse(read("credits.json"));
    expect(json.version).toBe(1);
    expect(json.runId).toBe("run-1");
    expect(json.entries.map((e: CreditEntry) => e.beat)).toEqual([0, 2]);
    const txt = read("credits.txt");
    expect(txt.indexOf("#0")).toBeLessThan(txt.indexOf("#2"));
    expect(txt).toContain("https://example.org/a");
  });

  it("leaves no .tmp files behind", () => {
    writeCredits(dir, "run-1", entries);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("never throws when the directory is gone", () => {
    // Provenance is additive. A run that has already been paid for must not fail here.
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => writeCredits(dir, "run-1", entries)).not.toThrow();
  });

  it("marks a beat that shows another beat's shot", () => {
    writeCredits(dir, "run-1", [
      { beat: 0, kind: "image", provider: "wigolo", sourceUrl: "https://example.org/a" },
      { beat: 1, kind: "image", provider: "wigolo", sourceUrl: "https://example.org/a", reusedFromBeat: 0 },
    ]);
    expect(read("credits.txt")).toContain("#1 (same shot as #0)");
  });
});

describe("readCredits", () => {
  it("round-trips what was written", () => {
    writeCredits(dir, "run-1", [{ beat: 4, kind: "image", provider: "wikimedia", sourceUrl: "https://x/y" }]);
    const back = readCredits(dir);
    expect(back.get(4)?.sourceUrl).toBe("https://x/y");
  });

  it("treats a missing or corrupt file as empty, not as an error", () => {
    // Resume reads this before it knows whether a previous execution ever got that far.
    expect(readCredits(dir).size).toBe(0);
    fs.writeFileSync(path.join(dir, "credits.json"), "{ this is not json", "utf-8");
    expect(readCredits(dir).size).toBe(0);
    fs.writeFileSync(path.join(dir, "credits.json"), JSON.stringify({ version: 1 }), "utf-8");
    expect(readCredits(dir).size).toBe(0);
  });

  it("survives a resume that reuses on-disk clips", () => {
    // The point of reading it back: the second execution regenerates beat 1 only, and must
    // not blank out beat 0 just because it did no work for it.
    writeCredits(dir, "run-1", [
      { beat: 0, kind: "image", provider: "wigolo", sourceUrl: "https://example.org/a" },
      { beat: 1, kind: "ai", provider: "69labs" },
    ]);
    const seeded = readCredits(dir);
    seeded.set(1, { beat: 1, kind: "image", provider: "pexels", sourceUrl: "https://example.org/new" });
    writeCredits(dir, "run-1", [...seeded.values()]);
    const back = readCredits(dir);
    expect(back.get(0)?.sourceUrl).toBe("https://example.org/a");
    expect(back.get(1)?.provider).toBe("pexels");
  });
});

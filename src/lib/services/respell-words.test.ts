import { describe, expect, it } from "vitest";
import { respellFromScript } from "./respell-words";

const timed = (text: string) => text.split(" ").map((word, i) => ({ word, startMs: i * 300, endMs: i * 300 + 250 }));

describe("respellFromScript", () => {
  it("restores a name Whisper spelled by ear, keeping timings and punctuation", () => {
    const words = timed("In August 1940, Draper Kaufman had been born in San Diego.");
    const out = respellFromScript(words, "In August 1940, Draper Kauffman had been born in San Diego.");
    expect(out.map((w) => w.word).join(" ")).toBe("In August 1940, Draper Kauffman had been born in San Diego.");
    expect(out.map((w) => w.startMs)).toEqual(words.map((w) => w.startMs));
  });

  it("keeps Whisper's own token where the script says something different, not a misspelling", () => {
    const out = respellFromScript(timed("a 29-year-old American was let out"), "a twenty-nine-year-old American was let out");
    expect(out[1].word).toBe("29-year-old");
  });

  it("keeps Whisper's punctuation (it drives beat cuts)", () => {
    const out = respellFromScript(timed("met Courtnee. Then"), "met Courtney, then");
    expect(out[1].word).toBe("Courtney.");
  });

  it("stays aligned across inserted and dropped words", () => {
    const out = respellFromScript(
      timed("the frogmen and in time the Seels were born"),
      "the American frogmen, and in time the SEALs, were born"
    );
    expect(out.map((w) => w.word).join(" ")).toBe("the frogmen and in time the SEALs were born");
  });
});

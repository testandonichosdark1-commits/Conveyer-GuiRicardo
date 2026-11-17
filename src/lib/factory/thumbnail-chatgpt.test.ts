import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatGptThumbnailPrompt, readChatGptThumbnailSpec, ChatGptThumbnailError } from "./thumbnail-chatgpt";

const full =
  'Hyper-realistic daylight photograph, YouTube thumbnail composition. Two commandos paddle a canvas canoe beside a warship; an American officer on the right. Top-left stacked text: "TWO MEN?" in yellow, "ONE CANOE?" in white. A short thick red arrow points at the canoe. 16:9.';

describe("ChatGPT thumbnail spec", () => {
  it("reads the complete prompt and pins the exact words", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-"));
    const f = path.join(dir, "thumbnail.json");
    fs.writeFileSync(f, JSON.stringify({ fullPrompt: full, yellow: "TWO MEN?", white: "ONE CANOE?" }));
    const spec = readChatGptThumbnailSpec(f);
    const prompt = chatGptThumbnailPrompt(spec);
    expect(prompt.startsWith(full)).toBe(true);
    expect(prompt).toContain('exactly "TWO MEN?" and "ONE CANOE?"');
    expect(prompt).toContain("16:9");
  });

  it("refuses a package without the complete prompt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-"));
    const f = path.join(dir, "thumbnail.json");
    fs.writeFileSync(f, JSON.stringify({ prompt: "old base prompt only" }));
    expect(() => readChatGptThumbnailSpec(f)).toThrow(ChatGptThumbnailError);
    fs.writeFileSync(f, "{broken");
    expect(() => readChatGptThumbnailSpec(f)).toThrow(/not valid JSON/);
  });
});

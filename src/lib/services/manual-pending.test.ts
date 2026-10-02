import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ManualGenerationPendingError,
  appendManualPrompt,
  findManualFile,
  manualMediaDir,
  manualPromptsPath,
} from "./manual-pending";

const runDir = path.join(os.tmpdir(), `manual-pending-test-${process.pid}`);

beforeEach(() => {
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(runDir, { recursive: true, force: true });
});

describe("ManualGenerationPendingError", () => {
  it("names the beat in its message", () => {
    const e = new ManualGenerationPendingError(42);
    expect(e.message).toContain("42");
    expect(e.name).toBe("ManualGenerationPendingError");
  });
});

describe("findManualFile", () => {
  it("returns null when the manual folder doesn't exist yet", () => {
    expect(findManualFile(runDir, 7)).toBeNull();
  });

  it("returns null when the folder exists but has no file for this beat", () => {
    fs.mkdirSync(manualMediaDir(runDir), { recursive: true });
    fs.writeFileSync(path.join(manualMediaDir(runDir), "beat_0009.png"), "x");
    expect(findManualFile(runDir, 7)).toBeNull();
  });

  it("finds a beat's file regardless of extension", () => {
    fs.mkdirSync(manualMediaDir(runDir), { recursive: true });
    const p = path.join(manualMediaDir(runDir), "beat_0007.mp4");
    fs.writeFileSync(p, "x");
    expect(findManualFile(runDir, 7)).toBe(p);
  });

  it("never matches a different beat that merely shares a numeric prefix", () => {
    // beat_0007 must not match a lookup for beat 70 or beat 700
    fs.mkdirSync(manualMediaDir(runDir), { recursive: true });
    fs.writeFileSync(path.join(manualMediaDir(runDir), "beat_0007.png"), "x");
    expect(findManualFile(runDir, 70)).toBeNull();
    expect(findManualFile(runDir, 700)).toBeNull();
  });
});

describe("appendManualPrompt", () => {
  it("creates the prompts file with a header and the prompt text", () => {
    appendManualPrompt(runDir, { index: 3, media: "image", aspect: "16:9", prompt: "a red bicycle" });
    const body = fs.readFileSync(manualPromptsPath(runDir), "utf8");
    expect(body).toContain("Beat 0003");
    expect(body).toContain("image, 16:9");
    expect(body).toContain("a red bicycle");
  });

  it("includes duration for video entries but not image entries", () => {
    appendManualPrompt(runDir, { index: 1, media: "video", aspect: "9:16", durationSec: 8, prompt: "p" });
    appendManualPrompt(runDir, { index: 2, media: "image", aspect: "9:16", prompt: "p" });
    const body = fs.readFileSync(manualPromptsPath(runDir), "utf8");
    expect(body).toContain("video, 9:16, 8s");
    expect(body).toContain("image, 9:16)");
  });

  it("never duplicates the same beat across repeated calls (retries/resumes)", () => {
    appendManualPrompt(runDir, { index: 5, media: "image", aspect: "16:9", prompt: "first version" });
    appendManualPrompt(runDir, { index: 5, media: "image", aspect: "16:9", prompt: "first version" });
    appendManualPrompt(runDir, { index: 5, media: "image", aspect: "16:9", prompt: "first version" });
    const body = fs.readFileSync(manualPromptsPath(runDir), "utf8");
    expect(body.match(/Beat 0005/g)?.length).toBe(1);
  });

  it("appends a second beat's entry without disturbing the first", () => {
    appendManualPrompt(runDir, { index: 1, media: "image", aspect: "16:9", prompt: "one" });
    appendManualPrompt(runDir, { index: 2, media: "image", aspect: "16:9", prompt: "two" });
    const body = fs.readFileSync(manualPromptsPath(runDir), "utf8");
    expect(body).toContain("Beat 0001");
    expect(body).toContain("one");
    expect(body).toContain("Beat 0002");
    expect(body).toContain("two");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Regression guard for the cancellation audit fix: once a run is cancelled, NO
 * provider "create" call may reach the network. Each billable entry point must
 * throw CancelledError *before* it calls fetch. These tests mark a run cancelled,
 * stub global fetch with a spy, and assert (a) CancelledError is thrown and
 * (b) fetch was never invoked. If a future refactor moves a checkCancelled below
 * the create call, these fail loudly.
 */

// Keep settings hermetic — return benign non-empty values so key/model lookups
// don't hit the real DB or short-circuit before the cancel guard.
vi.mock("../settings", () => ({ getSetting: () => "test-value" }));

import { markCancelled, clearCancelled, CancelledError } from "../cancellation";
import { generateImageUrl, generateVideoUrl } from "./kie";
import { generateMagnificImageUrl } from "./magnific";
import { createTtsJob, createImageJob, createVideoJob } from "./labs69";
import { generateAvatarClip, type AvatarHandle } from "./heygen-video";
import { acquireVisual } from "./visual-source";

const RUN = "cancel-guard-run";
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("fetch must not be called for a cancelled run");
  });
  vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
  markCancelled(RUN);
});

afterEach(() => {
  clearCancelled(RUN);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function expectCancelledNoFetch(fn: () => Promise<unknown>) {
  await expect(fn()).rejects.toBeInstanceOf(CancelledError);
  expect(fetchSpy).not.toHaveBeenCalled();
}

describe("provider create calls abort a cancelled run before any fetch", () => {
  it("kie.ai nano-banana image", () => expectCancelledNoFetch(() => generateImageUrl(RUN, "prompt")));
  it("kie.ai Veo video", () => expectCancelledNoFetch(() => generateVideoUrl(RUN, "prompt")));
  it("Magnific Mystic image", () => expectCancelledNoFetch(() => generateMagnificImageUrl(RUN, "prompt")));

  it("69labs TTS job", () =>
    expectCancelledNoFetch(() => createTtsJob({ text: "hi", voiceId: "v", runId: RUN })));
  it("69labs image job", () =>
    expectCancelledNoFetch(() => createImageJob({ prompt: "p", runId: RUN })));
  it("69labs video job", () =>
    expectCancelledNoFetch(() => createVideoJob({ prompt: "p", runId: RUN })));

  it("HeyGen avatar clip", async () => {
    // generateAvatarClip checks the audio file exists first, then the cancel guard.
    const audio = path.join(os.tmpdir(), `cancel-guard-${process.pid}.mp3`);
    fs.writeFileSync(audio, Buffer.from([0]));
    const avatar: AvatarHandle = { engine: "talking_photo", heygenId: "tp_1" };
    try {
      await expectCancelledNoFetch(() =>
        generateAvatarClip(RUN, avatar, audio, path.join(os.tmpdir(), "out.mp4"))
      );
    } finally {
      fs.rmSync(audio, { force: true });
    }
  });
});

describe("studio beat thunk aborts a cancelled run before any provider work", () => {
  it("acquireVisual throws at entry", () => {
    // Minimal beat; the entry guard runs before any stock search or AI generate.
    const beat = { index: 0, startMs: 0, endMs: 4000, source: "real", layout: "broll" } as never;
    return expectCancelledNoFetch(() => acquireVisual(RUN, beat, path.join(os.tmpdir(), "b.mp4"), new Set()));
  });
});

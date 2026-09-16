import { beforeEach, describe, expect, it } from "vitest";
import {
  beforeVisionCall,
  isVisionAvailabilityFailure,
  noteVisionFailure,
  noteVisionSuccess,
  resetVisionCircuit,
  VISION_CIRCUIT,
} from "./vision-circuit";

describe("Gemini Vision circuit breaker", () => {
  beforeEach(() => resetVisionCircuit());

  it("opens after 5 availability failures within the last 10 attempts", () => {
    const run = "r1";
    for (let i = 0; i < 4; i++) {
      expect(noteVisionFailure(run, "Gemini timeout after 30s", false, i)?.transition).toBeUndefined();
      noteVisionSuccess(run);
    }
    const opened = noteVisionFailure(run, "Gemini 503: overloaded", false, 100);
    expect(opened?.transition).toBe("open");
    expect(beforeVisionCall(run, 101).allow).toBe(false);
  });

  it("does not count malformed content or ordinary validation errors as outages", () => {
    const run = "r2";
    for (let i = 0; i < 8; i++) noteVisionFailure(run, "empty response (finishReason=STOP)", false, i);
    expect(beforeVisionCall(run, 100).allow).toBe(true);
  });

  it("admits one half-open probe after 60 seconds and blocks concurrent probes", () => {
    const run = "r3";
    for (let i = 0; i < VISION_CIRCUIT.failureThreshold; i++) noteVisionFailure(run, "Gemini 503: busy", false, i);
    const t = VISION_CIRCUIT.openMs + 10;
    const probe = beforeVisionCall(run, t);
    expect(probe.allow).toBe(true);
    expect(probe.probe).toBe(true);
    expect(probe.transition).toBe("half-open");
    expect(beforeVisionCall(run, t + 1).allow).toBe(false);
  });

  it("closes on a successful half-open probe", () => {
    const run = "r4";
    for (let i = 0; i < 5; i++) noteVisionFailure(run, "Gemini 429: rate limited", false, i);
    beforeVisionCall(run, 60_100);
    expect(noteVisionSuccess(run, true).transition).toBe("closed");
    expect(beforeVisionCall(run, 60_101).allow).toBe(true);
  });

  it("reopens immediately when the half-open probe fails", () => {
    const run = "r5";
    for (let i = 0; i < 5; i++) noteVisionFailure(run, "Gemini 503: busy", false, i);
    beforeVisionCall(run, 60_100);
    const update = noteVisionFailure(run, "Gemini timeout after 30s", true, 60_101);
    expect(update?.transition).toBe("reopened");
    expect(beforeVisionCall(run, 60_102).allow).toBe(false);
  });

  it("recognizes only availability failures", () => {
    expect(isVisionAvailabilityFailure("Gemini 503: busy")).toBe(true);
    expect(isVisionAvailabilityFailure("Gemini 429: rate limited")).toBe(true);
    expect(isVisionAvailabilityFailure("Gemini timeout after 30s")).toBe(true);
    expect(isVisionAvailabilityFailure("fetch failed: ECONNRESET")).toBe(true);
    expect(isVisionAvailabilityFailure("Gemini 400: bad request")).toBe(false);
    expect(isVisionAvailabilityFailure("empty response")).toBe(false);
  });
});

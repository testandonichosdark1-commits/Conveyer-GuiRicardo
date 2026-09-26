import { describe, it, expect } from "vitest";
import { withPresubmitDeadline, FlowBrowserError } from "./flow-browser";

describe("withPresubmitDeadline", () => {
  it("returns the value of a step that finishes in time", async () => {
    await expect(withPresubmitDeadline("x", async () => 7, 200)).resolves.toBe(7);
  });

  it("names the stalled step and marks it stalled when the step never returns", async () => {
    const err = await withPresubmitDeadline("switch to video mode", () => new Promise<never>(() => {}), 30).catch((e) => e);
    expect(err).toBeInstanceOf(FlowBrowserError);
    expect(err.stalled).toBe(true);
    expect(err.code).toBe("timeout");
    expect(err.message).toContain("switch to video mode");
  });

  it("passes a real failure through untouched (not stalled)", async () => {
    const boom = new FlowBrowserError("no credits", "credits");
    const err = await withPresubmitDeadline("x", async () => { throw boom; }, 200).catch((e) => e);
    expect(err).toBe(boom);
    expect(err.stalled).toBe(false);
  });

  it("does not raise an unhandled rejection when a late step fails after the deadline", async () => {
    const err = await withPresubmitDeadline("x", () => new Promise<never>((_, rej) => setTimeout(() => rej(new Error("late")), 60)), 20).catch((e) => e);
    expect(err.stalled).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
  });
});

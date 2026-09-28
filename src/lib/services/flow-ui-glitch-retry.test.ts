import { describe, it, expect, vi } from "vitest";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { isPresubmitUiGlitch } from "./flow-browser";

/**
 * The boundary that decides whether a composer-setup failure gets a free reload-and-retry
 * (attemptFlowImage). Only "ui" — a mode-switch/prompt-box/reference-attach failure that
 * happens strictly BEFORE a prompt is submitted, so a retry spends nothing. Everything else
 * must stay excluded: "timeout" fires AFTER submit, where a real generation may already have
 * consumed the account's usage allowance even though capture failed, so retrying it would
 * risk a silent double-spend — pinned here so a future edit can't casually widen this to
 * "any FlowBrowserError" and reintroduce that risk.
 */
describe("isPresubmitUiGlitch", () => {
  it("retries a pre-submit UI failure (mode switch / prompt box / reference attach)", () => {
    expect(isPresubmitUiGlitch("ui")).toBe(true);
  });

  it("never retries a post-submit timeout — a generation may already be spent", () => {
    expect(isPresubmitUiGlitch("timeout")).toBe(false);
  });

  it("never retries a real account state a reload cannot change", () => {
    expect(isPresubmitUiGlitch("credits")).toBe(false);
    expect(isPresubmitUiGlitch("policy")).toBe(false);
  });

  it("never retries what needs the operator, not a reload", () => {
    expect(isPresubmitUiGlitch("login")).toBe(false);
    expect(isPresubmitUiGlitch("config")).toBe(false);
  });

  it("never retries a capture failure (also post-submit)", () => {
    expect(isPresubmitUiGlitch("capture")).toBe(false);
  });

  it("is false for undefined (a non-FlowBrowserError)", () => {
    expect(isPresubmitUiGlitch(undefined)).toBe(false);
  });
});

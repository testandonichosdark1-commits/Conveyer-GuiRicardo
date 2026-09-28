import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Preventive tab recycling — the middle ground between never reloading (measured: three
 * different UI-detection errors within 33s after ~1h40 of continuous use of one Flow tab)
 * and reloading before every single generation. `FLOW_TAB_RECYCLE_EVERY` counts generations
 * (image + video, success or failure) and forces one reload before the Nth, then resets.
 *
 * The counter lives in a module-global (the tab itself is global, not per-run — see
 * FlowBrowserState). `vi.resetModules()` + a fresh dynamic import per test is what actually
 * resets it: the module reads `globalThis.__facelessFlowBrowserState` only ONCE, at import
 * time, so mutating that global afterward does nothing to an already-imported module's
 * closed-over state — only a fresh import re-reads it.
 */
let recycleEvery = "3";
vi.mock("../settings", () => ({ getSetting: (key: string) => (key === "FLOW_TAB_RECYCLE_EVERY" ? recycleEvery : "") }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

function fakePage(): { page: import("playwright").Page; calls: string[] } {
  const calls: string[] = [];
  const page = {
    reload: async () => { calls.push("reload"); },
    waitForTimeout: async () => { calls.push("wait"); },
  } as unknown as import("playwright").Page;
  return { page, calls };
}

describe("maybeRecycleFlowTab", () => {
  let maybeRecycleFlowTab: typeof import("./flow-browser").maybeRecycleFlowTab;

  beforeEach(async () => {
    recycleEvery = "3";
    delete (globalThis as Record<string, unknown>).__facelessFlowBrowserState;
    vi.resetModules();
    ({ maybeRecycleFlowTab } = await import("./flow-browser"));
  });

  it("does not reload before the configured count is reached", async () => {
    const { page, calls } = fakePage();
    await maybeRecycleFlowTab(page, "run");
    await maybeRecycleFlowTab(page, "run");
    expect(calls).toEqual([]);
  });

  it("reloads on the Nth generation, then resets the counter", async () => {
    const { page, calls } = fakePage();
    await maybeRecycleFlowTab(page, "run"); // 1
    await maybeRecycleFlowTab(page, "run"); // 2
    await maybeRecycleFlowTab(page, "run"); // 3 -> reload
    expect(calls).toEqual(["reload", "wait"]);

    calls.length = 0;
    await maybeRecycleFlowTab(page, "run"); // 1 again
    await maybeRecycleFlowTab(page, "run"); // 2 again
    expect(calls).toEqual([]);
    await maybeRecycleFlowTab(page, "run"); // 3 again -> reload
    expect(calls).toEqual(["reload", "wait"]);
  });

  it("is disabled by 0", async () => {
    recycleEvery = "0";
    delete (globalThis as Record<string, unknown>).__facelessFlowBrowserState;
    vi.resetModules();
    ({ maybeRecycleFlowTab } = await import("./flow-browser"));
    const { page, calls } = fakePage();
    for (let i = 0; i < 10; i++) await maybeRecycleFlowTab(page, "run");
    expect(calls).toEqual([]);
  });

  it("falls back to a positive default on a blank setting, not to 0/disabled", async () => {
    recycleEvery = "";
    delete (globalThis as Record<string, unknown>).__facelessFlowBrowserState;
    vi.resetModules();
    ({ maybeRecycleFlowTab } = await import("./flow-browser"));
    const { page, calls } = fakePage();
    // A blank DB value must still recycle SOMETIMES — Number("") is 0, and `|| "20"` is
    // what stops a blank setting from silently reading as "disabled" (0 <= 0 is the
    // disabled check). Pinned so the fallback can't quietly regress to Number(blank).
    for (let i = 0; i < 20; i++) await maybeRecycleFlowTab(page, "run");
    expect(calls.filter((c: string) => c === "reload").length).toBeGreaterThan(0);
  });
});

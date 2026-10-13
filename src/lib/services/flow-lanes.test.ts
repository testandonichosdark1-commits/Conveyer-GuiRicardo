import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Parallel Flow lanes — one Chrome window per configured Flow project (FLOW_PROJECT_URL, _2, _3).
 * What must hold for the video to come out right:
 *  - a duplicate/invalid extra link never becomes a second lane on the same project (two lanes on
 *    one project could take each other's image), and link 1 keeps its old validation;
 *  - with N lanes at most N generations run at once, and NEVER two in the same lane;
 *  - one link alone behaves exactly like the old single queue (strictly one at a time);
 *  - a lane that keeps failing on its own is set aside while another lane is healthy.
 */
const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (key: string) => settings[key] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

type Mod = typeof import("./flow-browser");
let mod: Mod;

const P1 = "https://labs.google/fx/tools/flow/project/aaa";
const P2 = "https://labs.google/fx/tools/flow/project/bbb";
const P3 = "https://labs.google/fx/tools/flow/project/ccc";
const P = (n: number) => `https://labs.google/fx/tools/flow/project/extra${n}`;

async function fresh(urls: string[]): Promise<void> {
  for (const k of Object.keys(settings)) delete settings[k];
  settings.FLOW_PROJECT_URL = urls[0];
  settings.FLOW_PROJECT_URL_2 = urls[1] ?? "";
  settings.FLOW_PROJECT_URL_3 = urls[2] ?? "";
  settings.FLOW_PROJECT_URL_4 = urls[3] ?? "";
  settings.FLOW_PROJECT_URL_5 = urls[4] ?? "";
  settings.FLOW_PROJECT_URL_6 = urls[5] ?? "";
  delete (globalThis as Record<string, unknown>).__facelessFlowBrowserState;
  vi.resetModules();
  mod = await import("./flow-browser");
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("flowProjectUrls", () => {
  beforeEach(() => fresh([P1]));

  it("returns only link 1 when 2 and 3 are blank", () => {
    expect(mod.flowProjectUrls()).toEqual([P1]);
    expect(mod.flowLaneCount()).toBe(1);
  });

  it("returns all three distinct projects in order", async () => {
    await fresh([P1, P2, P3]);
    expect(mod.flowProjectUrls()).toEqual([P1, P2, P3]);
    expect(mod.flowLaneCount()).toBe(3);
  });

  it("ignores a duplicate project, even with a trailing slash or query string", async () => {
    await fresh([P1, `${P1}/?x=1`, P2]);
    expect(mod.flowProjectUrls()).toEqual([P1, P2]);
  });

  it("skips an invalid or non-Google extra link instead of failing the run", async () => {
    await fresh([P1, "not a url", "https://example.com/project/zzz"]);
    expect(mod.flowProjectUrls()).toEqual([P1]);
  });

  it("still fails loud when link 1 is empty or not Flow", async () => {
    await fresh(["", P2]);
    expect(() => mod.flowProjectUrls()).toThrow(/FLOW_PROJECT_URL is empty/);
    expect(mod.flowLaneCount()).toBe(1);
    await fresh(["https://example.com/x"]);
    expect(() => mod.flowProjectUrls()).toThrow(/must point to Google Flow/);
  });
});

describe("lane scheduler", () => {
  it("runs up to 3 tasks at once with 3 links, each in a different lane, never two in one lane", async () => {
    await fresh([P1, P2, P3]);
    const { enqueue, currentLaneIndex } = mod.__laneTesting;
    const running = new Map<number, number>(); // lane -> tasks currently inside it
    let peak = 0;
    let inFlight = 0;
    const gates: Array<() => void> = [];
    const task = () =>
      enqueue(async () => {
        const lane = currentLaneIndex()!;
        running.set(lane, (running.get(lane) ?? 0) + 1);
        expect(running.get(lane)).toBe(1);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => gates.push(r));
        inFlight--;
        running.set(lane, running.get(lane)! - 1);
        return lane;
      });
    const all = Array.from({ length: 7 }, task);
    await tick();
    expect(inFlight).toBe(3); // the 4th..7th wait for a free window
    while (gates.length) {
      gates.shift()!();
      await tick();
    }
    const lanesUsed = await Promise.all(all);
    expect(peak).toBe(3);
    expect(new Set(lanesUsed)).toEqual(new Set([0, 1, 2]));
  });

  it("runs up to 6 tasks at once with 6 links, never two in one lane", async () => {
    await fresh([P1, P2, P3, P(4), P(5), P(6)]);
    expect(mod.flowLaneCount()).toBe(6);
    const { enqueue, currentLaneIndex } = mod.__laneTesting;
    const busy = new Set<number>();
    let peak = 0;
    const gates: Array<() => void> = [];
    const all = Array.from({ length: 10 }, () =>
      enqueue(async () => {
        const lane = currentLaneIndex()!;
        expect(busy.has(lane)).toBe(false);
        busy.add(lane);
        peak = Math.max(peak, busy.size);
        await new Promise<void>((r) => gates.push(r));
        busy.delete(lane);
        return lane;
      })
    );
    await tick();
    expect(busy.size).toBe(6);
    while (gates.length) {
      gates.shift()!();
      await tick();
    }
    const used = await Promise.all(all);
    expect(peak).toBe(6);
    expect(new Set(used).size).toBe(6);
  });

  it("with one link stays strictly one at a time (the old behaviour)", async () => {
    await fresh([P1]);
    const { enqueue } = mod.__laneTesting;
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        enqueue(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await tick();
          inFlight--;
        })
      )
    );
    expect(peak).toBe(1);
  });

  it("releases the lane when a task throws", async () => {
    await fresh([P1]);
    const { enqueue } = mod.__laneTesting;
    await expect(enqueue(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(enqueue(async () => "ok")).resolves.toBe("ok");
  });

  it("sets a repeatedly failing lane aside while another lane is healthy", async () => {
    await fresh([P1, P2]);
    const { enqueue, lanes } = mod.__laneTesting;
    const uiError = () => new mod.FlowBrowserError("could not switch", "ui");
    for (let i = 0; i < 3; i++) {
      await expect(enqueue(async () => { throw uiError(); }, "", 1)).rejects.toThrow();
    }
    expect(lanes()[1].disabledUntil).toBeGreaterThan(Date.now());
    // New work avoids lane 1 now.
    const used = await Promise.all([0, 1, 2].map(() => enqueue(async () => mod.__laneTesting.currentLaneIndex())));
    expect(used.every((l) => l === 0)).toBe(true);
  });

  it("does not count account-wide or content failures against a lane", async () => {
    await fresh([P1, P2]);
    const { enqueue, lanes } = mod.__laneTesting;
    for (const code of ["credits", "policy", "login"] as const) {
      for (let i = 0; i < 3; i++) {
        await expect(enqueue(async () => { throw new mod.FlowBrowserError(code, code); }, "", 1)).rejects.toThrow();
      }
    }
    expect(lanes()[1].disabledUntil).toBe(0);
  });
});

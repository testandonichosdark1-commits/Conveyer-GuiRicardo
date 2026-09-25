import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { flowInsufficientCreditsWarning } from "./flow-browser";

/**
 * Live DOM (2026-09-25): when the account cannot pay for a generation, Flow swaps the arrow submit
 * button for `<button class="prompt-warning-button" aria-label="Alerta de créditos insuficientes">`
 * and creates NO failure card. Skipped where no Chrome is installed.
 */
const CHROME = [
  process.env.FLOW_BROWSER_EXECUTABLE || "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && fs.existsSync(p));

let browser: Browser;
let page: Page;
beforeAll(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage();
}, 30_000);
afterAll(async () => { await browser?.close(); }, 20_000);

describe.skipIf(!CHROME)("flowInsufficientCreditsWarning", () => {
  it("sees the red warning button by its class, and by its localized label", async () => {
    await page.setContent(`<button class="prompt-warning-button">info</button>`);
    expect(await flowInsufficientCreditsWarning(page)).toBe(true);
    await page.setContent(`<button aria-label="Alerta de créditos insuficientes">info</button>`);
    expect(await flowInsufficientCreditsWarning(page)).toBe(true);
  }, 15_000);

  it("stays false with the normal submit arrow", async () => {
    await page.setContent(`<button aria-label="Iniciar geração">arrow_forward</button>`);
    expect(await flowInsufficientCreditsWarning(page)).toBe(false);
  }, 15_000);
});

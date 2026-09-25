import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { ensureFlowAspectRatio } from "./flow-browser";

/**
 * Drives ensureFlowAspectRatio in real headless Chrome against a mock of the live Video-mode
 * panel (screenshot, 2026-09-24): "16:9" and "9:16" render as two SIBLING toggle buttons at
 * once, not one label naming the active choice. The old implementation checked "is the wanted
 * ratio's text visible anywhere" as its FIRST test — which is true for BOTH ratios simultaneously
 * here, so it reported success without ever clicking, and a beat asking for 9:16 could silently
 * render at whichever ratio the tab already had active. This proves the fix always clicks the
 * button that NAMES the wanted ratio instead of trusting bare text visibility.
 */
const CHROME = [
  process.env.FLOW_BROWSER_EXECUTABLE || "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && fs.existsSync(p));

const HTML = (active: "16:9" | "9:16") => `
<button id="w" aria-pressed="${active === "16:9"}">16:9</button>
<button id="p" aria-pressed="${active === "9:16"}">9:16</button>
<div id="active">${active}</div>
<script>(() => {
  document.getElementById("w").onclick = () => { document.getElementById("active").textContent = "16:9"; };
  document.getElementById("p").onclick = () => { document.getElementById("active").textContent = "9:16"; };
})();</script>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!CHROME)("ensureFlowAspectRatio — two ratio buttons visible at once", () => {
  it("clicks 9:16 even though '16:9' text is ALSO on screen (the bug this fixes)", async () => {
    await page.setContent(HTML("16:9"));
    expect(await ensureFlowAspectRatio(page, "9:16")).toBe(true);
    expect(await page.locator("#active").innerText()).toBe("9:16");
  }, 15_000);

  it("clicking the already-active ratio is a harmless no-op", async () => {
    await page.setContent(HTML("16:9"));
    expect(await ensureFlowAspectRatio(page, "16:9")).toBe(true);
    expect(await page.locator("#active").innerText()).toBe("16:9");
  }, 15_000);

  it("an invalid ratio string is rejected without touching the page", async () => {
    await page.setContent(HTML("16:9"));
    expect(await ensureFlowAspectRatio(page, "square")).toBe(false);
    expect(await page.locator("#active").innerText()).toBe("16:9");
  }, 15_000);
});

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { generateButton } from "./flow-browser";

/**
 * Live bug (2026-09-25): a grid tile whose auto-generated title contains "run"/"make"/"send"/"create"
 * ("Water droplets RUNning down glass") is a `div[role=button]` whose accessible name matched the old
 * submit-button pattern, while the real pt-BR arrow ("Iniciar geração") matched nothing. The app clicked
 * the tile, nothing was submitted, and every later beat failed. Skipped where no Chrome is installed.
 */
const CHROME = [
  process.env.FLOW_BROWSER_EXECUTABLE || "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && fs.existsSync(p));

const TILE = `<div role="button" tabindex="0" class="footer-left"><span>image</span> Water droplets running down glass</div>
<div role="button" tabindex="0" class="footer-left"><span>image</span> Make a cleaning checklist</div>`;
const ARROW = `<button id="go" aria-label="Iniciar geração" class="generate-icon-button"><mat-icon>arrow_forward</mat-icon></button>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage();
}, 30_000);
afterAll(async () => { await browser?.close(); }, 20_000);

describe.skipIf(!CHROME)("generateButton — never picks a grid tile", () => {
  it("returns the submit arrow even when tiles named 'running…' / 'Make…' come first in the DOM", async () => {
    await page.setContent(`${TILE}${ARROW}`);
    const btn = await generateButton(page);
    expect(btn).not.toBeNull();
    expect(await btn!.getAttribute("id")).toBe("go");
  }, 20_000);

  it("finds the arrow by its icon alone when the class and label are absent", async () => {
    await page.setContent(`${TILE}<button id="go"><mat-icon>arrow_forward</mat-icon></button>`);
    const btn = await generateButton(page);
    expect(await btn!.getAttribute("id")).toBe("go");
  }, 20_000);

  it("with only tiles on the page there is NO button (caller falls back to Enter, never clicks a tile)", async () => {
    await page.setContent(TILE);
    const t0 = Date.now();
    expect(await generateButton(page)).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(11_000);
  }, 30_000);
});

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { pageHasLoginPrompt } from "./flow-browser";

/**
 * Regression for run f1abab6b (2026-10-12): beat 29's prompt "Lawrence Berkeley National
 * Laboratory sign in front of a … facility" is shown on the Flow page, and the login check
 * read its "sign in" as a logged-out prompt — every attempt and every Resume died at that beat.
 * A real login prompt is a control whose WHOLE label is the phrase. Real headless Chrome;
 * skipped where Chrome is not installed.
 */
const CHROME = [
  process.env.FLOW_BROWSER_EXECUTABLE || "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && fs.existsSync(p));

describe.skipIf(!CHROME)("pageHasLoginPrompt", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("does not treat a prompt or caption containing 'sign in' as a logout", async () => {
    await page.setContent(`
      <textarea>Lawrence Berkeley National Laboratory sign in front of a modern scientific research facility</textarea>
      <div aria-label="Lawrence Berkeley National Laboratory sign in front of a research building">
        <span>Lawrence Berkeley National Laboratory sign in front of a research building</span>
      </div>
      <p>Metal road sign indicating elevation</p>
      <button aria-label="Gatilho de configurações">🍌 Nano Banana 2.1</button>`);
    expect(await pageHasLoginPrompt(page)).toBe(false);
  });

  it("still detects a real sign-in button", async () => {
    await page.setContent(`<header><button>Fazer login</button></header>`);
    expect(await pageHasLoginPrompt(page)).toBe(true);
  }, 30_000);

  it("still detects a real English sign-in link", async () => {
    await page.setContent(`<a href="/signin">Sign in</a>`);
    expect(await pageHasLoginPrompt(page)).toBe(true);
  }, 30_000);
});

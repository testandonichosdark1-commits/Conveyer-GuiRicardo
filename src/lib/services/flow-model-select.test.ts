import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { selectModelViaComposer } from "./flow-browser";

/**
 * Drives selectModelViaComposer in a REAL headless Chrome against a mock page that mirrors
 * the structure read from the live Flow DOM (2026-09-23): localized aria-labels, Material
 * icon ligatures leaking into innerText, and the two-click chip -> family-select -> menuitem
 * flow. It proves the locator/wait/verify logic, NOT that Google hasn't changed its markup —
 * if Flow's DOM moves, this stays green while the real run fails; re-inspect the live page.
 * Skipped automatically where no Chrome is installed.
 */
const CHROME = [
  process.env.FLOW_BROWSER_EXECUTABLE || "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && fs.existsSync(p));

// Mirrors the structure read from the live Flow DOM: chip (localized aria-label, ligature
// text), popover with a family-select (aria-haspopup=menu) + a role=menu of menuitems.
const HTML = (initial: string, withChip = true) => `
<div>Person cleaning cluttered bathroom</div>
<div id="popover" style="display:none">
  <div id="menu" role="menu" style="display:none">
    <button role="menuitem">🍌 Nano Banana Pro</button>
    <button role="menuitem">🍌 Nano Banana 2</button>
    <button role="menuitem">🍌 Nano Banana 2 Lite</button>
  </div>
  <button id="sel" aria-label="Selecionar família de modelos" aria-haspopup="menu" aria-expanded="false">🍌 <span class="m">${initial}</span><br>arrow_drop_down</button>
  <button>x1</button><button>x2</button>
</div>
${withChip ? `<button id="chip" aria-label="Gatilho de configurações">🍌 <span class="m">${initial}</span><br>crop_16_9<br>x1</button>` : ""}
<script>(() => {
  const pop = document.getElementById("popover"), menu = document.getElementById("menu"), sel = document.getElementById("sel");
  const chip = document.getElementById("chip");
  const setModel = (t) => document.querySelectorAll(".m").forEach((e) => (e.textContent = t));
  if (chip) chip.onclick = () => { pop.style.display = pop.style.display === "none" ? "block" : "none"; };
  sel.onclick = () => { const open = menu.style.display === "none"; menu.style.display = open ? "block" : "none"; sel.setAttribute("aria-expanded", String(open)); };
  menu.querySelectorAll("[role=menuitem]").forEach((b) => (b.onclick = () => { setModel(b.textContent.replace("🍌", "").trim()); menu.style.display = "none"; sel.setAttribute("aria-expanded", "false"); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { pop.style.display = "none"; menu.style.display = "none"; sel.setAttribute("aria-expanded", "false"); } });
})();</script>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage();
}, 30_000);
afterAll(async () => { await browser?.close(); });

const chipText = () => page.locator("#chip").innerText();
const FAM = /Nano Banana/i;

describe.skipIf(!CHROME)("selectModelViaComposer against a structural mock of the live Flow DOM", () => {
  it("switches 2 -> Pro through the two-click flow and confirms it on the chip", async () => {
    await page.setContent(HTML("Nano Banana 2"));
    const seen: string[] = [];
    expect(await selectModelViaComposer(page, "nano banana pro", FAM, seen)).toBe("ok");
    expect(await chipText()).toContain("Nano Banana Pro");
  }, 20_000);

  it("switches Pro -> 2 (the fallback direction)", async () => {
    await page.setContent(HTML("Nano Banana Pro"));
    expect(await selectModelViaComposer(page, "nano banana 2", FAM, [])).toBe("ok");
    expect(await chipText()).toContain("Nano Banana 2");
    expect(await chipText()).not.toContain("Pro");
  }, 20_000);

  it("does not open anything when the wanted model is already active", async () => {
    await page.setContent(HTML("Nano Banana 2"));
    expect(await selectModelViaComposer(page, "nano banana 2", FAM, [])).toBe("ok");
    expect(await page.locator("#popover").isVisible()).toBe(false);
  }, 20_000);

  it("does not mistake 'Nano Banana 2 Lite' for 'Nano Banana 2'", async () => {
    await page.setContent(HTML("Nano Banana 2 Lite"));
    expect(await selectModelViaComposer(page, "nano banana 2", FAM, [])).toBe("ok");
    expect((await chipText()).replace(/\s+/g, " ")).toMatch(/Nano Banana 2 crop_16_9/);
  }, 20_000);

  it("fails closed for a tier that does not exist, and reports what it saw", async () => {
    await page.setContent(HTML("Nano Banana 2"));
    const seen: string[] = [];
    expect(await selectModelViaComposer(page, "nano banana ultra", FAM, seen)).toBe("failed");
    expect(seen.join(" | ")).toContain("Nano Banana Pro");
    expect(await page.locator("#popover").isVisible()).toBe(false); // left clean
    expect(await chipText()).toContain("Nano Banana 2"); // untouched
  }, 20_000);

  it("reports no-chip when the layout has no composer chip", async () => {
    await page.setContent(HTML("Nano Banana 2", false));
    expect(await selectModelViaComposer(page, "nano banana pro", FAM, [])).toBe("no-chip");
  }, 20_000);

  it("recovers when a previous attempt left the popover open", async () => {
    await page.setContent(HTML("Nano Banana 2"));
    await page.locator("#chip").click();
    expect(await page.locator("#popover").isVisible()).toBe(true);
    expect(await selectModelViaComposer(page, "nano banana pro", FAM, [])).toBe("ok");
    expect(await chipText()).toContain("Nano Banana Pro");
  }, 20_000);
});

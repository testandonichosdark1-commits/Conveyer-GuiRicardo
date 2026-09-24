import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { chromium, type Browser, type Page } from "playwright";

vi.mock("../settings", () => ({ getSetting: () => "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));

import { attachFlowReferenceViaAssetPicker, prepareComposerReference, FlowBrowserError } from "./flow-browser";

/**
 * Drives the reference-attach flow in REAL headless Chrome against a mock that mirrors what
 * was read off the live Flow DOM (2026-09-24, pt-BR account), in BOTH layouts Flow renders:
 *   compact: "+" opens a `role=dialog` ("Adicionar recursos ao projeto") whose upload button is
 *            labeled "Enviar mídia";
 *   wide:    "+" opens an inline `flow-add-menu-popover-content`, no dialog, and the upload
 *            button has NO aria-label — only the text "uploadEnviar mídia" (icon glued to the label).
 * In both, the list is `flow-add-menu-asset-list` → `[role=option]` (first line = file name),
 * clicking a row attaches it and closes the picker, and the attachment shows as a
 * `button[aria-label="Elemento"]` chip containing `img[alt="Imagem do elemento"]` that removes
 * itself when clicked. It proves the select/upload/confirm/clear LOGIC — not that Google hasn't
 * moved the markup; re-inspect the live page if a run reports this path failing.
 * Skipped automatically where no Chrome is installed.
 */
const CHROME = [
  process.env.FLOW_BROWSER_EXECUTABLE || "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && fs.existsSync(p));

interface MockOpts {
  layout?: "wide" | "compact";
  autoAttach?: boolean;
  existing?: string[];
  withPlus?: boolean;
  opensPicker?: boolean;
  withUpload?: boolean;
  chooserFires?: boolean;
  stickyChip?: boolean;
  startAttached?: boolean;
}

const HTML = (o: MockOpts = {}) => {
  const { layout = "wide", autoAttach = false, existing = ["ai-character-reference.jpg", "character-reference.jpg", "character-reference.jpg"],
    withPlus = true, opensPicker = true, withUpload = true, chooserFires = true, stickyChip = false, startAttached = false } = o;
  const rows = existing.map((n) => `<button role="option" data-name="${n}">${n}<br>Imagem</button>`).join("");
  const upload = withUpload
    ? layout === "compact" ? `<button data-upload aria-label="Enviar mídia"><span>upload</span></button>` : `<button data-upload class="sidebar-upload-btn"><span>upload</span>Enviar mídia</button>`
    : "";
  const list = `<flow-add-menu-asset-list><div role="listbox" aria-label="Lista de recursos">${rows}</div></flow-add-menu-asset-list>`;
  const picker = layout === "compact"
    ? `<div role="dialog" aria-label="Adicionar recursos ao projeto" class="mobile-overlay" data-picker style="display:none">${list}${upload}</div>`
    : `<flow-add-menu-popover-content data-picker style="display:none"><div role="tablist"><button role="tab">Tudo</button></div>${list}${upload}</flow-add-menu-popover-content>`;
  return `
<style>flow-add-menu-asset-list, flow-add-menu-popover-content { display:block }</style>
<textarea id="prompt"></textarea>
<div id="chips"></div>
${withPlus ? `<button aria-label="Adicionar elementos à caixa de comando">add</button>` : ""}
${picker}
<input type="file" id="fi" style="display:none" />
<script>(() => {
  const pick = document.querySelector('[data-picker]'), list = document.querySelector('[role=listbox]');
  const plus = document.querySelector('button[aria-label*="Adicionar elementos"]');
  const chips = document.getElementById('chips'), fi = document.getElementById('fi');
  window.__picked = null; window.__uploaded = null; window.__uploads = 0;
  const addChip = () => {
    chips.innerHTML = '<button aria-label="Elemento"><img alt="Imagem do elemento" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><span>cancel</span></button>';
    if (!${stickyChip}) chips.firstChild.onclick = () => { chips.innerHTML = ''; };
  };
  const bind = (o) => { o.onclick = () => { window.__picked = o.dataset.name; pick.style.display = 'none'; addChip(); }; };
  document.querySelectorAll('[role=option]').forEach(bind);
  if (plus && ${opensPicker}) plus.onclick = () => { pick.style.display = 'block'; };
  const up = document.querySelector('[data-upload]');
  if (up && ${chooserFires}) up.onclick = () => fi.click();
  fi.onchange = () => {
    const f = fi.files[0]; window.__uploaded = f && f.name; window.__uploads++;
    setTimeout(() => {
      const o = document.createElement('button'); o.setAttribute('role', 'option'); o.dataset.name = f.name;
      o.innerHTML = f.name + '<br>Imagem'; bind(o); list.prepend(o);
      if (${autoAttach}) { window.__picked = f.name; pick.style.display = 'none'; addChip(); }
    }, 400);
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') pick.style.display = 'none'; });
  if (${startAttached}) addChip();
})();</script>`;
};

let browser: Browser;
let page: Page;
let refPath: string;
let assetName: string;
beforeAll(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage();
  refPath = path.join(os.tmpdir(), `flow-ref-picker-${process.pid}.png`);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 200, b: 10 } } }).png().toFile(refPath);
  assetName = `character-reference-${crypto.createHash("sha256").update(fs.readFileSync(refPath)).digest("hex").slice(0, 8)}.png`;
}, 30_000);
afterAll(async () => {
  await browser?.close();
  try { if (refPath) fs.unlinkSync(refPath); } catch {}
});

const state = () => page.evaluate(() => ({
  picked: (window as unknown as { __picked: string | null }).__picked,
  uploaded: (window as unknown as { __uploaded: string | null }).__uploaded,
  uploads: (window as unknown as { __uploads: number }).__uploads,
  chip: document.querySelectorAll('button[aria-label="Elemento"]').length,
  pickerOpen: !!Array.from(document.querySelectorAll("[data-picker]")).find((e) => (e as HTMLElement).style.display !== "none"),
}));

describe.skipIf(!CHROME)("attachFlowReferenceViaAssetPicker against a structural mock of the live Flow DOM", () => {
  it("wide layout: uploads once under a content-hash name, then SELECTS it (upload does not auto-attach)", async () => {
    await page.setContent(HTML({ layout: "wide" }));
    expect(await attachFlowReferenceViaAssetPicker(page, refPath)).toBe(true);
    const s = await state();
    expect(s.uploaded).toBe(assetName);
    expect(s.picked).toBe(assetName); // never one of the older "character-reference.jpg" duplicates
    expect(s.chip).toBe(1);
    expect(s.pickerOpen).toBe(false);
  }, 30_000);

  it("compact layout (dialog, aria-labelled upload button): works, and copes with an upload that auto-attaches", async () => {
    await page.setContent(HTML({ layout: "compact", autoAttach: true }));
    expect(await attachFlowReferenceViaAssetPicker(page, refPath)).toBe(true);
    const s = await state();
    expect(s.uploads).toBe(1);
    expect(s.chip).toBe(1);
  }, 30_000);

  it("reuses an asset that is already in the project by exact name — no second upload", async () => {
    await page.setContent(HTML({ layout: "wide", existing: ["character-reference.jpg", assetName] }));
    expect(await attachFlowReferenceViaAssetPicker(page, refPath)).toBe(true);
    const s = await state();
    expect(s.uploads).toBe(0);
    expect(s.picked).toBe(assetName);
    expect(s.chip).toBe(1);
  }, 30_000);

  it("returns false, never throws, without a '+' or when the picker never opens", async () => {
    await page.setContent(HTML({ withPlus: false }));
    await expect(attachFlowReferenceViaAssetPicker(page, refPath)).resolves.toBe(false);
    await page.setContent(HTML({ opensPicker: false }));
    await expect(attachFlowReferenceViaAssetPicker(page, refPath)).resolves.toBe(false);
  }, 30_000);

  it("returns false and closes the picker when there is no upload button, or the chooser never fires", async () => {
    await page.setContent(HTML({ withUpload: false }));
    await expect(attachFlowReferenceViaAssetPicker(page, refPath)).resolves.toBe(false);
    expect((await state()).pickerOpen).toBe(false);
    await page.setContent(HTML({ chooserFires: false }));
    await expect(attachFlowReferenceViaAssetPicker(page, refPath)).resolves.toBe(false);
    expect((await state()).pickerOpen).toBe(false);
  }, 30_000);
});

describe.skipIf(!CHROME)("prepareComposerReference — a stale attachment must never leak into the next beat", () => {
  it("clears the previous beat's attachment when this beat wants no reference", async () => {
    await page.setContent(HTML({ startAttached: true }));
    expect((await state()).chip).toBe(1);
    expect(await prepareComposerReference(page, page.locator("#prompt"), null)).toBe(false);
    expect((await state()).chip).toBe(0);
  }, 30_000);

  it("REFUSES to proceed if the leftover attachment cannot be cleared (fail closed, not a silent wrong image)", async () => {
    await page.setContent(HTML({ startAttached: true, stickyChip: true }));
    await expect(prepareComposerReference(page, page.locator("#prompt"), null)).rejects.toThrow(FlowBrowserError);
    await expect(prepareComposerReference(page, page.locator("#prompt"), null)).rejects.toThrow(/still attached/i);
  }, 30_000);

  it("a beat that wants the reference ends with exactly one attachment", async () => {
    await page.setContent(HTML({ layout: "wide", startAttached: true }));
    expect(await prepareComposerReference(page, page.locator("#prompt"), refPath)).toBe(true);
    expect((await state()).chip).toBe(1);
  }, 30_000);
});

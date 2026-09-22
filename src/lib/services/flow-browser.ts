import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { chromium, type BrowserContext, type Locator, type Page, type Response } from "playwright";
import { getSetting } from "../settings";
import { DATA_DIR } from "../run-paths";
import { checkCancelled } from "../cancellation";

/**
 * Experimental Google Flow browser adapter.
 *
 * Flow has no public generation API. This module drives the normal web UI with a
 * persistent, operator-owned Chrome profile. Calls are serialized process-wide:
 * visual-source may request several beats concurrently, but one browser tab must
 * never have two prompts or downloads in flight at the same time.
 */

export class FlowBrowserError extends Error {
  constructor(message: string, public readonly code: "config" | "login" | "ui" | "timeout" | "credits" | "capture") {
    super(message);
    this.name = "FlowBrowserError";
  }
}

export interface FlowSessionStatus {
  ready: boolean;
  loggedIn: boolean;
  url: string;
  message: string;
}

export interface CapturedImage {
  buffer: Buffer;
  width: number;
  height: number;
  url: string;
  capturedAt: number;
}

interface FlowBrowserState {
  context: BrowserContext | null;
  page: Page | null;
  launching: Promise<{ context: BrowserContext; page: Page }> | null;
  queue: Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __facelessFlowBrowserState: FlowBrowserState | undefined;
}

const state: FlowBrowserState = globalThis.__facelessFlowBrowserState ?? {
  context: null,
  page: null,
  launching: null,
  queue: Promise.resolve(),
};
globalThis.__facelessFlowBrowserState = state;

function settingInt(key: "FLOW_GENERATION_TIMEOUT_SEC", fallback: number, min: number, max: number): number {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function profileDir(): string {
  const configured = getSetting("FLOW_BROWSER_PROFILE_DIR").trim();
  // v2 intentionally uses a different profile than the old Playwright-launched
  // browser. Google blocks sign-in in a browser carrying automation launch flags.
  return path.resolve(configured || path.join(DATA_DIR, "flow-chrome-profile"));
}

function cdpPort(): number {
  const n = Number(getSetting("FLOW_CDP_PORT") || "9223");
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 9223;
}

function chromeExecutable(): string {
  const configured = getSetting("FLOW_BROWSER_EXECUTABLE").trim();
  if (configured) return configured;
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      ]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new FlowBrowserError("Google Chrome was not found. Set FLOW_BROWSER_EXECUTABLE to its full path.", "config");
  return found;
}

async function cdpReady(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Starts ordinary system Chrome (not chromium.launch / launchPersistentContext).
 * Google permits the operator to sign in normally in this window. Playwright only
 * attaches afterwards over localhost CDP, avoiding the automation launch flag that
 * triggers "This browser or app may not be secure" on Google Accounts.
 */
async function ensureNormalChrome(endpoint: string, dir: string): Promise<void> {
  if (await cdpReady(endpoint)) return;
  const executable = chromeExecutable();
  const port = cdpPort();
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    projectUrl(),
  ], { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await cdpReady(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new FlowBrowserError("Chrome opened, but the local Flow connection was not ready on time. Close that Chrome window and try again.", "config");
}

function projectUrl(): string {
  const configured = getSetting("FLOW_PROJECT_URL").trim();
  if (!configured) throw new FlowBrowserError("FLOW_PROJECT_URL is empty. Open a Flow project and save its URL in Settings.", "config");
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new FlowBrowserError("FLOW_PROJECT_URL is not a valid URL.", "config");
  }
  if (!/(^|\.)google$|(^|\.)google\.com$|(^|\.)labs\.google$/i.test(parsed.hostname)) {
    throw new FlowBrowserError("FLOW_PROJECT_URL must point to Google Flow (labs.google).", "config");
  }
  return parsed.toString();
}

async function launchBrowser(): Promise<{ context: BrowserContext; page: Page }> {
  if (state.context?.browser()?.isConnected() && state.page && !state.page.isClosed()) {
    return { context: state.context, page: state.page };
  }
  if (state.launching) return state.launching;

  state.launching = (async () => {
    const dir = profileDir();
    fs.mkdirSync(dir, { recursive: true });
    const endpoint = `http://127.0.0.1:${cdpPort()}`;
    try {
      await ensureNormalChrome(endpoint, dir);
      // This is an operator-owned, normal Chrome profile. Do not let Playwright
      // apply its default-context overrides (notably Browser.setDownloadBehavior).
      // Recent Chrome builds reject that command for their default context with
      // "Browser context management is not supported". We capture generated
      // images from network responses first, so changing browser download policy
      // is neither necessary nor desirable here.
      const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
      const context = browser.contexts()[0];
      if (!context) throw new Error("Chrome exposed no browser context");
      const pages = context.pages();
      const page = pages.find((p) => /labs\.google/.test(p.url())) ?? pages[0] ?? await context.newPage();
      state.context = context;
      state.page = page;
      context.on("close", () => {
        state.context = null;
        state.page = null;
      });
      return { context, page };
    } catch (error) {
      const msg = (error as Error).message;
      throw new FlowBrowserError(
        `Could not connect to normal Chrome for Google Flow: ${msg}. Close the Flow Chrome window and try again.`,
        "config"
      );
    } finally {
      state.launching = null;
    }
  })();
  return state.launching;
}

function looksLikeLogin(url: string): boolean {
  return /accounts\.google\.|\/signin|ServiceLogin/i.test(url);
}

async function pageHasLoginPrompt(page: Page): Promise<boolean> {
  if (looksLikeLogin(page.url())) return true;
  return page.getByText(/Sign in|Fazer login|Iniciar sessão/i).first().isVisible().catch(() => false);
}

async function gotoFlow(page: Page): Promise<void> {
  const target = projectUrl();
  if (!page.url().startsWith(target)) {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await page.waitForTimeout(1200);
}

/** Opens the persistent Flow browser without spending credits. Used by Settings for first login. */
export async function openFlowSession(): Promise<FlowSessionStatus> {
  return enqueue(async () => {
    const { page } = await launchBrowser();
    await gotoFlow(page);
    const loggedIn = !(await pageHasLoginPrompt(page));
    return {
      ready: loggedIn,
      loggedIn,
      url: page.url(),
      message: loggedIn
        ? "Normal Chrome is connected to Google Flow. Session is ready; no image was generated."
        : "Normal Chrome opened. Complete Google sign-in in that window, open the Flow project, then test again.",
    };
  });
}

/** Read-only health check. It never launches Chrome and never spends credits. */
export function flowSessionStatus(): FlowSessionStatus {
  const page = state.page;
  const connected = !!state.context?.browser()?.isConnected() && !!page && !page.isClosed();
  return {
    ready: connected && !looksLikeLogin(page?.url() ?? ""),
    loggedIn: connected && !looksLikeLogin(page?.url() ?? ""),
    url: connected ? page!.url() : "",
    message: connected ? "Flow browser is running." : "Flow browser is not running yet.",
  };
}

async function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = state.queue.catch(() => undefined);
  let release!: () => void;
  state.queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

async function firstVisible(candidates: Locator[]): Promise<Locator | null> {
  for (const group of candidates) {
    const count = await group.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const item = group.nth(i);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

async function promptBox(page: Page): Promise<Locator> {
  const custom = getSetting("FLOW_PROMPT_SELECTOR").trim();
  const candidates = [
    ...(custom ? [page.locator(custom)] : []),
    page.locator('textarea[placeholder*="prompt" i]'),
    page.locator("textarea"),
    page.locator('[contenteditable="true"][role="textbox"]'),
    page.locator('[contenteditable="true"]'),
  ];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = await firstVisible(candidates);
    if (found) return found;
    await page.waitForTimeout(500);
  }
  throw new FlowBrowserError(
    "Could not find the Flow prompt box. Make sure an editable Flow project is open, or set FLOW_PROMPT_SELECTOR.",
    "ui"
  );
}

async function generateButton(page: Page): Promise<Locator | null> {
  const custom = getSetting("FLOW_GENERATE_SELECTOR").trim();
  const actionPattern = /Generate|Gerar|Générer|Create|Criar|Créer|Submit|Send|Enviar|Make|Run/i;
  const candidates = [
    ...(custom ? [page.locator(custom)] : []),
    page.getByRole("button", { name: actionPattern }),
    page.locator('button[aria-label*="generate" i], [role="button"][aria-label*="generate" i]'),
    page.locator('button[aria-label*="create" i], [role="button"][aria-label*="create" i]'),
    page.locator('button[aria-label*="send" i], [role="button"][aria-label*="send" i]'),
    page.locator('button[aria-label*="submit" i], [role="button"][aria-label*="submit" i]'),
    page.locator('[data-testid*="generate" i], [data-testid*="create" i], [data-testid*="submit" i], [data-testid*="send" i]'),
    page.locator('button[title*="generate" i], button[title*="create" i], button[title*="send" i]'),
  ];
  // Flow may not render/enable its action control until after prompt text exists.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const found = await firstVisible(candidates);
    if (found && await found.isEnabled().catch(() => true)) return found;
    await page.waitForTimeout(300);
  }
  return null;
}

async function submitPrompt(page: Page, input: Locator): Promise<void> {
  const button = await generateButton(page);
  if (button) {
    await button.click();
    return;
  }

  // Some Flow layouts expose no accessible label on the arrow action. If the
  // prompt lives in a form, requestSubmit triggers the same React submit path.
  const submittedForm = await input.evaluate((element) => {
    const form = element.closest("form");
    if (!form) return false;
    form.requestSubmit();
    return true;
  }).catch(() => false);
  if (submittedForm) return;

  // Final UI-independent fallback: Flow prompt boxes use Enter to submit and
  // Shift+Enter for a newline. This also covers unlabeled icon-only buttons.
  await input.press("Enter");
}

async function ensureNanoBanana(page: Page): Promise<void> {
  const wanted = (getSetting("FLOW_IMAGE_MODEL") || "nano-banana-pro").replace(/[-_]+/g, " ").trim();
  const pattern = wanted.toLowerCase().includes("pro") ? /Nano Banana Pro/i : /Nano Banana/i;
  // Poll, don't snapshot: this is a single isVisible() check racing Flow's own re-render of
  // the model chip right after a prompt submits/a generation finishes — confirmed live, a
  // manual read of the SAME page moments after a batch of "Could not confirm" failures found
  // the chip plainly visible ("🍌 Nano Banana Pro crop_16_9"), unchanged the whole time. A
  // one-shot check has no way to tell "wrong model" from "right model, not painted yet" apart;
  // giving it a few seconds to settle does, at the cost of a few hundred ms on the common path
  // where it's already there.
  const confirmDeadline = Date.now() + 4_000;
  while (Date.now() < confirmDeadline) {
    if (await page.getByText(pattern).first().isVisible().catch(() => false)) return;
    await page.waitForTimeout(250);
  }

  // Flow normally displays the active model beside the prompt. If it doesn't, try the
  // nearby model/options controls and select Nano Banana explicitly. We fail closed if
  // the model cannot be confirmed: silently generating with another model would violate
  // the operator's "Nano Banana only" selection.
  const controls = page.getByRole("button", { name: /Model|Modelo|Image|Imagem|Options|Opções|Settings|Configurações/i });
  const count = Math.min(await controls.count().catch(() => 0), 8);
  for (let i = count - 1; i >= 0; i--) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    await control.click().catch(() => undefined);
    const option = page.getByText(pattern, { exact: false }).last();
    if (await option.isVisible().catch(() => false)) {
      await option.click();
      return;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  throw new FlowBrowserError(
    `Could not confirm ${wanted} in Google Flow. Select Nano Banana Pro once in the visible browser and retry.`,
    "ui"
  );
}

async function setReferenceOnFileInput(page: Page, referenceImagePath: string): Promise<boolean> {
  const custom = getSetting("FLOW_REFERENCE_FILE_SELECTOR").trim();
  const groups = [
    ...(custom ? [page.locator(custom)] : []),
    page.locator('input[type="file"][accept*="image" i]'),
    page.locator('input[type="file"]'),
  ];
  for (const group of groups) {
    const count = await group.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const candidate = group.nth(i);
      const accept = (await candidate.getAttribute("accept").catch(() => "")) || "";
      if (accept && !/image|png|jpe?g|webp|\*/i.test(accept)) continue;
      try {
        await candidate.setInputFiles(referenceImagePath);
        return true;
      } catch {
        // Try the next upload control. Flow can keep inactive file inputs mounted.
      }
    }
  }
  return false;
}

async function dropReferenceOnPrompt(page: Page, input: Locator, referenceImagePath: string): Promise<boolean> {
  try {
    const buffer = fs.readFileSync(referenceImagePath);
    const ext = path.extname(referenceImagePath).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const payload = {
      base64: buffer.toString("base64"),
      mime,
      name: path.basename(referenceImagePath),
    };
    await input.evaluate((element, fileData) => {
      const raw = atob(fileData.base64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const file = new File([bytes], fileData.name, { type: fileData.mime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        element.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }));
      }
    }, payload);
    await page.waitForTimeout(2600);
    const body = (await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")).slice(-6000);
    if (/unsupported file|upload failed|could(?:n'?t| not) upload|não foi possível (?:carregar|enviar)/i.test(body)) return false;
    return true;
  } catch {
    return false;
  }
}

async function uploadFlowReference(page: Page, input: Locator, referenceImagePath: string): Promise<void> {
  if (!fs.existsSync(referenceImagePath)) {
    throw new FlowBrowserError("The configured character reference image no longer exists on disk.", "config");
  }

  // In some Flow layouts the hidden image input is already mounted and can be fed
  // directly. This is the most stable path because it does not depend on button text.
  if (await setReferenceOnFileInput(page, referenceImagePath)) {
    await page.waitForTimeout(2200);
    return;
  }

  // Google's current desktop instructions explicitly support dragging local media
  // into the prompt box. Dispatching the same File-backed drop avoids relying on an
  // Add Image control, which some Flow/Agent layouts do not expose at all.
  if (await dropReferenceOnPrompt(page, input, referenceImagePath)) return;

  // Other layouts mount the file input only after Add ingredient / Reference is
  // opened. Support both a direct file chooser and a two-step popover with Upload.
  const triggers = [
    page.getByRole("button", { name: /Add (?:an? )?(?:ingredient|reference|image|media)|Reference image|Character reference|Ingredient|Upload image/i }),
    page.locator('button[aria-label*="ingredient" i], [role="button"][aria-label*="ingredient" i]'),
    page.locator('button[aria-label*="reference" i], [role="button"][aria-label*="reference" i]'),
    page.locator('button[aria-label*="upload" i], [role="button"][aria-label*="upload" i]'),
    page.locator('[data-testid*="ingredient" i], [data-testid*="reference" i], [data-testid*="upload" i]'),
  ];
  for (const group of triggers) {
    const count = Math.min(await group.count().catch(() => 0), 8);
    for (let i = count - 1; i >= 0; i--) {
      const trigger = group.nth(i);
      if (!(await trigger.isVisible().catch(() => false))) continue;
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 1800 }).catch(() => null);
      await trigger.click().catch(() => undefined);
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(referenceImagePath);
        await page.waitForTimeout(2200);
        return;
      }
      await page.waitForTimeout(350);
      if (await setReferenceOnFileInput(page, referenceImagePath)) {
        await page.waitForTimeout(2200);
        return;
      }

      const uploadAction = await firstVisible([
        page.getByRole("menuitem", { name: /Upload|Carregar|Enviar arquivo|From computer|Do computador/i }),
        page.getByRole("button", { name: /Upload|Carregar|Enviar arquivo|From computer|Do computador/i }),
        page.getByText(/^(?:Upload|Carregar|Enviar arquivo|From computer|Do computador)$/i),
      ]);
      if (uploadAction) {
        const nestedChooserPromise = page.waitForEvent("filechooser", { timeout: 2500 }).catch(() => null);
        await uploadAction.click().catch(() => undefined);
        const nestedChooser = await nestedChooserPromise;
        if (nestedChooser) {
          await nestedChooser.setFiles(referenceImagePath);
          await page.waitForTimeout(2200);
          return;
        }
        if (await setReferenceOnFileInput(page, referenceImagePath)) {
          await page.waitForTimeout(2200);
          return;
        }
      }
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }

  throw new FlowBrowserError(
    "Could not find Flow's reference-image upload control. Open an image-generation project with Nano Banana, or set FLOW_REFERENCE_FILE_SELECTOR in Advanced settings.",
    "ui"
  );
}

async function clearFlowReferences(page: Page): Promise<number> {
  const custom = getSetting("FLOW_REFERENCE_REMOVE_SELECTOR").trim();
  const candidates = [
    ...(custom ? [page.locator(custom)] : []),
    page.locator('button[aria-label*="remove" i][aria-label*="ingredient" i]'),
    page.locator('button[aria-label*="remove" i][aria-label*="reference" i]'),
    page.locator('button[aria-label*="remove" i][aria-label*="attachment" i]'),
    page.locator('button[aria-label*="remove" i][aria-label*="media" i]'),
    page.locator('button[title*="remove" i][title*="ingredient" i], button[title*="remove" i][title*="reference" i]'),
    page.getByRole("button", { name: /^Remove (?:image|ingredient|reference|attachment|media)/i }),
  ];
  let removed = 0;
  // Repeat because each click can re-render the attachment row and invalidate
  // indices. The narrow accessible-name match avoids touching generated outputs.
  for (let pass = 0; pass < 6; pass++) {
    const item = await firstVisible(candidates);
    if (!item) break;
    await item.click().catch(() => undefined);
    removed++;
    await page.waitForTimeout(250);
  }
  return removed;
}

function isCandidateResponse(response: Response): boolean {
  const type = (response.headers()["content-type"] || "").toLowerCase();
  if (type.startsWith("image/") && !/svg|icon/.test(type)) return true;
  return /\.(png|jpe?g|webp)(?:[?#]|$)/i.test(response.url());
}

async function captureResponse(response: Response): Promise<CapturedImage | null> {
  if (!isCandidateResponse(response)) return null;
  try {
    const buffer = await response.body();
    if (buffer.byteLength < 80_000) return null;
    const meta = await sharp(buffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 512 || height < 512) return null;
    return { buffer, width, height, url: response.url(), capturedAt: Date.now() };
  } catch {
    return null;
  }
}

export function chooseBestCapturedImage(images: CapturedImage[], aspect = "16:9"): CapturedImage | null {
  const [aw, ah] = aspect.split(":").map(Number);
  const target = aw > 0 && ah > 0 ? aw / ah : 16 / 9;
  return [...images].sort((a, b) => {
    const aRatioPenalty = Math.abs(a.width / a.height - target) / target;
    const bRatioPenalty = Math.abs(b.width / b.height - target) / target;
    const aMatches = aRatioPenalty <= 0.15;
    const bMatches = bRatioPenalty <= 0.15;
    if (aMatches !== bMatches) return aMatches ? -1 : 1;
    const aScore = a.width * a.height * Math.max(0.2, 1 - aRatioPenalty);
    const bScore = b.width * b.height * Math.max(0.2, 1 - bRatioPenalty);
    return bScore - aScore || b.buffer.byteLength - a.buffer.byteLength;
  })[0] ?? null;
}

async function tryDownloadFromUi(page: Page, outPath: string): Promise<boolean> {
  const largeImages = page.locator("img");
  let bestIndex = -1;
  let bestArea = 0;
  const count = await largeImages.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const img = largeImages.nth(i);
    if (!(await img.isVisible().catch(() => false))) continue;
    const size = await img.evaluate((el: HTMLImageElement) => ({ w: el.naturalWidth, h: el.naturalHeight })).catch(() => ({ w: 0, h: 0 }));
    if (size.w >= 512 && size.h >= 512 && size.w * size.h >= bestArea) {
      bestArea = size.w * size.h;
      bestIndex = i;
    }
  }
  if (bestIndex >= 0) await largeImages.nth(bestIndex).click().catch(() => undefined);

  const downloadButton = await firstVisible([
    page.getByRole("button", { name: /Download|Baixar|Télécharger/i }),
    page.locator('button[aria-label*="download" i]'),
    page.locator('button[title*="download" i]'),
  ]);
  if (!downloadButton) return false;
  try {
    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await downloadButton.click();
    const download = await downloadPromise;
    const tmp = path.join(os.tmpdir(), `flow_download_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
    await download.saveAs(tmp);
    const meta = await sharp(tmp).metadata();
    if ((meta.width ?? 0) < 512 || (meta.height ?? 0) < 512) throw new Error("download is not a full-size image");
    await sharp(tmp).png().toFile(outPath);
    try { fs.unlinkSync(tmp); } catch {}
    return true;
  } catch {
    return false;
  }
}

async function detectFlowFailure(page: Page): Promise<FlowBrowserError | null> {
  const body = (await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")).slice(-12_000);
  if (/out of (?:AI |Flow )?credits|not enough credits|créditos insuficientes|sem créditos/i.test(body)) {
    return new FlowBrowserError("Google Flow reports that this account has no credits available.", "credits");
  }
  if (/generation failed|could(?:n'?t| not) generate|não foi possível gerar|tente novamente/i.test(body)) {
    return new FlowBrowserError("Google Flow reported that image generation failed.", "ui");
  }
  return null;
}

/** Generate one full-size image through the Google Flow web UI and save it as PNG. */
export async function generateFlowImage(
  runId: string,
  prompt: string,
  outPath: string,
  aspect = "16:9",
  options?: { referenceImagePath?: string }
): Promise<string> {
  return enqueue(async () => {
    if (runId) checkCancelled(runId);
    const { page } = await launchBrowser();
    await gotoFlow(page);
    if (await pageHasLoginPrompt(page)) {
      throw new FlowBrowserError("Google login is required. Open Settings → Google Flow → Open Flow / login.", "login");
    }
    const input = await promptBox(page);
    await ensureNanoBanana(page);
    // Remove any composer attachment left by a previous beat. Then attach the
    // portrait only for a beat explicitly routed as a character scene. This keeps
    // object/detail shots from inheriting the housekeeper by accident.
    await clearFlowReferences(page);
    if (options?.referenceImagePath) {
      await uploadFlowReference(page, input, options.referenceImagePath);
    }
    const timeoutMs = settingInt("FLOW_GENERATION_TIMEOUT_SEC", 240, 30, 900) * 1000;
    const candidates: CapturedImage[] = [];
    const tasks = new Set<Promise<void>>();
    let lastCaptureAt = 0;
    const onResponse = (response: Response) => {
      const task = captureResponse(response).then((image) => {
        if (image) {
          candidates.push(image);
          lastCaptureAt = Date.now();
        }
      }).finally(() => tasks.delete(task));
      tasks.add(task);
    };
    page.on("response", onResponse);

    try {
      await input.fill(prompt.slice(0, 12_000));
      await submitPrompt(page, input);
      const deadline = Date.now() + timeoutMs;
      let nextFailureCheck = Date.now() + 4_000;
      while (Date.now() < deadline) {
        if (runId) checkCancelled(runId);
        if (await pageHasLoginPrompt(page)) throw new FlowBrowserError("Google session expired during generation.", "login");
        if (candidates.length && Date.now() - lastCaptureAt >= 4_000) break;
        if (Date.now() >= nextFailureCheck) {
          const failure = await detectFlowFailure(page);
          if (failure) throw failure;
          nextFailureCheck = Date.now() + 4_000;
        }
        await page.waitForTimeout(500);
      }
      await Promise.allSettled([...tasks]);
      const best = chooseBestCapturedImage(candidates, aspect || getSetting("FLOW_ASPECT_RATIO") || "16:9");
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      if (best) {
        await sharp(best.buffer).png().toFile(outPath);
        return outPath;
      }
      if (await tryDownloadFromUi(page, outPath)) return outPath;
      throw new FlowBrowserError(
        `No full-size Flow image was captured within ${Math.round(timeoutMs / 1000)}s. The UI may have changed.`,
        "timeout"
      );
    } finally {
      page.off("response", onResponse);
    }
  });
}

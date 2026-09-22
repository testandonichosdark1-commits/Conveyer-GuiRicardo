import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import sharp from "sharp";
import { chromium, type BrowserContext, type Locator, type Page, type Response } from "playwright";
import { getSetting } from "../settings";
import { DATA_DIR } from "../run-paths";
import { checkCancelled } from "../cancellation";
import { resolveFfprobe } from "../ffmpeg-bin";
import { log } from "../logger";

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

// Generalized from the image-only literal so image and video can each own their own
// bounds — video legitimately runs minutes longer than a still (Veo render + Flow's own
// encode/publish step), and the two timeouts must be free to move independently.
function settingInt(key: "FLOW_GENERATION_TIMEOUT_SEC" | "FLOW_VIDEO_TIMEOUT_SEC" | "FLOW_VIDEO_DURATION_SEC", fallback: number, min: number, max: number): number {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

/** Max wait for one generated Nano Banana image, in ms. */
export function flowImageTimeoutMs(): number {
  return settingInt("FLOW_GENERATION_TIMEOUT_SEC", 240, 30, 900) * 1000;
}

/** Max wait for one generated Veo video, in ms — separate ceiling, and much longer. */
export function flowVideoTimeoutMs(): number {
  return settingInt("FLOW_VIDEO_TIMEOUT_SEC", 600, 60, 1800) * 1000;
}

/** Clip length (seconds) requested from Flow's duration control, when one exists. */
export function flowRequestedVideoDurationSec(): number {
  return settingInt("FLOW_VIDEO_DURATION_SEC", 8, 2, 30);
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
  if (await page.getByText(pattern).first().isVisible().catch(() => false)) return;

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

/**
 * Lowercase, hyphens/underscores → spaces, collapsed whitespace. Shared by the setting
 * value (kebab-case, e.g. "veo-3.1-fast") and whatever text Flow's own UI renders (e.g.
 * "Veo 3.1 Fast", "veo 3.1 — fast") so the two can be compared despite Google's own
 * spacing/casing choices changing without notice. Exported for unit tests.
 */
export function normalizeFlowModelLabel(s: string): string {
  return s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Does a candidate label (arbitrary text from the Flow UI) name the wanted Veo model?
 * Exact match after normalization, or the wanted tokens appearing as a contiguous run
 * inside the candidate (so "Veo 3.1 Fast (Beta)" still matches "veo-3.1-fast"). Never
 * the reverse (a shorter candidate must not match a longer wanted string) — that would
 * let "Veo 3" match when "Veo 3.1" was configured. Exported for unit tests.
 */
export function veoModelLabelMatches(wanted: string, candidateText: string): boolean {
  const w = normalizeFlowModelLabel(wanted);
  const c = normalizeFlowModelLabel(candidateText);
  if (!w || !c) return false;
  if (w === c) return true;
  // Whole-token containment: split both on spaces and require candidate to contain the
  // wanted token sequence contiguously, not just as a loose substring (which would let
  // "veo 31 fast" mis-match unrelated digits glued together in a badge).
  const wTokens = w.split(" ");
  const cTokens = c.split(" ");
  for (let i = 0; i + wTokens.length <= cTokens.length; i++) {
    if (wTokens.every((t, j) => cTokens[i + j] === t)) return true;
  }
  return false;
}

/** The configured Veo model, normalized to plain words ("veo-3.1-fast" -> "veo 3.1 fast"). */
function wantedVeoModel(): string {
  return (getSetting("FLOW_VIDEO_MODEL") || "veo-3.1-fast").replace(/[-_]+/g, " ").trim();
}

/**
 * Confirm (or select) the configured Veo model in Flow's video mode. Mirrors
 * ensureNanoBanana's contract exactly: if the wanted model is already showing, done; else
 * open the nearby model/options controls and select it explicitly. FAILS LOUD — never
 * falls back to a different Veo tier — because silently rendering on another model would
 * both violate the operator's choice and bill a different price than they saw.
 */
async function ensureVeoModel(page: Page): Promise<void> {
  const wanted = wantedVeoModel();
  const pattern = new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*[-\\s]?\\s*"), "i");
  if (await page.getByText(pattern).first().isVisible().catch(() => false)) return;

  const controls = page.getByRole("button", { name: /Model|Modelo|Video|Vidéo|Vídeo|Options|Opções|Settings|Configurações/i });
  const count = Math.min(await controls.count().catch(() => 0), 8);
  for (let i = count - 1; i >= 0; i--) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    await control.click().catch(() => undefined);
    // Iterate visible option-like text nodes and pick the one that actually NAMES the
    // wanted model (veoModelLabelMatches), rather than trusting the first text match —
    // Flow's menu can also show "Veo 3", "Veo 3 Fast" etc. right next to each other.
    const optionCandidates = page.getByText(/Veo/i);
    const optCount = Math.min(await optionCandidates.count().catch(() => 0), 20);
    for (let j = optCount - 1; j >= 0; j--) {
      const opt = optionCandidates.nth(j);
      if (!(await opt.isVisible().catch(() => false))) continue;
      const text = await opt.innerText().catch(() => "");
      if (veoModelLabelMatches(wanted, text)) {
        await opt.click();
        return;
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  throw new FlowBrowserError(
    `Could not confirm "${wanted}" in Google Flow. Either that Veo model is not available on this account/project, or ` +
      `Flow's menu text no longer matches. Select it once in the visible browser and retry, or correct FLOW_VIDEO_MODEL.`,
    "ui"
  );
}

/**
 * Switch Flow's composer between Image and Video generation mode. Fails loud on
 * ambiguity, same contract as ensureNanoBanana/ensureVeoModel: a beat that needs one
 * media kind must never silently render as the other. FLOW_MEDIA_MODE_SELECTOR is tried
 * first when set (advanced override); accessible role/name matching otherwise.
 *
 * NOT YET VALIDATED against a live Flow session (no CDP/Chrome available in this
 * environment) — the selector cascade mirrors ensureNanoBanana's, which IS proven
 * working for images, but the exact Image/Video switch control should be confirmed
 * against the real UI before relying on it unattended.
 */
async function ensureFlowMediaMode(page: Page, mode: "image" | "video"): Promise<void> {
  const label = mode === "image" ? /^(?:Image|Imagem|Imagen|Photo)$/i : /^(?:Video|Vidéo|Vídeo)$/i;
  const custom = getSetting("FLOW_MEDIA_MODE_SELECTOR").trim();

  // Already in the right mode? Flow typically shows the active mode's name near the
  // composer (same assumption ensureNanoBanana already relies on for the model name).
  if (await page.getByText(label).first().isVisible().catch(() => false)) return;

  const switchControls = [
    ...(custom ? [page.locator(custom)] : []),
    page.getByRole("tab", { name: /Image|Imagem|Video|Vidéo|Vídeo/i }),
    page.getByRole("button", { name: /Image|Imagem|Video|Vidéo|Vídeo|Mode|Modo|Model|Modelo|Options|Opções/i }),
  ];
  for (const group of switchControls) {
    const count = Math.min(await group.count().catch(() => 0), 8);
    for (let i = count - 1; i >= 0; i--) {
      const control = group.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;
      await control.click().catch(() => undefined);
      const option = page.getByText(label, { exact: false }).last();
      if (await option.isVisible().catch(() => false)) {
        await option.click();
        if (await page.getByText(label).first().isVisible().catch(() => false)) return;
      }
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }
  throw new FlowBrowserError(
    `Could not switch Google Flow to ${mode === "image" ? "Image" : "Video"} mode. The UI may have changed — ` +
      `set FLOW_MEDIA_MODE_SELECTOR in Advanced settings, or switch modes once manually and retry.`,
    "ui"
  );
}

/** Ensure Image mode + Nano Banana are active. */
async function ensureFlowImageMode(page: Page): Promise<void> {
  await ensureFlowMediaMode(page, "image");
  await ensureNanoBanana(page);
}

/** Ensure Video mode + the configured Veo model are active. */
async function ensureFlowVideoMode(page: Page): Promise<void> {
  await ensureFlowMediaMode(page, "video");
  await ensureVeoModel(page);
}

/**
 * Best-effort aspect-ratio selection. Unlike the model pickers this FAILS SOFT (logs and
 * continues) rather than throwing: Flow may default to a sane ratio on its own, and the
 * pre-existing image path has never set this explicitly either (it only SCORES captured
 * images against the wanted aspect after the fact via chooseBestCapturedImage). Returns
 * whether it found and used a matching control, purely for logging.
 */
async function ensureFlowAspectRatio(page: Page, aspect: string): Promise<boolean> {
  const wanted = (aspect || "16:9").trim();
  if (!/^\d+:\d+$/.test(wanted)) return false;
  const custom = getSetting("FLOW_ASPECT_RATIO_SELECTOR").trim();
  const pattern = new RegExp(wanted.replace(":", "\\s*:\\s*"));
  if (await page.getByText(pattern).first().isVisible().catch(() => false)) return true;

  const controls = [
    ...(custom ? [page.locator(custom)] : []),
    page.getByRole("button", { name: /Aspect|Ratio|Proportion|Formato|Proporção/i }),
  ];
  for (const group of controls) {
    const count = Math.min(await group.count().catch(() => 0), 6);
    for (let i = count - 1; i >= 0; i--) {
      const control = group.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;
      await control.click().catch(() => undefined);
      const option = page.getByText(pattern).last();
      if (await option.isVisible().catch(() => false)) {
        await option.click();
        return true;
      }
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }
  return false;
}

/**
 * Best-effort duration selection for Flow's video control, when one exists. Fails soft
 * (like ensureFlowAspectRatio) — "quando a interface permitir" per spec: many Veo tools
 * offer only a fixed clip length with no control to change it, and that is not an error.
 */
async function ensureFlowDuration(page: Page, durationSec: number): Promise<boolean> {
  const wanted = Math.max(1, Math.round(durationSec));
  const custom = getSetting("FLOW_DURATION_SELECTOR").trim();
  const pattern = new RegExp(`\\b${wanted}\\s*s(?:ec)?\\b`, "i");

  const controls = [
    ...(custom ? [page.locator(custom)] : []),
    page.getByRole("button", { name: /Duration|Length|Durée|Duração|Duración/i }),
  ];
  for (const group of controls) {
    const count = Math.min(await group.count().catch(() => 0), 6);
    for (let i = count - 1; i >= 0; i--) {
      const control = group.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;
      await control.click().catch(() => undefined);
      const option = page.getByText(pattern).last();
      if (await option.isVisible().catch(() => false)) {
        await option.click();
        return true;
      }
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }
  return false;
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
    // dispatchEvent() firing without error is NOT proof Flow acted on the drop — a layout
    // that silently ignores the synthetic DragEvent looks identical from here. Require a
    // visible remove/chip control before calling the drop a success.
    return await confirmReferenceAttached(page);
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

/** Shared by clearFlowReferences (click to remove) and confirmReferenceAttached (look, don't click). */
function referenceRemoveControls(page: Page): Locator[] {
  const custom = getSetting("FLOW_REFERENCE_REMOVE_SELECTOR").trim();
  return [
    ...(custom ? [page.locator(custom)] : []),
    page.locator('button[aria-label*="remove" i][aria-label*="ingredient" i]'),
    page.locator('button[aria-label*="remove" i][aria-label*="reference" i]'),
    page.locator('button[aria-label*="remove" i][aria-label*="attachment" i]'),
    page.locator('button[aria-label*="remove" i][aria-label*="media" i]'),
    page.locator('button[title*="remove" i][title*="ingredient" i], button[title*="remove" i][title*="reference" i]'),
    page.getByRole("button", { name: /^Remove (?:image|ingredient|reference|attachment|media)/i }),
  ];
}

async function clearFlowReferences(page: Page): Promise<number> {
  let removed = 0;
  // Repeat because each click can re-render the attachment row and invalidate
  // indices. The narrow accessible-name match avoids touching generated outputs.
  for (let pass = 0; pass < 6; pass++) {
    const item = await firstVisible(referenceRemoveControls(page));
    if (!item) break;
    await item.click().catch(() => undefined);
    removed++;
    await page.waitForTimeout(250);
  }
  return removed;
}

/**
 * Visual evidence that a reference is actually attached — a removable chip/attachment
 * control became reachable. This is the check that distinguishes "we told the DOM to
 * accept a file" from "Flow shows the file was accepted"; dispatchEvent() succeeding is
 * NOT itself that evidence (see dropReferenceOnPrompt).
 */
async function confirmReferenceAttached(page: Page): Promise<boolean> {
  return (await firstVisible(referenceRemoveControls(page))) !== null;
}

/**
 * Safe diagnostic snapshot for a failed reference attach: button names/aria-labels/titles/
 * data-testids near the composer, plus how many file inputs exist. Never reads cookies,
 * tokens, or any account/session data — only DOM structure.
 */
async function diagnoseComposerControls(page: Page): Promise<string> {
  try {
    const info = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, [role=button]")).slice(0, 40);
      const names = btns
        .map((b) => (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 20);
      const testIds = Array.from(document.querySelectorAll("[data-testid]"))
        .map((el) => el.getAttribute("data-testid") || "")
        .filter(Boolean)
        .slice(0, 20);
      const fileInputs = document.querySelectorAll('input[type="file"]').length;
      return { names, testIds, fileInputs };
    });
    return `diagnostics: buttons=[${info.names.join(" | ").slice(0, 400)}] data-testids=[${info.testIds.join(",").slice(0, 200)}] fileInputs=${info.fileInputs}`;
  } catch {
    return "diagnostics: unavailable";
  }
}

/**
 * Clear whatever reference the PREVIOUS beat may have left attached, then optionally
 * attach a new one — the single seam both generateFlowImage and generateFlowVideo call,
 * so "clear before every beat, attach only when this beat wants it" can never drift
 * between the image and video paths. Returns whether a reference ended up attached.
 */
async function prepareComposerReference(page: Page, input: Locator, referenceImagePath: string | null): Promise<boolean> {
  await clearFlowReferences(page);
  if (!referenceImagePath) return false;
  await uploadFlowReference(page, input, referenceImagePath);
  if (await confirmReferenceAttached(page)) return true;
  const diag = await diagnoseComposerControls(page);
  throw new FlowBrowserError(
    `Character reference was sent to Google Flow but no attachment could be confirmed afterward — treating this as a ` +
      `failed upload rather than silently generating without the reference. ${diag}`,
    "ui"
  );
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

async function detectFlowFailure(page: Page, media: "image" | "video" = "image"): Promise<FlowBrowserError | null> {
  const body = (await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")).slice(-12_000);
  if (/out of (?:AI |Flow )?credits|not enough credits|créditos insuficientes|sem créditos/i.test(body)) {
    return new FlowBrowserError("Google Flow reports that this account has no credits available.", "credits");
  }
  if (/generation failed|could(?:n'?t| not) generate|não foi possível gerar|tente novamente/i.test(body)) {
    return new FlowBrowserError(`Google Flow reported that ${media} generation failed.`, "ui");
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
    await ensureFlowImageMode(page);
    await ensureFlowAspectRatio(page, aspect || getSetting("FLOW_ASPECT_RATIO") || "16:9");
    // Remove any composer attachment left by a previous beat. Then attach the
    // portrait only for a beat explicitly routed as a character scene. This keeps
    // object/detail shots from inheriting the housekeeper by accident.
    await prepareComposerReference(page, input, options?.referenceImagePath ?? null);
    const timeoutMs = flowImageTimeoutMs();
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

// ── Veo video ────────────────────────────────────────────────────────────────

/**
 * Video-shaped network response: real video content-type, or a URL ending in a common
 * video container extension. Excludes nothing by size here (unlike images, Flow does not
 * appear to serve tiny video "icons"), but callers still gate on a minimum byte count once
 * the body is actually fetched. Exported for unit tests.
 */
export function isVideoResponseCandidate(contentType: string, url: string): boolean {
  const type = (contentType || "").toLowerCase();
  if (type.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(url.split("?")[0] ?? url);
}

/** Below this, a "video" response is almost certainly a poster frame or a tracking pixel, not a real clip. */
const MIN_FLOW_VIDEO_BYTES = 150_000;

interface FlowVideoCandidate {
  response: Response;
  url: string;
  capturedAt: number;
}

/**
 * Among several matched network responses, the NEWEST one — i.e. the last one Flow sent
 * during this generation. Candidates are pushed in the order responses arrive, so the last
 * element is the newest by construction; this is a named, testable seam rather than an
 * inline `[length - 1]` so "choose the newest" is a documented, reviewable decision (per
 * spec: "se houver vários resultados, identifique o resultado mais novo"). Exported for tests.
 */
export function newestVideoCandidate<T extends { capturedAt: number }>(candidates: T[]): T | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((newest, c) => (c.capturedAt >= newest.capturedAt ? c : newest));
}

/**
 * Cheap pre-ffprobe sniff: is this actually HTML or a JSON error body wearing a video
 * extension/content-type? A failed/expired download often still arrives as a 200 status
 * carrying an HTML error page from a CDN edge. Catching it from the first bytes avoids
 * spending an ffprobe subprocess on something that was never going to be a video, and
 * avoids ffprobe's own error text (which can be cryptic) as the operator-facing reason.
 * Exported for unit tests.
 */
export function looksLikeNonVideoBody(buf: Buffer): boolean {
  const head = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<") || head.startsWith("{") || head.startsWith("[");
}

/** What validateFlowVideoFile confirmed about a downloaded clip. */
export interface FlowVideoProbe {
  durationSec: number;
  width: number;
  height: number;
  codec: string | null;
  fps: number | null;
}

/**
 * Validate a downloaded Flow video BEFORE it is handed to the pipeline: exists, non-empty,
 * not an HTML/JSON error body, and ffprobe confirms a real video stream with a readable
 * duration and dimensions. Throws FlowBrowserError("capture") with a specific reason on
 * any rejection — never silently accepts a thumbnail, an incomplete download, or an error
 * page as a video.
 *
 * Deliberately does NOT re-encode or scale here: the shared beat compositor
 * (studio-assemble.ts renderBeat) already re-encodes EVERY beat visual to the project's
 * codec/resolution/fps and strips audio unconditionally (`-an` in encodeV), exactly the
 * same way it already does for every kie.ai Veo / real-footage clip. Duplicating that
 * normalization here would be a second FFmpeg implementation for behavior the compositor
 * already guarantees — this function's job is strictly PASS/REJECT.
 */
export async function validateFlowVideoFile(filePath: string): Promise<FlowVideoProbe> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new FlowBrowserError("Downloaded Flow video is missing on disk.", "capture");
  }
  if (stat.size <= 0) throw new FlowBrowserError("Downloaded Flow video is empty (0 bytes).", "capture");

  const head = Buffer.alloc(Math.min(512, stat.size));
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (looksLikeNonVideoBody(head)) {
    throw new FlowBrowserError("The downloaded file looks like an HTML/JSON error page, not a video.", "capture");
  }

  const r = spawnSync(
    resolveFfprobe(),
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,avg_frame_rate",
      "-show_entries", "format=duration",
      "-of", "json",
      filePath,
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  if (r.status !== 0) {
    throw new FlowBrowserError(
      `ffprobe could not read the downloaded Flow video (rc=${r.status ?? "null"}): ${(r.stderr || "").toString().slice(0, 200)}`,
      "capture"
    );
  }
  let parsed: { streams?: Array<{ codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }>; format?: { duration?: string } };
  try {
    parsed = JSON.parse(r.stdout || "{}");
  } catch {
    throw new FlowBrowserError("ffprobe returned unreadable output for the downloaded Flow video.", "capture");
  }
  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new FlowBrowserError("The downloaded Flow file has no video stream — rejecting it (likely a thumbnail or an error body).", "capture");
  }
  const width = Number(stream.width) || 0;
  const height = Number(stream.height) || 0;
  const durationSec = Number(parsed.format?.duration) || 0;
  if (width <= 0 || height <= 0) throw new FlowBrowserError("The downloaded Flow video has no readable dimensions.", "capture");
  if (!(durationSec > 0)) throw new FlowBrowserError("The downloaded Flow video has no readable duration.", "capture");
  let fps: number | null = null;
  const fr = stream.avg_frame_rate;
  if (fr && fr.includes("/")) {
    const [n, d] = fr.split("/").map(Number);
    if (d > 0 && Number.isFinite(n)) fps = n / d;
  }
  return { durationSec, width, height, codec: stream.codec_name ?? null, fps };
}

/**
 * Official-download path for a finished Veo result — preferred over network-response
 * capture because Chrome streams the save straight to disk (Playwright's `download.saveAs`)
 * without ever buffering the file in this process, unlike `response.body()`.
 */
async function tryDownloadVideoFromUi(page: Page, tmpPath: string): Promise<boolean> {
  const custom = getSetting("FLOW_VIDEO_DOWNLOAD_SELECTOR").trim();
  const downloadButton = await firstVisible([
    ...(custom ? [page.locator(custom)] : []),
    page.getByRole("button", { name: /Download video|Baixar vídeo|Download|Baixar|Télécharger|Export|Exporter|Save|Salvar/i }),
    page.locator('button[aria-label*="download" i]'),
    page.locator('button[title*="download" i]'),
    page.locator('[data-testid*="download" i]'),
  ]);
  if (!downloadButton) return false;
  try {
    const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
    await downloadButton.click();
    const download = await downloadPromise;
    await download.saveAs(tmpPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate one video through the Google Flow web UI (Veo) and save it as MP4.
 *
 * Serialized on the SAME queue as generateFlowImage (enqueue() shares process-wide
 * `state.queue`) — image and video generations can never overlap in the controlled tab,
 * whatever order studio-pipeline's concurrent beats request them in.
 *
 * Audio: deliberately NOT handled here. The shared beat compositor
 * (studio-assemble.ts renderBeat) re-encodes every beat visual with `-an` unconditionally,
 * so Veo's own ambient audio never reaches the mux regardless of what this function
 * downloads. Duration matching is the same story — renderBeat loops a short clip
 * (`-stream_loop -1`) and hard-cuts a long one (`-frames:v <exact beat frame count>`), so
 * this function does not pre-trim to the beat length either. That is not an omission: it is
 * reusing the one mechanism every other video source (kie.ai Veo, real footage) already
 * goes through, rather than adding a second, beat-unaware trim pass here.
 */
export async function generateFlowVideo(
  runId: string,
  prompt: string,
  outPath: string,
  aspect = "16:9",
  options?: { referenceImagePath?: string; durationSec?: number }
): Promise<string> {
  return enqueue(async () => {
    if (runId) checkCancelled(runId);
    const { page } = await launchBrowser();
    await gotoFlow(page);
    if (await pageHasLoginPrompt(page)) {
      throw new FlowBrowserError("Google login is required. Open Settings → Google Flow → Open Flow / login.", "login");
    }
    const input = await promptBox(page);
    await ensureFlowVideoMode(page);
    await ensureFlowAspectRatio(page, aspect || getSetting("FLOW_ASPECT_RATIO") || "16:9");
    const requestedDurationSec = options?.durationSec && options.durationSec > 0 ? options.durationSec : flowRequestedVideoDurationSec();
    await ensureFlowDuration(page, requestedDurationSec);
    // Reference handling mirrors the image path exactly (prepareComposerReference is the
    // shared seam): cleared before every beat, attached only when this beat wants it, and
    // NEVER silently skipped — a failed attach throws rather than rendering a video that
    // looks like it used the reference when it didn't.
    await prepareComposerReference(page, input, options?.referenceImagePath ?? null);

    const timeoutMs = flowVideoTimeoutMs();
    const candidates: FlowVideoCandidate[] = [];
    let lastCaptureAt = 0;
    const onResponse = (response: Response) => {
      if (!isVideoResponseCandidate(response.headers()["content-type"] || "", response.url())) return;
      candidates.push({ response, url: response.url(), capturedAt: Date.now() });
      lastCaptureAt = Date.now();
    };
    page.on("response", onResponse);

    let promptSent = false;
    let downloadButtonSeen = false;
    const tmpPath = path.join(os.tmpdir(), `flow_veo_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    try {
      await input.fill(prompt.slice(0, 12_000));
      await submitPrompt(page, input);
      promptSent = true; // never re-submitted below — one prompt, one generation, whatever happens next

      const deadline = Date.now() + timeoutMs;
      let nextFailureCheck = Date.now() + 5_000;
      // Longer quiet window than images: Flow can stream a proxy/preview response before
      // the final encoded result, and a short window would grab the preview.
      const QUIET_MS = 8_000;
      while (Date.now() < deadline) {
        if (runId) checkCancelled(runId);
        if (await pageHasLoginPrompt(page)) throw new FlowBrowserError("Google session expired during video generation.", "login");
        if (candidates.length && Date.now() - lastCaptureAt >= QUIET_MS) break;
        if (await firstVisible([page.getByRole("button", { name: /Download video|Baixar vídeo/i })])) {
          downloadButtonSeen = true;
          break;
        }
        if (Date.now() >= nextFailureCheck) {
          const failure = await detectFlowFailure(page, "video");
          if (failure) throw failure;
          nextFailureCheck = Date.now() + 5_000;
        }
        await page.waitForTimeout(750);
      }

      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      // 1) Prefer the official Download control — streamed straight to disk by Chrome.
      if (await tryDownloadVideoFromUi(page, tmpPath)) {
        try {
          await validateFlowVideoFile(tmpPath);
          if (path.resolve(tmpPath) !== path.resolve(outPath)) fs.renameSync(tmpPath, outPath);
          return outPath;
        } catch (e) {
          try { fs.unlinkSync(tmpPath); } catch {}
          // Fall through to network-capture below rather than failing immediately — the
          // Download button existing is not proof the file behind it was good.
          log(runId, "debug", `Flow video download button produced an invalid file (${(e as Error).message.slice(0, 140)}) — trying captured network response`, { stage: "visual" });
        }
      }

      // 2) Fall back to the newest matching network response.
      const chosen = newestVideoCandidate(candidates);
      if (chosen) {
        try {
          const buffer = await chosen.response.body();
          if (buffer.byteLength >= MIN_FLOW_VIDEO_BYTES) {
            fs.writeFileSync(tmpPath, buffer);
            await validateFlowVideoFile(tmpPath);
            fs.renameSync(tmpPath, outPath);
            return outPath;
          }
        } catch {
          // fall through to the timeout error below with full diagnostics
        }
      }
      try { fs.unlinkSync(tmpPath); } catch {}

      throw new FlowBrowserError(
        `No valid Flow/Veo video was captured within ${Math.round(timeoutMs / 1000)}s ` +
          `[model="${wantedVeoModel()}", mode=video, promptSent=${promptSent}, ` +
          `resultAppeared=${candidates.length > 0}, downloadButtonSeen=${downloadButtonSeen}]. The UI may have changed.`,
        "timeout"
      );
    } finally {
      page.off("response", onResponse);
    }
  });
}

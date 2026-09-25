import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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
  constructor(message: string, public readonly code: "config" | "login" | "ui" | "timeout" | "credits" | "capture" | "policy") {
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
  /** model -> epoch ms until which Flow said its usage limit is hit (survives hot reload). */
  limitedModels?: Map<string, number>;
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
  limitedModels: new Map<string, number>(),
};
state.limitedModels ??= new Map<string, number>();
globalThis.__facelessFlowBrowserState = state;

// Generalized from the image-only literal so image and video can each own their own
// bounds — video legitimately runs minutes longer than a still (Veo render + Flow's own
// encode/publish step), and the two timeouts must be free to move independently.
function settingInt(key: "FLOW_GENERATION_TIMEOUT_SEC" | "FLOW_VIDEO_TIMEOUT_SEC" | "FLOW_VIDEO_DURATION_SEC", fallback: number, min: number, max: number): number {
  const n = Number(getSetting(key));
  // An unset/blank setting reads as Number("") === 0, which IS finite — so this must also
  // require n > 0, or a blanked field would silently clamp to `min` (e.g. a 30s image
  // timeout) instead of the intended default (240s), rather than falling back to it.
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
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
        ? "Normal Chrome is connected to Google Flow. Session is ready; no image or video was generated."
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

/**
 * Flow refuses to SUBMIT a generation the account cannot pay for: the arrow button is replaced by
 * a red "info" button (`.prompt-warning-button`, aria-label "Alerta de créditos insuficientes")
 * and NO failure card is ever created — so the wait loop below has nothing to detect and used to
 * idle for the full timeout (10 minutes for video; observed live 2026-09-25, a Veo beat that
 * costs 10 credits with the balance short). Recognised by the structural class first (language-
 * neutral), the localized label second. Exported for tests.
 */
export async function flowInsufficientCreditsWarning(page: Page): Promise<boolean> {
  const warning = page.locator(
    'button.prompt-warning-button, button[aria-label*="créditos insuficientes" i], button[aria-label*="insufficient credits" i]'
  );
  return warning.first().isVisible().catch(() => false);
}

/**
 * Turns whatever option labels WERE visible (but didn't match) into a compact, readable
 * diagnostic appended to the "could not confirm" error. Without this, a mismatch (e.g. the
 * wanted tier's row carrying an extra price/description segment the matcher doesn't
 * recognize) is indistinguishable from the option simply not existing — the operator, or
 * the next person debugging this from a run log, has to reproduce the failure live in a
 * browser just to learn what Flow actually rendered. Capped and deduplicated; this is DOM
 * text only, never cookies/tokens/account data (same rule as diagnoseComposerControls).
 */
function describeSeenLabels(seen: string[]): string {
  const unique = Array.from(new Set(seen.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))).slice(0, 10);
  return unique.length ? ` Saw: ${unique.map((s) => `"${s}"`).join(", ")}.` : " No matching option was visible.";
}

/**
 * Close whatever menu/popover is open. Escape alone is NOT enough: in the wide layout the
 * add-menu popover is a CDK overlay that ignores it and stays open behind a backdrop —
 * observed live — and every later click is then swallowed ("<div class=cdk-overlay-backdrop>
 * intercepts pointer events"), which is exactly how a failed reference attach used to poison
 * the next model switch. Clicking the backdrop is what closes it.
 */
async function dismissOpenOverlays(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  const backdrop = page.locator(".cdk-overlay-backdrop-showing");
  for (let i = 0; i < 3 && (await backdrop.count().catch(() => 0)) > 0; i++) {
    await backdrop.last().click({ force: true, position: { x: 5, y: 5 }, timeout: 2500 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
}

/**
 * Open the composer settings popover — the SAME popover the model chip opens for
 * selectModelViaComposer — if it isn't open already, and wait for it to render. Media mode
 * (Image/Video) and aspect ratio live INSIDE this popover as `role="radio"` controls
 * alongside the model-family select, verified live (2026-09-24, pt-BR account): the panel
 * shows Imagem/Vídeo, Frames/Elementos, the aspect-ratio row, the model select and xN all
 * together once opened. They are NOT separate tabs/buttons near the composer, which is what
 * ensureFlowMediaMode/ensureFlowAspectRatio assumed before this was confirmed against a real
 * session — that assumption meant neither control could ever be found.
 *
 * The chip itself is matched the same way selectModelViaComposer finds it (a plain button,
 * not a menu/menuitem/radio, naming the active model family) rather than by its localized
 * aria-label, so this stays language-neutral; `:not([role="radio"])` additionally guards
 * against ever matching one of the ratio/mode radios themselves once the popover is open.
 */
async function openComposerSettingsPopover(page: Page): Promise<boolean> {
  const anyRadio = page.getByRole("radio").first();
  if (await anyRadio.isVisible().catch(() => false)) return true;
  // The chip's own summary text is NOT a reliable match target: in Video mode it can read
  // "Vídeo · 720p · 8s" (resolution/duration) instead of the model name — verified live,
  // 2026-09-24 — so a family-text filter (used elsewhere for the chip once its popover is
  // already open and a specific model needs confirming) misses it here. Its aria-label
  // ("Gatilho de configurações") is stable across every content state observed and is tried
  // first; the family-text heuristic remains as a fallback for an un-inspected locale where
  // that label reads differently.
  const chipByLabel = page.getByRole("button", { name: "Gatilho de configurações" });
  const chipByText = page
    .locator('button:not([aria-haspopup]):not([role="menuitem"]):not([role="radio"])')
    .filter({ hasText: /Nano Banana|Veo/i });
  const chip = (await chipByLabel.first().isVisible().catch(() => false)) ? chipByLabel : chipByText;
  if (!(await chip.first().isVisible().catch(() => false))) return false;

  // Retried, not a single click: opening this same chip right after a PRIOR open/close cycle
  // on it (e.g. a media-mode switch immediately followed by an aspect-ratio change) was
  // observed live to occasionally swallow the click — the popover's own close transition
  // was still in flight. Same shape of flakiness selectModelViaComposer already retries for.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await page.waitForTimeout(400);
    await chip.first().click().catch(() => undefined);
    if ((await waitForVisible(page, [anyRadio], 2500)) !== null) return true;
  }
  return false;
}

async function waitForVisible(page: Page, candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await firstVisible(candidates);
    if (found) return found;
    await page.waitForTimeout(150);
  }
  return null;
}

/**
 * Switch the model through Flow's composer chip — the mechanism verified against the live
 * DOM (2026-09-23, pt-BR account). The composer carries a chip button whose text is the
 * ACTIVE model plus furniture ("🍌 Nano Banana 2 | crop_16_9 | x1" — `crop_16_9` is a
 * Material-icon ligature leaking into innerText). Clicking it opens a popover holding a
 * SECOND button, the family select (`aria-haspopup="menu"`, text "🍌 Nano Banana 2 |
 * arrow_drop_down"); clicking THAT expands a `role=menu` whose `role=menuitem` buttons are
 * the tiers ("Nano Banana Pro" / "Nano Banana 2" / "Nano Banana 2 Lite").
 *
 * Two clicks, then, and the old single-click routine never made the second one: it opened
 * the popover, looked for tier labels, found only the (collapsed) select's own text, and
 * gave up. That is why "nano banana pro" never confirmed while "nano banana 2" did — the
 * latter only passed because it was already the active model.
 *
 * Locators deliberately avoid accessible NAMES: the chip's aria-label is "Gatilho de
 * configurações" and the select's "Selecionar família de modelos" — both localized, so a
 * name-based lookup would break on any other account language. Structure (aria-haspopup,
 * role=menuitem) plus the model-family text is language-neutral.
 *
 *  - "ok"      the wanted model is now confirmed ACTIVE on the chip
 *  - "failed"  a chip exists but the wanted tier could not be selected/confirmed
 *  - "no-chip" no composer chip for this family (different layout) — caller falls back
 */
export async function selectModelViaComposer(
  page: Page,
  wanted: string,
  family: RegExp,
  seen: string[]
): Promise<"ok" | "failed" | "no-chip"> {
  // The outer chip's OWN summary text is the fast path — matched by family text, as before,
  // since that IS reliable for Nano Banana/image mode. It is NOT reliable for Veo/video mode:
  // verified live (2026-09-24), the chip there can read "Vídeo · 720p · 8s" (resolution and
  // duration) instead of the model name, so a family-text match on it fails even though a
  // model IS active — returning "no-chip" here used to abandon the whole switch before even
  // trying to open the popover. `chipByLabel` (its stable aria-label, "Gatilho de
  // configurações") is the fallback used to open it in that case; the confirmation at the end
  // falls back the same way, to the SELECT's own text rather than the chip's.
  const chipLoc = page.locator('button:not([aria-haspopup]):not([role="menuitem"])').filter({ hasText: family });
  const chipByLabel = page.getByRole("button", { name: "Gatilho de configurações" });
  const selectLoc = page.locator('button[aria-haspopup="menu"]').filter({ hasText: family });
  const itemLoc = page.locator('[role="menuitem"]').filter({ hasText: family });

  await dismissOpenOverlays(page);
  let chip = await firstVisible([chipLoc]);
  let chipTextIsReliable = true;
  if (!chip) {
    chip = await firstVisible([chipByLabel]);
    chipTextIsReliable = false;
    if (!chip) return "no-chip";
  }
  const chipText = await chip.innerText().catch(() => "");
  if (chipTextIsReliable && chipShowsModel(chipText, wanted)) return "ok";
  if (chipText) seen.push(chipText);

  // Open the popover unless its select is already on screen (a previous attempt may have
  // left it open).
  let select = await firstVisible([selectLoc]);
  if (!select) {
    for (let attempt = 0; attempt < 3 && !select; attempt++) {
      await chip.click({ timeout: 4000 }).catch(() => undefined);
      select = await waitForVisible(page, [selectLoc], 2500);
      if (!select) await dismissOpenOverlays(page);
    }
  }
  if (!select) {
    await dismissOpenOverlays(page);
    return "failed";
  }
  const selectText = await select.innerText().catch(() => "");
  if (chipShowsModel(selectText, wanted)) {
    await dismissOpenOverlays(page);
    return "ok";
  }
  if (selectText) seen.push(selectText);

  // The menuitem click was observed live to occasionally not register at all (the SAME
  // flakiness openComposerSettingsPopover/dismissOpenOverlays already retry for elsewhere in
  // this file — Flow's own click/animation timing, not a locator problem) — verified by re-
  // reading the select's own text afterward and retrying the whole open-menu/click cycle
  // when it still doesn't confirm, rather than trusting a single click.
  let confirmedBySelect = false;
  let everClicked = false;
  for (let attempt = 0; attempt < 2 && !confirmedBySelect; attempt++) {
    if ((await select.getAttribute("aria-expanded").catch(() => null)) !== "true") {
      await select.click().catch(() => undefined);
    }
    await waitForVisible(page, [itemLoc], 3000);
    const count = Math.min(await itemLoc.count().catch(() => 0), 20);
    let clicked = false;
    for (let i = 0; i < count; i++) {
      const item = itemLoc.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      const text = await item.innerText().catch(() => "");
      if (text) seen.push(text);
      if (flowModelLabelMatches(wanted, text)) {
        await item.click().catch(() => undefined);
        clicked = true;
      }
    }
    if (!clicked) break; // the wanted tier isn't in the menu at all — retrying won't help
    everClicked = true;
    await page.waitForTimeout(500);
    // The click is not proof — read something back. Prefer the SELECT's own text (still on
    // screen right now, and reliable for both families): it names the tier directly, unlike
    // the outer chip in video mode (see above).
    const selectAfter = await select.innerText().catch(() => "");
    confirmedBySelect = chipShowsModel(selectAfter, wanted);
  }
  if (!everClicked) {
    await dismissOpenOverlays(page);
    await dismissOpenOverlays(page);
    return "failed";
  }

  await page.waitForTimeout(200);
  await dismissOpenOverlays(page);
  await page.waitForTimeout(300);
  const after = await firstVisible([chipLoc]);
  if (!after) return confirmedBySelect ? "ok" : "failed";
  const afterText = await after.innerText().catch(() => "");
  if (afterText) seen.push(afterText);
  return confirmedBySelect || chipShowsModel(afterText, wanted) ? "ok" : "failed";
}

/**
 * Confirm (or select) a specific image-model tier by exact label — "nano-banana-pro" ->
 * "Nano Banana Pro", "nano-banana-2" -> "Nano Banana 2", etc. Shared by the primary model
 * and its configured fallback (see FLOW_IMAGE_MODEL_FALLBACK / generateFlowImage), so both
 * go through the identical selection + fail-loud contract — picking a tier is picking a
 * tier, whichever one is currently wanted.
 */
async function ensureImageModel(page: Page, wantedRaw: string): Promise<void> {
  const wanted = wantedRaw.replace(/[-_]+/g, " ").trim();
  const seenLabels: string[] = [];
  const via = await selectModelViaComposer(page, wanted, /Nano Banana/i, seenLabels);
  if (via === "ok") return;

  // Legacy path, kept for layouts without the composer chip. The loose "is this text on the
  // page" shortcut is skipped once a chip existed and selection failed: the popover's own
  // option labels are on the page by then and would fake a confirmation.
  if (via === "no-chip" && await page.getByText(new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).first().isVisible().catch(() => false)) return;

  // We fail closed if the model cannot be confirmed: silently generating with another model
  // would violate the operator's selection (or, on the fallback path, misreport which tier
  // actually ran).
  const controls = page.getByRole("button", { name: /Model|Modelo|Image|Imagem|Options|Opções|Settings|Configurações/i });
  const count = Math.min(await controls.count().catch(() => 0), 8);
  for (let i = count - 1; i >= 0; i--) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    await control.click().catch(() => undefined);
    // Iterate visible "Nano Banana …" text nodes and pick the one that actually NAMES the
    // wanted tier (flowModelLabelMatches), rather than trusting the first loose text match
    // — Flow's menu shows "Nano Banana", "Nano Banana Pro" (and now "Nano Banana 2") next
    // to each other, and a loose match would happily pick the wrong one.
    const optionCandidates = page.getByText(/Nano Banana/i);
    const optCount = Math.min(await optionCandidates.count().catch(() => 0), 20);
    for (let j = optCount - 1; j >= 0; j--) {
      const opt = optionCandidates.nth(j);
      if (!(await opt.isVisible().catch(() => false))) continue;
      const text = await opt.innerText().catch(() => "");
      if (text) seenLabels.push(text);
      if (flowModelLabelMatches(wanted, text)) {
        await opt.click();
        return;
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  throw new FlowBrowserError(
    `Could not confirm "${wanted}" in Google Flow. Select it once in the visible browser and retry, or correct the model setting.` +
      describeSeenLabels(seenLabels),
    "ui"
  );
}

/** Confirms the operator's PRIMARY configured image model — FLOW_IMAGE_MODEL, default
 *  "nano-banana-pro". Thin wrapper kept for readability at call sites. */
async function ensureNanoBanana(page: Page): Promise<void> {
  const wanted = (getSetting("FLOW_IMAGE_MODEL") || "nano-banana-pro").replace(/[-_]+/g, " ").trim();
  await ensureImageModel(page, wanted);
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

/** Words that decorate a menu label without naming a distinct model/tier. Stripped before
 *  comparison so "Veo 3.1 Fast (Beta)" / "New: Veo 3.1 Fast" / "Nano Banana 2 (New)" still
 *  match their plain configured id — but "Fast"/"Quality"/"Pro"/a version NUMBER are NEVER
 *  in this list, because those DO distinguish one tier from another and must keep failing
 *  the match. */
const FLOW_LABEL_DECORATION = /\b(new|beta|preview)\b/g;

/** One cleaned/normalized line, ready for exact comparison against a wanted model id. */
function cleanModelLabelLine(line: string): string {
  const cleaned = line.replace(/[()[\]]/g, " ").replace(/[^a-zA-Z0-9.\s-]/g, " ");
  return normalizeFlowModelLabel(cleaned).replace(FLOW_LABEL_DECORATION, " ").replace(/\s+/g, " ").trim();
}

/**
 * Does a candidate label (arbitrary text from the Flow UI) name the wanted model/tier?
 * Strips only cosmetic decoration (brackets, stray punctuation, "New"/"Beta"/"Preview")
 * and requires the REMAINDER to equal the wanted string exactly — not merely contain it —
 * so "nano-banana" never matches a menu entry for "Nano Banana Pro" just because it
 * contains the shorter string as a prefix (and "veo-3.1" never matches "Veo 3.1 Fast").
 *
 * A Flow menu ROW's innerText can carry more than the model name in the same node — a
 * price/credit cost or a one-line description stacked below it ("Nano Banana Pro\n8
 * credits", "Nano Banana Pro · Best quality"). Comparing the WHOLE innerText against the
 * wanted string would then never match, even though the row unambiguously names the right
 * tier — this was observed live: "nano banana pro" never confirmed while "nano banana 2"
 * did, on the same menu, in the same run. So each newline- or middot-separated SEGMENT is
 * checked on its own, and matching ANY segment exactly is enough. This only ever makes MORE
 * labels match, never fewer — a segment must still equal the wanted string exactly, so a
 * segment naming a different tier ("Nano Banana 2") still never matches "nano banana pro".
 * Exported for unit tests. Used for both Veo tiers and Nano Banana tiers — the matching
 * rule doesn't care which family of model names it's applied to.
 */
export function flowModelLabelMatches(wanted: string, candidateText: string): boolean {
  const w = normalizeFlowModelLabel(wanted);
  if (!w) return false;
  const segments = candidateText.split(/\n|·|•/);
  return segments.some((segment) => cleanModelLabelLine(segment) === w);
}

/** Words that, directly after a model name, mean the chip shows a DIFFERENT tier of it
 *  ("Nano Banana 2 Lite" is not "Nano Banana 2"), or a longer version ("Nano Banana 2" is
 *  not "Nano Banana"). Anything else trailing the name is chip furniture. */
const TIER_CONTINUATION = /^(?:\d|lite\b|pro\b|fast\b|quality\b|ultra\b|max\b|plus\b|flash\b|preview\b|low\b|priority\b|relaxed\b)/;

/**
 * Does the text of Flow's composer chip / family select show the wanted model as the
 * ACTIVE one? Unlike flowModelLabelMatches this cannot demand equality of the whole text:
 * the live chip reads "🍌 Nano Banana 2 | crop_16_9 | x1" (aspect-ratio icon ligature and
 * output count ride along) and the select "🍌 Nano Banana 2 | arrow_drop_down". So the
 * wanted name is looked for as whole words, and what FOLLOWS it decides: another tier word
 * or a further digit means a different model ("nano banana 2 lite", "nano banana 2" when
 * "nano banana" was wanted) — anything else is furniture. When unsure this returns false,
 * which merely costs an extra look inside the popover; a false positive would skip a needed
 * switch, so the rule leans conservative. Exported for unit tests.
 */
export function chipShowsModel(chipText: string, wantedRaw: string): boolean {
  const w = normalizeFlowModelLabel(wantedRaw);
  if (!w) return false;
  const c = cleanModelLabelLine(chipText);
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\s)${escaped}(?=$|\\s)`).exec(c);
  if (!m) return false;
  const rest = c.slice(m.index + m[0].length).trim();
  return !TIER_CONTINUATION.test(rest);
}

/** @deprecated kept as an alias — call sites and existing tests use the neutral
 *  flowModelLabelMatches name now that the same matcher is shared with Nano Banana tiers. */
export const veoModelLabelMatches = flowModelLabelMatches;

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
  const seenLabels: string[] = [];
  // Same composer-chip mechanism as the image models. Verified live for Nano Banana only;
  // the Veo popover is assumed to have the same shape. If it doesn't, this returns
  // "failed"/"no-chip" and the legacy routine below still runs exactly as before.
  const via = await selectModelViaComposer(page, wanted, /Veo/i, seenLabels);
  if (via === "ok") return;

  const pattern = new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*[-\\s]?\\s*"), "i");
  if (via === "no-chip" && await page.getByText(pattern).first().isVisible().catch(() => false)) return;

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
      if (text) seenLabels.push(text);
      if (veoModelLabelMatches(wanted, text)) {
        await opt.click();
        return;
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  throw new FlowBrowserError(
    `Could not confirm "${wanted}" in Google Flow. Either that Veo model is not available on this account/project, or ` +
      `Flow's menu text no longer matches. Select it once in the visible browser and retry, or correct FLOW_VIDEO_MODEL.` +
      describeSeenLabels(seenLabels),
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
export async function ensureFlowMediaMode(page: Page, mode: "image" | "video"): Promise<void> {
  const label = mode === "image" ? /^(?:image|imagem|imagen|photo)/i : /^(?:video|vidéo|vídeo)/i;
  const custom = getSetting("FLOW_MEDIA_MODE_SELECTOR").trim();
  if (custom) {
    const el = page.locator(custom);
    if (await el.first().isVisible().catch(() => false)) {
      await el.first().click().catch(() => undefined);
      return;
    }
  }

  // Image/Video is a role="radio" PAIR inside the composer settings popover — verified live,
  // see openComposerSettingsPopover's doc comment. `label` matches from the START of the
  // radio's own text (icon ligature + "\n" + localized word, e.g. "videocam\nVídeo") rather
  // than the whole string, since an anchored ^...$ match against that combined text never
  // matches either word alone.
  if (await openComposerSettingsPopover(page)) {
    const radio = page.getByRole("radio", { name: label });
    if (await radio.first().isVisible().catch(() => false)) {
      if ((await radio.first().getAttribute("aria-checked").catch(() => null)) !== "true") {
        await radio.first().click().catch(() => undefined);
        // Give the app a moment to commit the radio change before the popover closes — a
        // click immediately followed by dismissOpenOverlays' Escape was observed live to
        // race the close against the state update. See ensureFlowAspectRatio's matching note.
        await page.waitForTimeout(400);
      }
      await dismissOpenOverlays(page);
      return;
    }
    await dismissOpenOverlays(page);
  }

  // Legacy fallback for a layout without this popover (kept for layouts never inspected live).
  const switchControls = [
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

/** Ensure Image mode + a specific model are active. `modelOverride` (already
 *  hyphen-to-space normalized) is used on a fallback attempt; omitted, this reads the
 *  operator's configured FLOW_IMAGE_MODEL exactly as before this parameter existed. */
async function ensureFlowImageMode(page: Page, modelOverride?: string): Promise<void> {
  await ensureFlowMediaMode(page, "image");
  if (modelOverride) await ensureImageModel(page, modelOverride);
  else await ensureNanoBanana(page);
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
export async function ensureFlowAspectRatio(page: Page, aspect: string): Promise<boolean> {
  const wanted = (aspect || "16:9").trim();
  if (!/^\d+:\d+$/.test(wanted)) return false;
  const custom = getSetting("FLOW_ASPECT_RATIO_SELECTOR").trim();
  const pattern = new RegExp(wanted.replace(":", "\\s*:\\s*"));
  if (custom) {
    const el = page.locator(custom);
    if (await el.first().isVisible().catch(() => false)) {
      await el.first().click().catch(() => undefined);
      return true;
    }
  }

  // The ratio options are role="radio" controls INSIDE the composer settings popover —
  // verified live, see openComposerSettingsPopover's doc comment: "16:9" and "9:16" (plus
  // 4:3/1:1/3:4) render as sibling radios at once, so "the wanted text is visible somewhere
  // on the page" used to be true regardless of which one was actually active, and the old
  // early-return reported success without ever clicking — a beat asking for 9:16 could
  // silently keep whatever ratio was already selected. Clicking an already-checked radio
  // is harmless, so this never needs to know the prior state.
  if (await openComposerSettingsPopover(page)) {
    const radio = page.getByRole("radio", { name: pattern });
    if (await radio.first().isVisible().catch(() => false)) {
      await radio.first().click().catch(() => undefined);
      // Same settle wait as ensureFlowMediaMode: closing the popover right after the click
      // was observed live to occasionally race the app's own state commit.
      await page.waitForTimeout(400);
      await dismissOpenOverlays(page);
      return true;
    }
    await dismissOpenOverlays(page);
  }

  // Legacy fallback for a layout without this popover (kept for layouts never inspected live).
  const directOption = page.getByRole("button", { name: pattern });
  if (await directOption.first().isVisible().catch(() => false)) {
    await directOption.first().click().catch(() => undefined);
    return true;
  }
  const controls = [page.getByRole("button", { name: /Aspect|Ratio|Proportion|Formato|Proporção/i })];
  for (const group of controls) {
    const count = Math.min(await group.count().catch(() => 0), 6);
    for (let i = count - 1; i >= 0; i--) {
      const control = group.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;
      await control.click().catch(() => undefined);
      const option = page.getByRole("button", { name: pattern }).last();
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

/** The chip Flow shows in the command box once an asset is attached: a button holding an
 *  `img` whose alt reads "Imagem do elemento" (pt-BR) — verified live 2026-09-24, and it is
 *  also what clicking removes again. Structural (an img alt containing "lement") rather than
 *  the localized aria-label, and NOT `[aria-label*="lemen"]`: the "+" button itself is named
 *  "Adicionar ELEMENTOS à caixa de comando". */
function attachedElementChips(page: Page): Locator[] {
  return [
    page.locator('button:has(img[alt*="lement" i])'),
    page.locator('button[aria-label="Elemento"], button[aria-label="Element" i]'),
  ];
}

/**
 * Attach the reference through Flow's own asset picker — the ONLY mechanism verified
 * against a real account (2026-09-24, pt-BR), in BOTH layouts Flow renders depending on
 * window width:
 *   - compact: "+" opens a `role=dialog` overlay; its upload button is labeled "Enviar mídia".
 *   - wide:    "+" opens an inline popover (`flow-add-menu-popover-content`); no dialog, and the
 *              upload button has NO aria-label — only the visible text "upload Enviar mídia".
 * In both, the asset list is `flow-add-menu-asset-list` → `[role=option]` rows whose first
 * line is the file name, and CLICKING an existing row closes the picker and attaches it (the
 * chip above appears). A native file chooser exists only behind the upload button.
 *
 * What went wrong before: the old code only ever UPLOADED, never selected, and confirmed the
 * attach by looking for English "remove … reference" buttons. Every beat re-uploaded the file
 * (four identical assets piled up in the project), the confirmation could never recognise the
 * pt-BR chip, and worse, the chip that DID attach was never cleared — so a later beat that
 * wanted no reference was generated with the previous beat's still attached and came back as
 * the reference photo itself.
 *
 * The asset is uploaded under a name derived from the file's CONTENT, so it is uploaded once
 * per portrait and reused by name afterwards — and replacing the portrait can never resolve to
 * a stale asset that merely shares its file name. Returns false (never throws) so the caller
 * can fall through to the older heuristics for a layout this structure doesn't describe.
 */
export async function attachFlowReferenceViaAssetPicker(page: Page, referenceImagePath: string): Promise<boolean> {
  const buffer = fs.readFileSync(referenceImagePath);
  const ext = (path.extname(referenceImagePath) || ".jpg").toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const assetName = `character-reference-${sha256(buffer).slice(0, 8)}${ext}`;

  const plusCandidates = [
    page.locator('button[aria-label*="Adicionar elementos" i]'),
    page.locator('button[aria-label*="Add elements" i]'),
  ];
  const options = page.locator('flow-add-menu-asset-list [role="option"]');
  const chipVisible = async () => (await firstVisible(attachedElementChips(page))) !== null;
  const openPicker = async (): Promise<boolean> => {
    if (await options.first().isVisible().catch(() => false)) return true;
    const plus = await firstVisible(plusCandidates);
    if (!plus) return false;
    // Retried, not a single click: this exact "+" was observed live to occasionally not
    // open the picker at all right after a beat's generation just finished (2026-09-25) —
    // the same click-timing flakiness already retried for the model chip and the aspect-
    // ratio/media-mode popover elsewhere in this file. A single missed click here used to
    // fall through silently to the un-deduplicated legacy upload paths below, which re-
    // upload the portrait under its raw file name on every attempt instead of reusing the
    // one already-attached asset.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await page.waitForTimeout(300);
      await plus.click().catch(() => undefined);
      if ((await waitForVisible(page, [options], 1200)) !== null) return true;
    }
    return false;
  };
  const clickNamedAsset = async (): Promise<boolean> => {
    const count = Math.min(await options.count().catch(() => 0), 60);
    for (let i = 0; i < count; i++) {
      const row = options.nth(i);
      if (!(await row.isVisible().catch(() => false))) continue;
      const firstLine = ((await row.innerText().catch(() => "")) || "").split("\n")[0].trim();
      if (firstLine === assetName) {
        // Retried, verified click: this row click was observed live to occasionally not
        // register at all (the SAME Flow click-timing flakiness already retried for the "+"
        // button above and the model/mode popovers elsewhere in this file). A single missed
        // click here used to fall all the way through to a fresh upload — creating yet
        // another duplicate — and the caller's own post-upload poll loop re-calls this exact
        // function every 700ms without ever giving THIS click a second try, so the same miss
        // could repeat for the full ~25s deadline (observed live, 2026-09-25).
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await page.waitForTimeout(300);
          await row.click({ timeout: 3000 }).catch(() => undefined);
          if ((await waitForVisible(page, attachedElementChips(page), 1200)) !== null) return true;
        }
        return true; // row was found and clicked at least once — caller re-checks the chip
      }
    }
    return false;
  };
  const closePicker = () => dismissOpenOverlays(page);

  if (!(await openPicker())) {
    await closePicker();
    return false;
  }

  // 1) Already uploaded on an earlier beat/run: just select it.
  if (await clickNamedAsset()) {
    return (await waitForVisible(page, attachedElementChips(page), 4000)) !== null;
  }

  // 2) Upload it once. The upload button is found by its Material icon ligature ("upload"),
  //    which is language-neutral, alongside the localized labels. NOTE the live button's
  //    textContent is "uploadEnviar mídia" — the icon text is GLUED to the label, so there is no
  //    word boundary after "upload" and a `\b` there never matches (found live: 0 of 3 selectors).
  const upload = await firstVisible([
    page.locator("button.sidebar-upload-btn"),
    page.locator('flow-add-menu-popover-content button, [role="dialog"] button').filter({ hasText: /^\s*upload/i }),
    page.locator('button[aria-label="Enviar mídia"], button[aria-label*="Upload media" i]'),
  ]);
  if (!upload) {
    await closePicker();
    return false;
  }
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null);
  await upload.click().catch(() => undefined);
  const chooser = await chooserPromise;
  if (!chooser) {
    await closePicker();
    return false;
  }
  await chooser.setFiles({ name: assetName, mimeType, buffer });

  // The upload may attach the file on its own, or may only add it to the list (and the
  // picker may or may not stay open) — not observed which, so handle each: wait for the chip,
  // and otherwise select the freshly listed asset by name.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await chipVisible()) return true;
    // A freshly uploaded asset is LISTED well before it is clickable (~15 s live): a click on it
    // can be ignored, so keep retrying until the chip appears or the deadline passes — do not
    // give up on the first click that produced nothing.
    if ((await openPicker()) && (await clickNamedAsset())) {
      if ((await waitForVisible(page, attachedElementChips(page), 3000)) !== null) return true;
    }
    await page.waitForTimeout(700);
  }
  await closePicker();
  return false;
}

async function uploadFlowReference(page: Page, input: Locator, referenceImagePath: string): Promise<void> {
  if (!fs.existsSync(referenceImagePath)) {
    throw new FlowBrowserError("The configured character reference image no longer exists on disk.", "config");
  }

  // The verified live path — see attachFlowReferenceViaAssetPicker's doc comment. FIRST, ahead
  // of the older heuristics below: feeding a stray hidden file input directly can UPLOAD the
  // file without attaching it, which is indistinguishable from success until the confirmation
  // fails one step later.
  if (await attachFlowReferenceViaAssetPicker(page, referenceImagePath)) return;

  // In some Flow layouts the hidden image input is already mounted and can be fed
  // directly. (None exists at rest in the layouts verified live.)
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
  //
  // Bilingual on purpose (EN + pt-BR): every OTHER accessible-name regex in this file that
  // targets a menu/mode control already carries a pt-BR alternative (ensureFlowMediaMode,
  // ensureFlowAspectRatio, ensureFlowDuration, tryDownloadFromUi, detectFlowFailure's own
  // policy-violation text) — this trigger list was the one left English-only, on an account
  // whose UI is confirmed pt-BR (its OTHER composer controls read "Gatilho de
  // configurações" / "Selecionar família de modelos"). The generic "+"-style attach button
  // next to the prompt box (visible in the live UI) plausibly carries a name like
  // "Adicionar mídia"/"Anexar arquivo" that none of the EN-only patterns below could ever
  // match — which is a simpler explanation for "no upload control found" than the control
  // not existing at all.
  const triggers = [
    page.getByRole("button", {
      name: /Add (?:an? )?(?:ingredient|reference|image|media)|Reference image|Character reference|Ingredient|Upload image|Adicionar (?:um[a]? )?(?:ingrediente|refer[êe]ncia|imagem|m[íi]dia|anexo)|Imagem de refer[êe]ncia|Refer[êe]ncia de personagem|Ingrediente|Carregar imagem|Anexar (?:arquivo|imagem|m[íi]dia)?/i,
    }),
    page.locator('button[aria-label*="ingredient" i], [role="button"][aria-label*="ingredient" i]'),
    page.locator('button[aria-label*="reference" i], [role="button"][aria-label*="reference" i]'),
    page.locator('button[aria-label*="upload" i], [role="button"][aria-label*="upload" i]'),
    page.locator('button[aria-label*="ingrediente" i], [role="button"][aria-label*="ingrediente" i]'),
    page.locator('button[aria-label*="refer" i], [role="button"][aria-label*="refer" i]'), // matches both "reference" and "referência"
    page.locator('button[aria-label*="anexar" i], [role="button"][aria-label*="anexar" i]'),
    page.locator('button[aria-label*="adicionar" i], [role="button"][aria-label*="adicionar" i]'),
    page.locator('[data-testid*="ingredient" i], [data-testid*="reference" i], [data-testid*="upload" i], [data-testid*="attach" i]'),
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

  // Closes whatever the last failed trigger may have opened (a panel that ignored
  // Escape, or one opened by a trigger candidate that had no Escape-safe path). The
  // NEXT thing to run in this same page is either another attempt (a different model,
  // via generateFlowImage's fallback) or another beat entirely — either must start from
  // a clean composer, not from whatever this failed search left on screen.
  await page.keyboard.press("Escape").catch(() => undefined);
  const diag = await diagnoseComposerControls(page);
  throw new FlowBrowserError(
    `Could not find Flow's reference-image upload control. Open an image-generation project with Nano Banana, or set FLOW_REFERENCE_FILE_SELECTOR in Advanced settings. ${diag}`,
    "ui"
  );
}

/** Shared by clearFlowReferences (click to remove) and confirmReferenceAttached (look, don't click). */
function referenceRemoveControls(page: Page): Locator[] {
  const custom = getSetting("FLOW_REFERENCE_REMOVE_SELECTOR").trim();
  return [
    ...(custom ? [page.locator(custom)] : []),
    // The real chip (verified live, pt-BR): clicking it removes the attachment. None of the
    // English aria-label patterns below can match it, which is why a leftover attachment used
    // to survive into the next beat.
    ...attachedElementChips(page),
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
// Exported so tests exercise THIS function (with a fake Page/Locator) rather than
// re-implementing the clear-then-attach sequencing. Nothing else imports it directly.
export async function prepareComposerReference(page: Page, input: Locator, referenceImagePath: string | null): Promise<boolean> {
  await clearFlowReferences(page);
  if (!referenceImagePath) {
    // Fail closed: a beat that asked for NO reference must never be generated with the
    // previous beat's still attached. Observed live: it came back as the reference photo
    // itself, in place of the scene the beat described.
    if (await confirmReferenceAttached(page)) {
      const diag = await diagnoseComposerControls(page);
      throw new FlowBrowserError(
        `A reference image from a previous beat is still attached and could not be cleared — refusing to generate a ` +
          `beat that wants no reference with one attached. ${diag}`,
        "ui"
      );
    }
    return false;
  }
  // The attach is a multi-step UI dance and was observed to miss once under load right after
  // a failed generation, while succeeding on an idle tab — so retry from a clean slate
  // (overlays closed, no half-attached chip) before declaring the upload failed.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await dismissOpenOverlays(page);
      await clearFlowReferences(page);
      await page.waitForTimeout(1500);
    }
    await uploadFlowReference(page, input, referenceImagePath).catch((e) => {
      if (e instanceof FlowBrowserError && e.code === "config") throw e;
    });
    if (await confirmReferenceAttached(page)) return true;
  }
  const diag = await diagnoseComposerControls(page);
  throw new FlowBrowserError(
    `Character reference was sent to Google Flow but no attachment could be confirmed afterward — treating this as a ` +
      `failed upload rather than silently generating without the reference. ${diag}`,
    "ui"
  );
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Is `buf` the reference photo itself, not a generated result? Flow's own UI can echo the
 * just-attached reference back over the network — e.g. to render its attachment chip/
 * preview — WHILE the per-generation response listener is already active, and the capture
 * heuristic (any full-size image response) has no other way to tell that echo apart from
 * the real output. Observed in the field: a beat that requested a character-reference
 * scene sometimes produced the raw reference photo, unmodified, as its "generated" visual.
 *
 * Two checks, cheapest first:
 *  - byte-identical (sha256): the echo is a verbatim pass-through of the uploaded file —
 *    zero false-positive risk, since this can only be the SAME file.
 *  - near-identical pixels at a tiny thumbnail: catches a re-encoded/resized echo (still
 *    the same photo, different bytes). The threshold is deliberately tight — a genuinely
 *    different generated image (even one that faithfully reuses the reference's identity,
 *    which is the whole point of attaching it) differs far more than this at pixel level,
 *    since pose/background/lighting/crop all change; only the SAME photo survives this bar.
 */
export async function looksLikeReferenceEcho(buf: Buffer, referenceImagePath: string | undefined): Promise<boolean> {
  if (!referenceImagePath) return false;
  let refBuf: Buffer;
  try {
    refBuf = fs.readFileSync(referenceImagePath);
  } catch {
    return false;
  }
  if (buf.length === refBuf.length && sha256(buf) === sha256(refBuf)) return true;
  try {
    // removeAlpha()+toColourspace("srgb") forces both raw buffers to the SAME channel
    // count regardless of source format — an opaque JPEG echo decodes to RGB (3
    // channels) while the reference PNG can decode to RGBA (4), and without normalizing
    // that mismatch the two buffers would never be the same length and this check would
    // always (silently) fail open for exactly the cross-format case it needs to catch.
    const [a, b] = await Promise.all([
      sharp(buf).resize(32, 32, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer(),
      sharp(refBuf).resize(32, 32, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer(),
    ]);
    if (a.length === 0 || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    return diff / a.length < 3; // mean per-channel diff, 0-255 scale — near-identical pixels only
  } catch {
    return false;
  }
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

async function tryDownloadFromUi(page: Page, outPath: string, referenceImagePath?: string): Promise<boolean> {
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
    if (await looksLikeReferenceEcho(fs.readFileSync(tmp), referenceImagePath)) {
      throw new Error("download is the attached reference photo, not a generated result");
    }
    await sharp(tmp).png().toFile(outPath);
    try { fs.unlinkSync(tmp); } catch {}
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure classifier over whatever text is currently visible on the Flow page — split out
 * from detectFlowFailure so it can be unit-tested with a plain string instead of a fake
 * Playwright Page. Exported for tests only.
 */
const CREDITS_FAILURE_RE = /out of (?:AI |Flow )?credits|not enough credits|créditos insuficientes|sem créditos|limite de uso|usage limit|reached (?:your |the )?(?:usage )?limit/i;
const POLICY_FAILURE_RE = /may violate|might violate|against our polic|policy violation|talvez viol[ae]|viola(?:m)? (?:nossas |as )?pol[íi]ticas/i;
const GENERIC_FAILURE_RE = /generation failed|could(?:n'?t| not) generate|não foi possível gerar|tente novamente/i;

/** How many failure cards of each kind are ALREADY on the page. Flow keeps a failed tile in
 *  the project grid, so a refusal from an earlier beat/run is still in `body` — without a
 *  baseline it is read as this generation failing (measured: three object-only beats with
 *  no reference were "refused" ~17 s after submit by a stale card). */
export interface FlowFailureBaseline { policy: number; generic: number; credits: number }

function countMatches(body: string, re: RegExp): number {
  return (body.match(new RegExp(re.source, "gi")) || []).length;
}

export function failureBaselineOf(body: string): FlowFailureBaseline {
  return { policy: countMatches(body, POLICY_FAILURE_RE), generic: countMatches(body, GENERIC_FAILURE_RE), credits: countMatches(body, CREDITS_FAILURE_RE) };
}

export function classifyFlowFailureBody(body: string, media: "image" | "video" = "image", baseline?: FlowFailureBaseline): FlowBrowserError | null {
  if (CREDITS_FAILURE_RE.test(body) && (!baseline || countMatches(body, CREDITS_FAILURE_RE) > baseline.credits)) {
    return new FlowBrowserError("Google Flow reports that this account has no credits available or has reached its usage limit.", "credits");
  }
  // Google's own safety/content-policy classifier rejecting the prompt — observed live as
  // "Esta geração talvez viole nossas políticas. Tente usar outro comando ou envie
  // feedback." This is its OWN failure card, phrased differently from a generic generation
  // failure ("tente novamente" never appears in it), so the pattern below used to miss it
  // entirely: the wait loop just sat there polling for an image that would never arrive
  // until the FULL per-attempt timeout elapsed, instead of failing in ~4s and handing off
  // to the configured fallback (kie.ai) the way every other detected failure already does.
  // A character-reference scene (identity locked to an uploaded photo) is a plausible
  // repeat trigger for this — see CLAUDE.md's Flow browser section for the caveat that
  // Avatar V/character-consistency features are unverified against Google's own policy
  // surface. This detector does not attempt to work around the classifier in any way; it
  // only recognizes Flow's OWN refusal message so the beat can fail fast and move on.
  if (POLICY_FAILURE_RE.test(body) && (!baseline || countMatches(body, POLICY_FAILURE_RE) > baseline.policy)) {
    return new FlowBrowserError(`Google Flow declined this ${media} generation as a possible policy violation.`, "policy");
  }
  if (GENERIC_FAILURE_RE.test(body) && (!baseline || countMatches(body, GENERIC_FAILURE_RE) > baseline.generic)) {
    return new FlowBrowserError(`Google Flow reported that ${media} generation failed.`, "ui");
  }
  return null;
}

async function readFlowBody(page: Page): Promise<string> {
  return (await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")).slice(-12_000);
}

async function flowFailureBaseline(page: Page): Promise<FlowFailureBaseline> {
  return failureBaselineOf(await readFlowBody(page));
}

async function detectFlowFailure(page: Page, media: "image" | "video" = "image", baseline?: FlowFailureBaseline): Promise<FlowBrowserError | null> {
  return classifyFlowFailureBody(await readFlowBody(page), media, baseline);
}

/** Generate one full-size image through the Google Flow web UI and save it as PNG. */
/** One image-generation attempt with a SPECIFIC model — no fallback logic in here, that
 *  lives in generateFlowImage() which calls this once or twice. */
async function attemptFlowImage(
  runId: string,
  prompt: string,
  outPath: string,
  aspect: string,
  options: { referenceImagePath?: string } | undefined,
  model: string
): Promise<string> {
  if (runId) checkCancelled(runId);
  const { page } = await launchBrowser();
  await gotoFlow(page);
  if (await pageHasLoginPrompt(page)) {
    throw new FlowBrowserError("Google login is required. Open Settings → Google Flow → Open Flow / login.", "login");
  }
  // A previous attempt in this SAME page (a failed reference-image search tries several
  // trigger buttons; the fallback-model retry in generateFlowImage reuses this same tab)
  // can leave a menu/panel open. Start every attempt from a clean composer — observed live:
  // "nano banana pro" confirmed fine on a beat's first attempt, then the SAME beat's
  // fallback-model retry failed to confirm "nano banana 2" right after a failed reference
  // search, which is consistent with (not yet proven to be) something that search opened
  // still sitting in front of the model picker on the retry.
  await dismissOpenOverlays(page);
  const input = await promptBox(page);
  await ensureFlowImageMode(page, model);
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
    const task = captureResponse(response).then(async (image) => {
      if (!image) return;
      // Reject the attached reference photo itself (Flow can echo it back over the
      // network, e.g. to render its attachment chip). Filtered HERE, not just at
      // final selection, so a quiet echo-only capture never satisfies the "a result
      // arrived" wait-loop condition below and cuts generation short before the real
      // image shows up.
      if (await looksLikeReferenceEcho(image.buffer, options?.referenceImagePath)) return;
      candidates.push(image);
      lastCaptureAt = Date.now();
    }).finally(() => tasks.delete(task));
    tasks.add(task);
  };
  page.on("response", onResponse);

  try {
    await input.fill(prompt.slice(0, 12_000));
    const failureBaseline = await flowFailureBaseline(page);
    if (await flowInsufficientCreditsWarning(page)) {
      throw new FlowBrowserError(
        "Google Flow will not submit this image: the account has insufficient credits for it (Flow shows \"Alerta de créditos insuficientes\").",
        "credits"
      );
    }
    await submitPrompt(page, input);
    const deadline = Date.now() + timeoutMs;
    let nextFailureCheck = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (runId) checkCancelled(runId);
      if (await pageHasLoginPrompt(page)) throw new FlowBrowserError("Google session expired during generation.", "login");
      if (candidates.length && Date.now() - lastCaptureAt >= 4_000) break;
      if (Date.now() >= nextFailureCheck) {
        const failure = await detectFlowFailure(page, "image", failureBaseline);
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
    if (await tryDownloadFromUi(page, outPath, options?.referenceImagePath)) return outPath;
    throw new FlowBrowserError(
      `No full-size Flow image was captured within ${Math.round(timeoutMs / 1000)}s. The UI may have changed.`,
      "timeout"
    );
  } finally {
    page.off("response", onResponse);
  }
}

/** A failure this specific rather than "the model tier is unavailable/limited" — trying a
 *  different model would not help, so the fallback tier is never attempted for these. */
export function isModelIndependentFailure(code: FlowBrowserError["code"] | undefined): boolean {
  return code === "login" || code === "config" || code === "policy";
}

export interface FlowImageResult {
  path: string;
  /** Which model actually produced this image — the primary FLOW_IMAGE_MODEL, or
   *  FLOW_IMAGE_MODEL_FALLBACK if the primary hit a limit/error and a fallback was
   *  configured. Lets the caller report the true provenance (e.g. "flow:nano-banana-2")
   *  instead of always claiming the primary model ran. */
  model: string;
}

/**
 * Generate one full-size image through the Google Flow web UI and save it as PNG.
 *
 * Falls back to FLOW_IMAGE_MODEL_FALLBACK (default empty = no fallback, today's
 * behavior unchanged) when the PRIMARY model (FLOW_IMAGE_MODEL) fails for any reason
 * EXCEPT one no model choice can fix (`login`, `config`) — e.g. Nano Banana Pro hitting
 * its own generation limit while Nano Banana / Nano Banana 2 still has quota. This is
 * deliberately not gated on recognizing a specific "you've hit your limit" message: that
 * exact wording has not been observed live, and a broad "any retryable failure" rule is
 * more robust to Google changing it than a guessed regex would be. The cost of trying the
 * fallback needlessly on a genuine full outage is a few extra seconds, not a paid retry —
 * Flow spends the operator's own Google account, not a per-call bill.
 */
export async function generateFlowImage(
  runId: string,
  prompt: string,
  outPath: string,
  aspect = "16:9",
  options?: { referenceImagePath?: string }
): Promise<FlowImageResult> {
  return enqueue(async () => {
    const primaryModel = (getSetting("FLOW_IMAGE_MODEL") || "nano-banana-pro").replace(/[-_]+/g, " ").trim();
    const fallbackModel = getSetting("FLOW_IMAGE_MODEL_FALLBACK").replace(/[-_]+/g, " ").trim();

    const LIMIT_COOLDOWN_MS = 30 * 60_000;
    const limited = state.limitedModels ?? (state.limitedModels = new Map<string, number>());
    const isLimited = (m: string) => (limited.get(m) ?? 0) > Date.now();
    const markLimited = (m: string, err: unknown) => {
      if (err instanceof FlowBrowserError && err.code === "credits") limited.set(m, Date.now() + LIMIT_COOLDOWN_MS);
    };

    if (isLimited(primaryModel) && (!fallbackModel || isLimited(fallbackModel))) {
      throw new FlowBrowserError("Google Flow usage limit was reached a moment ago on every configured model — not retrying yet.", "credits");
    }

    // The primary hit its usage limit a moment ago: don't spend ~20 s per beat re-discovering it.
    if (fallbackModel && isLimited(primaryModel) && !isLimited(fallbackModel)) {
      log(runId, "info", `Google Flow: "${primaryModel}" is at its usage limit — using "${fallbackModel}" directly`, { stage: "visual" });
      try {
        const p = await attemptFlowImage(runId, prompt, outPath, aspect, options, fallbackModel);
        return { path: p, model: fallbackModel };
      } catch (e) {
        markLimited(fallbackModel, e);
        throw e;
      }
    }

    try {
      const p = await attemptFlowImage(runId, prompt, outPath, aspect, options, primaryModel);
      return { path: p, model: primaryModel };
    } catch (e) {
      const err = e as Error;
      markLimited(primaryModel, err);
      const code = err instanceof FlowBrowserError ? err.code : undefined;
      if (!fallbackModel || isModelIndependentFailure(code)) throw err;
      log(
        runId,
        "warn",
        `Google Flow: "${primaryModel}" failed (${err.message.slice(0, 160)}) — trying fallback model "${fallbackModel}"`,
        { stage: "visual" }
      );
      try {
        const p = await attemptFlowImage(runId, prompt, outPath, aspect, options, fallbackModel);
        return { path: p, model: fallbackModel };
      } catch (e2) {
        markLimited(fallbackModel, e2);
        throw e2;
      }
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

/**
 * Every currently-resolved <video> src on the page, right now — a baseline taken BEFORE
 * submitting a prompt so a later check can tell a genuinely NEW result apart from one
 * already sitting in this (shared, reused) project's grid. Exported for tests.
 */
export async function currentFlowVideoSrcs(page: Page): Promise<string[]> {
  return page
    .locator("video")
    .evaluateAll((els: HTMLVideoElement[]) => els.map((v) => v.currentSrc || v.src).filter(Boolean))
    .catch(() => []);
}

/**
 * Fetch the newest result's video DIRECTLY from its <video> element's resolved src, rather
 * than waiting to catch an incidental network response for it. Verified live (2026-09-25):
 * a generation that finished rendering in Flow within ~90s still sat there, fully playable,
 * while the passive page.on("response") listener never captured a matching request at
 * all — Flow's front end binds the <video src> into the DOM as soon as the result card
 * renders, but the browser's own lazy media loading does not necessarily FETCH the bytes
 * until the element is scrolled into view or played, so nothing the passive listener
 * watches for ever fires. A direct GET on the resolved src sidesteps that: independently
 * confirmed live to return the full clip (video/mp4, correct Content-Length) even when no
 * "response" event for it was ever observed.
 *
 * `excludeSrcs` (a baseline taken before the prompt was submitted, see `currentFlowVideoSrcs`)
 * is required so a video already sitting in this shared/reused project's grid is never
 * mistaken for the beat's own new result — the search only considers a <video> element
 * whose resolved src was NOT already present before this beat's generation started.
 */
async function fetchVideoFromResultElement(page: Page, excludeSrcs: Set<string>): Promise<Buffer | null> {
  const els = await page.locator("video").all().catch(() => []);
  for (const el of els) {
    const src = await el.evaluate((v: HTMLVideoElement) => v.currentSrc || v.src).catch(() => "");
    if (!src || excludeSrcs.has(src)) continue;
    try {
      const resp = await page.request.get(src, { timeout: 20_000 });
      if (!resp.ok()) continue;
      if (!isVideoResponseCandidate(resp.headers()["content-type"] || "", src)) continue;
      return await resp.body();
    } catch {
      continue;
    }
  }
  return null;
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
    // Same reasoning as attemptFlowImage: a previous beat's failed reference-image search
    // can leave a menu/panel open in this shared page. Start clean.
    await dismissOpenOverlays(page);
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
    let newVideoElementSeen = false;
    const tmpPath = path.join(os.tmpdir(), `flow_veo_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    try {
      await input.fill(prompt.slice(0, 12_000));
      const failureBaseline = await flowFailureBaseline(page);
      // Baseline BEFORE submitting — see fetchVideoFromResultElement's doc comment. Without
      // it, a video already sitting in this shared/reused project's grid could be mistaken
      // for this beat's own result the instant the wait loop starts.
      const videoSrcBaseline = new Set(await currentFlowVideoSrcs(page));
      if (await flowInsufficientCreditsWarning(page)) {
        throw new FlowBrowserError(
          "Google Flow will not submit this video: the account has insufficient credits for it (Flow shows \"Alerta de créditos insuficientes\").",
          "credits"
        );
      }
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
        // A NEW <video> element resolving its src is proof the result rendered — proven
        // live to arrive well before the passive network listener ever captures anything
        // (see fetchVideoFromResultElement). Break out immediately rather than idling
        // until the quiet-window or the full timeout.
        const newSrcs = await currentFlowVideoSrcs(page);
        if (newSrcs.some((s) => !videoSrcBaseline.has(s))) {
          newVideoElementSeen = true;
          break;
        }
        if (Date.now() >= nextFailureCheck) {
          const failure = await detectFlowFailure(page, "video", failureBaseline);
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
          log(runId, "info", "Flow video captured via: download button", { stage: "visual" });
          return outPath;
        } catch (e) {
          try { fs.unlinkSync(tmpPath); } catch {}
          // Fall through rather than failing immediately — the Download button existing is
          // not proof the file behind it was good.
          log(runId, "debug", `Flow video download button produced an invalid file (${(e as Error).message.slice(0, 140)}) — trying the result's own <video> element`, { stage: "visual" });
        }
      }

      // 2) Fetch directly from the result's own <video> element (see its doc comment) —
      //    more reliable than waiting on an incidental network capture, and usually faster.
      const direct = await fetchVideoFromResultElement(page, videoSrcBaseline);
      if (direct && direct.byteLength >= MIN_FLOW_VIDEO_BYTES) {
        try {
          fs.writeFileSync(tmpPath, direct);
          await validateFlowVideoFile(tmpPath);
          fs.renameSync(tmpPath, outPath);
          log(runId, "info", `Flow video captured via: direct fetch of the result's <video> src (${(direct.byteLength / 1e6).toFixed(1)} MB — same file the manual "Fazer o download → Tamanho original" menu saves)`, { stage: "visual" });
          return outPath;
        } catch (e) {
          try { fs.unlinkSync(tmpPath); } catch {}
          log(runId, "debug", `Flow video element fetch produced an invalid file (${(e as Error).message.slice(0, 140)}) — trying captured network response`, { stage: "visual" });
        }
      }

      // 3) Fall back to the newest matching network response.
      const chosen = newestVideoCandidate(candidates);
      if (chosen) {
        try {
          const buffer = await chosen.response.body();
          if (buffer.byteLength >= MIN_FLOW_VIDEO_BYTES) {
            fs.writeFileSync(tmpPath, buffer);
            await validateFlowVideoFile(tmpPath);
            fs.renameSync(tmpPath, outPath);
            log(runId, "info", "Flow video captured via: network response", { stage: "visual" });
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
          `resultAppeared=${candidates.length > 0}, downloadButtonSeen=${downloadButtonSeen}, ` +
          `newVideoElementSeen=${newVideoElementSeen}]. The UI may have changed.`,
        "timeout"
      );
    } finally {
      page.off("response", onResponse);
    }
  });
}

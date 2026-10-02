import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { getSetting } from "../settings";
import { checkCancelled } from "../cancellation";
import { FlowBrowserError, flowChromeContext, pageIsAlive } from "./flow-browser";
import { log } from "../logger";

/**
 * ChatGPT as a free AI b-roll IMAGE provider, driven through the operator's own Chrome
 * over the SAME CDP connection flow-browser.ts already maintains (`flowChromeContext()`)
 * — its own tab, its own queue, no second Chrome/profile to log into. No API key: image
 * generation runs on the operator's logged-in ChatGPT session, same free-tier quota as
 * using the site by hand.
 *
 * Reuses FlowBrowserError (code union already covers everything this needs: config,
 * login, ui, timeout, credits, capture, policy) rather than defining a parallel type —
 * callers that already branch on FlowBrowserError.code (visual-source.ts) handle this
 * provider's failures identically to Flow's.
 *
 * Key design choice: the SAME conversation is reused across prompts (never re-navigated
 * per call) — same philosophy as generateVidsImage in vids-browser.ts. A snapshot of
 * every image src already on the page is taken right before a prompt is submitted; the
 * result is whichever src appears afterward that was NOT in that snapshot. This is what
 * makes reusing one conversation safe despite ChatGPT being a general-purpose chat (not
 * a dedicated creation tool like Flow/Vids) rather than relying on "there's only one
 * image on the page" — which an earlier version of this file did by opening a fresh
 * conversation per prompt; that was replaced because it left a visibly growing pile of
 * one-off conversations in the operator's ChatGPT sidebar for no benefit once the
 * before/after snapshot does the same disambiguation. The conversation is still
 * periodically recycled (CHATGPT_CONVO_RECYCLE_EVERY) so its DOM doesn't grow without
 * bound over a long run — same rationale as flow-browser.ts's maybeRecycleFlowTab.
 */

interface ChatGptState {
  page: Page | null;
  queue: Promise<void>;
  /** epoch ms until which a quota-looking failure said "stop trying ChatGPT" (survives hot reload). */
  limitedUntil: number;
  /** Generations in the CURRENT conversation (success or failure — the DOM grows either
   *  way). Reset to 0 whenever a fresh conversation is opened. See maybeRecycleConversation. */
  generationsThisConvo: number;
}
declare global {
  // eslint-disable-next-line no-var
  var __facelessChatGptState: ChatGptState | undefined;
}
const state: ChatGptState = globalThis.__facelessChatGptState ?? { page: null, queue: Promise.resolve(), limitedUntil: 0, generationsThisConvo: 0 };
globalThis.__facelessChatGptState = state;

const LIMIT_COOLDOWN_MS = 30 * 60_000;

/** How many generations to run in one conversation before starting a fresh one, purely to
 *  bound DOM growth over a long run — NOT needed for correctness (the before/after
 *  snapshot already disambiguates the result at any conversation length). Blank/0/negative
 *  disables recycling. Mirrors FLOW_TAB_RECYCLE_EVERY's role for the Flow tab. */
function recycleEveryN(): number {
  const n = Number(getSetting("CHATGPT_CONVO_RECYCLE_EVERY") || "25");
  return Number.isFinite(n) ? Math.round(n) : 25;
}

async function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = state.queue.catch(() => undefined);
  let release!: () => void;
  state.queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await task(); } finally { release(); }
}

export function chatGptLimitedNow(): boolean {
  return Date.now() < state.limitedUntil;
}

function chatGptUrl(): string {
  const configured = getSetting("CHATGPT_URL").trim();
  return configured || "https://chatgpt.com/";
}

function imageTimeoutMs(): number {
  const n = Number(getSetting("CHATGPT_IMAGE_TIMEOUT_SEC"));
  return Number.isFinite(n) && n > 0 ? Math.max(30, Math.min(600, Math.round(n))) * 1000 : 180_000;
}

/** Structural-first, text-fallback — same philosophy as flow-browser.ts's promptBox(). */
async function promptBox(page: Page): Promise<import("playwright").Locator> {
  const custom = getSetting("CHATGPT_PROMPT_SELECTOR").trim();
  const candidates = [
    ...(custom ? [page.locator(custom)] : []),
    page.locator("#prompt-textarea"),
    page.locator('div[contenteditable="true"][id*="prompt"]'),
    page.locator('form div[contenteditable="true"]'),
    page.locator('div[contenteditable="true"]'),
  ];
  for (const locator of candidates) {
    if (await locator.first().isVisible().catch(() => false)) return locator.first();
  }
  throw new FlowBrowserError("Could not find ChatGPT's prompt box.", "ui");
}

async function sendButton(page: Page): Promise<import("playwright").Locator | null> {
  const candidates = [
    page.locator('button[data-testid="send-button"]'),
    page.getByRole("button", { name: /send message|enviar mensagem/i }),
  ];
  for (const locator of candidates) {
    if (await locator.first().isVisible().catch(() => false)) return locator.first();
  }
  return null;
}

function looksLikeLogin(url: string): boolean {
  return /\/auth\/login|accounts\.google\.|chatgpt\.com\/auth/i.test(url);
}

/** Navigates to the bare ChatGPT URL, which always starts a brand-new conversation. */
async function startFreshConversation(page: Page): Promise<void> {
  await page.goto(chatGptUrl(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1200);
  if (looksLikeLogin(page.url())) throw new FlowBrowserError("Google login is required in the ChatGPT tab — sign in once in that window, then retry.", "login");
  state.generationsThisConvo = 0;
}

/** Reuses the existing ChatGPT tab/conversation when it's alive; only opens a fresh page
 *  (and conversation) the FIRST time, or after maybeRecycleConversation decides it's time. */
async function openChatGptPage(): Promise<Page> {
  const context = await flowChromeContext();
  const isChatGpt = (u: string) => /chatgpt\.com/.test(u);
  let page = (pageIsAlive(state.page) ? state.page : null) ?? context.pages().find((p) => isChatGpt(p.url()) && pageIsAlive(p)) ?? null;
  if (page) {
    state.page = page;
    return page;
  }
  page = await context.newPage();
  state.page = page;
  await startFreshConversation(page);
  return page;
}

/** Counter-based recycle, mirroring flow-browser.ts's maybeRecycleFlowTab — bounds how
 *  long a single conversation's DOM is allowed to grow, independent of correctness (the
 *  before/after snapshot in generateChatGptImage already identifies the right image at
 *  any conversation length). */
async function maybeRecycleConversation(page: Page, runId: string): Promise<void> {
  const every = recycleEveryN();
  if (every <= 0) return;
  state.generationsThisConvo += 1;
  if (state.generationsThisConvo < every) return;
  log(runId, "info", `ChatGPT: starting a fresh conversation after ${every} generations (preventive)`, { stage: "visual" });
  await startFreshConversation(page);
}

/** Image elements ChatGPT renders for a generated image. Verified live: the rendered
 *  <img> uses a `blob:` src (an in-page object URL), never a direct oaiusercontent.com
 *  URL — so capture (below) must fetch it from WITHIN the page, never via
 *  page.request.get(), which only supports http(s). The oaiusercontent.com match stays
 *  as a fallback in case ChatGPT ever renders a direct CDN src instead. */
async function assistantImageSrcs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.images)
      .filter((i) => (i.naturalWidth >= 256 && i.naturalHeight >= 256) && /oaiusercontent\.com|^blob:/.test(i.currentSrc || i.src))
      .map((i) => i.currentSrc || i.src)
  ).catch(() => []);
}

/** Fetches an image src (http(s) OR blob:) from WITHIN the page's own JS context and
 *  returns its bytes — a blob: URL is only resolvable inside the page that created it,
 *  so page.request.get() (which only speaks http/https) cannot reach it. */
async function fetchImageBytes(page: Page, src: string): Promise<{ buffer: Buffer; contentType: string }> {
  const dataUrl = await page.evaluate(async (url) => {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }, src);
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new FlowBrowserError("ChatGPT image fetch returned an unreadable data URL.", "capture");
  return { buffer: Buffer.from(match[2], "base64"), contentType: match[1] };
}

/** Last assistant message's plain text — used only to classify a refusal/limit, never trusted as the image result. */
async function lastAssistantText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const last = nodes[nodes.length - 1];
    return last ? (last.textContent || "") : "";
  }).catch(() => "");
}

/** Pure classifier for the last assistant message when no image appeared. Exported for tests. */
export function classifyChatGptFailure(text: string): { code: "credits" | "policy" | "capture"; message: string } | null {
  const t = text.trim();
  if (!t) return null;
  if (/usage cap|reached the current (usage )?limit|limite de uso|try again later|upgrade to (plus|go)/i.test(t)) {
    return { code: "credits", message: t.slice(0, 200) };
  }
  if (/can'?t (create|generate) (that|this) image|violat(es|e) (our|the) (content )?polic|não posso (criar|gerar) essa imagem/i.test(t)) {
    return { code: "policy", message: t.slice(0, 200) };
  }
  if (/something went wrong|an error occurred|algo deu errado/i.test(t)) {
    return { code: "capture", message: t.slice(0, 200) };
  }
  return null;
}

export interface ChatGptImageResult { path: string; width: number; height: number }

/** Generates ONE image from a text prompt via ChatGPT and saves it to `outPath`. */
export async function generateChatGptImage(runId: string, prompt: string, outPath: string): Promise<ChatGptImageResult> {
  return enqueue(async () => {
    if (chatGptLimitedNow()) throw new FlowBrowserError("ChatGPT reported a usage limit a moment ago — not retrying yet.", "credits");
    const page = await openChatGptPage();
    await maybeRecycleConversation(page, runId);

    // Snapshot BEFORE submitting — the result is whichever src appears afterward that
    // wasn't already here, so reusing one long conversation never picks a stale image.
    const before = new Set(await assistantImageSrcs(page));

    const box = await promptBox(page);
    await box.click({ timeout: 8000 });
    // Real key events, not fill() — ChatGPT's own composer only enables Send on genuine input events.
    await page.keyboard.type(`Generate an image: ${prompt}`.slice(0, 4000), { delay: 1 });
    const send = await sendButton(page);
    if (send) await send.click({ timeout: 8000 });
    else await page.keyboard.press("Enter");

    const deadline = Date.now() + imageTimeoutMs();
    const started = Date.now();
    while (Date.now() < deadline) {
      if (runId) checkCancelled(runId);
      await page.waitForTimeout(1500);
      const srcs = await assistantImageSrcs(page);
      const fresh = srcs.find((s) => !before.has(s));
      if (fresh) {
        const dims = await page.evaluate((src) => {
          const i = Array.from(document.images).find((x) => (x.currentSrc || x.src) === src);
          return i ? { w: i.naturalWidth, h: i.naturalHeight } : { w: 0, h: 0 };
        }, fresh);
        const { buffer, contentType } = await fetchImageBytes(page, fresh);
        if (buffer.length < 20_000 || !/^image\//.test(contentType)) {
          throw new FlowBrowserError(`ChatGPT returned an unusable image (${contentType}, ${buffer.length} bytes).`, "capture");
        }
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, buffer);
        log(runId, "success", "ChatGPT image captured via direct fetch of the rendered <img> src", { stage: "visual" });
        return { path: outPath, width: dims.w, height: dims.h };
      }
      if (Date.now() - started > 8000) {
        const failure = classifyChatGptFailure(await lastAssistantText(page));
        if (failure) {
          if (failure.code === "credits") state.limitedUntil = Date.now() + LIMIT_COOLDOWN_MS;
          throw new FlowBrowserError(`ChatGPT image generation failed: ${failure.message}`, failure.code);
        }
      }
    }
    throw new FlowBrowserError(`No ChatGPT image appeared within ${Math.round(imageTimeoutMs() / 1000)}s.`, "timeout");
  });
}

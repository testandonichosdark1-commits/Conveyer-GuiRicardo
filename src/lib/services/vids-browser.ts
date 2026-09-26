import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { getSetting } from "../settings";
import { checkCancelled } from "../cancellation";
import { FlowBrowserError, flowChromeContext, validateFlowVideoFile } from "./flow-browser";

/**
 * Google Vids as an AI b-roll provider (Nano Banana stills + Omni video), driven through the
 * operator's own Chrome over the same CDP connection Flow uses — never an extension, never remote code.
 *
 * Verified live 2026-09-26 (pt-BR account, docs.google.com/videos editor):
 *  - Image: side button "Gerar uma imagem" -> textarea "Descreva sua ideia…", aspect popover
 *    ("Proporção": Quadrado 1:1 / Paisagem 16:9 / Retrato 9:16), send button aria-label "Criar".
 *    ~10 s. The result is an <img src="…googleusercontent.com/gg-dl/…"> (1024x1024 at 1:1).
 *  - Video: side button "Gerar um vídeo com IA" -> `div[role=textbox]` "Descreva o vídeo…", settings chip
 *    ("Generation settings: Omni, 720p, Paisagem, 10 segundos") with a "Duração do vídeo" slider (3–10 s),
 *    send button aria-label "Gerar". ~30 s for 3 s. The result is a <video> whose src is
 *    `contribution-rt.usercontent.google.com/download?…` (H.264 1280x720 + AAC).
 *  - Neither result needs to be INSERTED into the Vids project: the element's src is fetched directly through
 *    the page's own cookie jar (`page.request.get`), the same trick that fixed the Flow video capture.
 *  - The account has a generation limit ("Faça upgrade para ter limites de geração de vídeo maiores"), whose
 *    exact failure text has never been observed — unrecognised failures surface the panel text verbatim.
 * Vids runs in its OWN tab with its OWN queue, so it works in parallel with Flow's serialized queue.
 */

interface VidsState {
  page: Page | null;
  queue: Promise<void>;
  /** epoch ms until which a quota-looking failure said "stop trying Vids" (survives hot reload). */
  limitedUntil: number;
  /** sha256 of the reference image last uploaded to the video composer's "Ingredientes" (null = none / unknown). */
  refHash: string | null;
}
declare global {
  // eslint-disable-next-line no-var
  var __facelessVidsState: VidsState | undefined;
}
const state: VidsState = globalThis.__facelessVidsState ?? { page: null, queue: Promise.resolve(), limitedUntil: 0, refHash: null };
state.refHash ??= null;
globalThis.__facelessVidsState = state;

const IMAGE_TIMEOUT_MS = 90_000;
const VIDEO_TIMEOUT_MS = 240_000;
const LIMIT_COOLDOWN_MS = 30 * 60_000;
/** Static Vids copy that mentions "upgrade"/"limit" all the time and must never be read as a failure. */
const STATIC_NOISE = /Faça upgrade para (editar vídeos|ter limites)|limites de geração de vídeo maiores|O Gemini no Workspace pode cometer erros|Insira o comando em inglês|Ainda não é possível usar outros idiomas|Os vídeos que não foram inseridos/i;

async function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = state.queue.catch(() => undefined);
  let release!: () => void;
  state.queue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await task(); } finally { release(); }
}

export function vidsLimitedNow(): boolean {
  return Date.now() < state.limitedUntil;
}

export function vidsAspectLabel(aspect: string): "Quadrado 1:1" | "Paisagem 16:9" | "Retrato 9:16" {
  const a = (aspect || "").replace(/\s/g, "");
  if (a === "9:16") return "Retrato 9:16";
  if (a === "1:1") return "Quadrado 1:1";
  return "Paisagem 16:9";
}

/** Pure classifier for the panel text seen when a generation ends without a result. Exported for tests. */
export function classifyVidsFailure(panelText: string): { code: "credits" | "policy" | "capture"; message: string } | null {
  const lines = panelText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !STATIC_NOISE.test(l));
  const hit = lines.find((l) => /não foi possível|não é possível|tente novamente|algo deu errado|erro|falha|limite|cota|excedeu|atingiu|violar|política|segurança|bloquead/i.test(l));
  if (!hit) return null;
  if (/limite|cota|excedeu|atingiu|crédito/i.test(hit)) return { code: "credits", message: hit.slice(0, 200) };
  if (/violar|política|segurança|bloquead/i.test(hit)) return { code: "policy", message: hit.slice(0, 200) };
  return { code: "capture", message: hit.slice(0, 200) };
}

async function vidsPage(): Promise<Page> {
  if (state.page && !state.page.isClosed()) return state.page;
  const context = await flowChromeContext();
  const isVids = (u: string) => /docs\.google\.com\/videos\/d\//.test(u);
  let page = context.pages().find((p) => isVids(p.url())) ?? null;
  if (!page) {
    const url = getSetting("VIDS_PROJECT_URL").trim();
    if (!url) {
      throw new FlowBrowserError("Open a Google Vids project in the Flow Chrome window (docs.google.com/videos/d/…) or set VIDS_PROJECT_URL.", "config");
    }
    page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
  }
  if (/accounts\.google\./.test(page.url())) throw new FlowBrowserError("Google login is required in the Vids tab.", "login");
  state.page = page;
  return page;
}

/** The welcome dialog ("Olá … Vamos começar a criar") covers the editor on first open. */
async function dismissWelcome(page: Page): Promise<void> {
  // A stray "Remover este clipe de vídeo?" confirmation (left by an earlier interaction) is modal and blocks every
  // control behind it — never confirm it, just cancel.
  const stray = page.getByText(/Remover este clipe de vídeo\?/i).first();
  if (await stray.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Cancelar" }).first().click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  const welcome = page.getByText(/Vamos começar a criar/i).first();
  if (await welcome.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Fechar" }).first().click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }
}

/** The panel is identified by its own unique input (a title/heading text also matches side-rail tooltips). */
function panelInput(page: Page, kind: "image" | "video") {
  return kind === "image"
    // The placeholder ROTATES after the first generation ("Uma imagem fotorrealista de uma mulher…"), so it cannot be
    // matched by text — the image panel simply owns the only visible textarea.
    ? page.locator("textarea").filter({ visible: true }).first()
    // Its aria-label CHANGES once an ingredient is attached ("Especifique como você quer usar os ingredientes…").
    : page.locator('div[role="textbox"][contenteditable="true"]').filter({ visible: true }).first();
}

async function openPanel(page: Page, kind: "image" | "video"): Promise<void> {
  const open = () => panelInput(page, kind).isVisible().catch(() => false);
  if (await open()) return;
  const side = page.getByRole("button", { name: kind === "image" ? /Gerar uma imagem/i : /Gerar um vídeo com IA/i }).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await side.click({ timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    if (await open()) return;
  }
  throw new FlowBrowserError(`Could not open the Vids "${kind === "image" ? "Gerar uma imagem" : "Gerar um vídeo com IA"}" panel.`, "ui");
}

async function panelText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText).catch(() => "");
}

async function imageSrcs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.images)
      .filter((i) => /googleusercontent\.com\/(gg-dl|rd-gg-dl)/.test(i.currentSrc || i.src) && i.naturalWidth >= 512)
      .map((i) => i.currentSrc || i.src)
  ).catch(() => []);
}

async function videoSrcs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("video"))
      .filter((v) => (v.currentSrc || v.src) && v.videoWidth > 0)
      .map((v) => v.currentSrc || v.src)
  ).catch(() => []);
}

async function setAspectForImage(page: Page, aspect: string): Promise<void> {
  const trigger = page.locator('[aria-label="Proporção"]').filter({ visible: true }).first();
  if (!(await trigger.count())) return; // best-effort: the default (1:1) still yields a usable still
  await trigger.click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  await page.getByText(vidsAspectLabel(aspect), { exact: false }).filter({ visible: true }).first().click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

async function setVideoSettings(page: Page, aspect: string, durationSec: number): Promise<void> {
  const chip = page.locator('[aria-label^="Generation settings"]').filter({ visible: true }).first();
  if (!(await chip.isVisible().catch(() => false))) {
    // The composer starts collapsed; its chevron ("Abrir") reveals the Avatar / Ingredientes / settings row.
    // There are several "Abrir" controls (a toast has one too): the composer's chevron is the one at the
    // bottom-right of the page, so pick it by position and click its centre.
    const spot = await page.evaluate(() => {
      const c = Array.from(document.querySelectorAll('[aria-label="Abrir"]'))
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.x > innerWidth * 0.6 && r.y > innerHeight * 0.55)
        .sort((a, b) => b.y - a.y)[0];
      return c ? { x: c.x + c.width / 2, y: c.y + c.height / 2 } : null;
    });
    if (spot) await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(900);
  }
  await chip.click({ timeout: 4000 });
  await page.waitForTimeout(700);
  const wantPortrait = vidsAspectLabel(aspect) === "Retrato 9:16";
  await page.getByText(wantPortrait ? "Retrato" : "Paisagem", { exact: true }).filter({ visible: true }).first().click({ timeout: 3000 }).catch(() => undefined);
  const slider = page.locator('[role="slider"][aria-label="Duração do vídeo"]').first();
  if (await slider.count()) {
    const min = Number((await slider.getAttribute("aria-valuemin")) || 3);
    const max = Number((await slider.getAttribute("aria-valuemax")) || 10);
    const target = Math.min(max, Math.max(min, Math.ceil(durationSec)));
    await slider.focus().catch(() => undefined);
    await page.keyboard.press("Home");
    for (let i = min; i < target; i++) await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

const REMOVE_INGREDIENT = '[aria-label="Remover imagem"]';

async function attachedIngredients(page: Page): Promise<number> {
  return page.locator(REMOVE_INGREDIENT).filter({ visible: true }).count().catch(() => 0);
}

async function clearIngredients(page: Page): Promise<void> {
  for (let i = 0; i < 4 && (await attachedIngredients(page)) > 0; i++) {
    await page.locator(REMOVE_INGREDIENT).filter({ visible: true }).first().click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(600);
  }
  state.refHash = null;
}

/**
 * Makes the composer's "Ingredientes" hold EXACTLY the wanted reference (or nothing). Clicking "Ingredientes" opens the native
 * file chooser directly (after Google's one-time rights notice, which the OPERATOR must accept — never auto-accepted here).
 * A stale ingredient left by a previous beat would put the character into a beat that must not have her, so a beat without a
 * reference always clears; the same reference is reused, not re-uploaded.
 */
async function syncReference(page: Page, referenceImagePath: string | null): Promise<void> {
  const attached = await attachedIngredients(page);
  if (!referenceImagePath) {
    if (attached > 0) await clearIngredients(page);
    return;
  }
  const hash = crypto.createHash("sha256").update(fs.readFileSync(referenceImagePath)).digest("hex").slice(0, 16);
  if (attached === 1 && state.refHash === hash) return;
  if (attached > 0) await clearIngredients(page);
  const chooser = page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null);
  await page.locator(':text-is("Ingredientes")').filter({ visible: true }).first().click({ timeout: 5000 });
  const fc = await chooser;
  if (!fc) {
    const notice = await page.getByText(/Criar conteúdo com imagens no Workspace/i).first().isVisible().catch(() => false);
    throw new FlowBrowserError(
      notice
        ? 'Google Vids is asking to accept its image-rights notice ("Criar conteúdo com imagens no Workspace"). Click "Concordo" once in the Vids tab, then retry.'
        : "Vids did not open a file chooser for the reference image.",
      notice ? "config" : "ui"
    );
  }
  await fc.setFiles(referenceImagePath);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (await attachedIngredients(page)) < 1) await page.waitForTimeout(500);
  if ((await attachedIngredients(page)) < 1) throw new FlowBrowserError("The reference image did not attach in Vids.", "ui");
  state.refHash = hash;
}

/** Types the prompt; with a reference, inserts Vids' own @-mention chip ("@" + Enter picks Imagem1) ahead of the scene text. */
async function typeVideoPrompt(page: Page, prompt: string, withReference: boolean): Promise<void> {
  const tb = panelInput(page, "video");
  await tb.click({ timeout: 8000 });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace"); // also drops the chip Vids auto-appends after an upload
  if (withReference) {
    await page.keyboard.type("The person from ", { delay: 2 });
    await page.keyboard.type("@", { delay: 2 });
    await page.waitForTimeout(900);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    if ((await tb.evaluate((e) => e.querySelectorAll("prompt-chip-wrapper").length).catch(() => 0)) < 1) {
      throw new FlowBrowserError("Vids did not insert the @Imagem1 reference chip into the prompt.", "ui");
    }
    await page.keyboard.type(" is the main subject. ", { delay: 2 });
  }
  await page.keyboard.type(prompt.slice(0, 2000), { delay: 2 });
}

export interface VidsImageResult { path: string; width: number; height: number }

/** Generates ONE still with Vids' Nano Banana and saves it to `outPath`. */
export async function generateVidsImage(runId: string, prompt: string, outPath: string, aspect = "16:9"): Promise<VidsImageResult> {
  return enqueue(async () => {
    if (vidsLimitedNow()) throw new FlowBrowserError("Google Vids reported a generation limit a moment ago — not retrying yet.", "credits");
    const page = await vidsPage();
    await dismissWelcome(page);
    await openPanel(page, "image");
    await setAspectForImage(page, aspect);

    const box = panelInput(page, "image");
    // Real key events, not fill(): Vids keeps the "Criar" button DISABLED after a programmatic value set (observed live).
    await box.click({ timeout: 8000 });
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(prompt.slice(0, 4000), { delay: 1 });
    const before = new Set(await imageSrcs(page));
    const send = page.locator('button[aria-label="Criar"]').filter({ visible: true }).last();
    await send.click({ timeout: 8000 });

    const deadline = Date.now() + IMAGE_TIMEOUT_MS;
    let sawGenerating = false;
    let retried = false;
    const started = Date.now();
    while (Date.now() < deadline) {
      if (runId) checkCancelled(runId);
      await page.waitForTimeout(1000);
      const now = await imageSrcs(page);
      const fresh = now.find((s) => !before.has(s));
      if (fresh) {
        const dims = await page.evaluate((src) => {
          const i = Array.from(document.images).find((x) => (x.currentSrc || x.src) === src);
          return i ? { w: i.naturalWidth, h: i.naturalHeight } : { w: 0, h: 0 };
        }, fresh);
        const res = await page.request.get(fresh, { timeout: 30_000 });
        const body = await res.body();
        if (!res.ok() || body.length < 20_000 || !/^image\//.test(res.headers()["content-type"] || "")) {
          throw new FlowBrowserError(`Vids returned an unusable image (HTTP ${res.status()}, ${body.length} bytes).`, "capture");
        }
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, body);
        return { path: outPath, width: dims.w, height: dims.h };
      }
      const text = await panelText(page);
      if (/Gerando/.test(text)) { sawGenerating = true; continue; }
      const failure = classifyVidsFailure(text);
      if (failure && (sawGenerating || Date.now() - started > 6000)) {
        if (failure.code === "credits") state.limitedUntil = Date.now() + LIMIT_COOLDOWN_MS;
        throw new FlowBrowserError(`Google Vids image generation failed: ${failure.message}`, failure.code);
      }
      // Never saw "Gerando…" and the prompt is still sitting there: the click did not register. Retry ONCE.
      if (!sawGenerating && !retried && Date.now() - started > 9000) {
        const stillFilled = await box.inputValue().then((v) => v.length > 0).catch(() => false);
        if (stillFilled) { retried = true; await send.click({ timeout: 5000 }).catch(() => undefined); }
      }
    }
    throw new FlowBrowserError(`No Vids image appeared within ${Math.round(IMAGE_TIMEOUT_MS / 1000)}s. Panel said: ${(await panelText(page)).split("\n").filter((l) => l.trim() && !STATIC_NOISE.test(l)).slice(-4).join(" | ").slice(0, 240)}`, "timeout");
  });
}

/** Generates ONE clip with Vids' Omni model and saves it to `outPath` (an mp4, audio included; the compositor strips it). */
export async function generateVidsVideo(runId: string, prompt: string, outPath: string, aspect = "16:9", durationSec = 5, referenceImagePath: string | null = null): Promise<string> {
  return enqueue(async () => {
    if (vidsLimitedNow()) throw new FlowBrowserError("Google Vids reported a generation limit a moment ago — not retrying yet.", "credits");
    const page = await vidsPage();
    await dismissWelcome(page);
    await openPanel(page, "video");
    await setVideoSettings(page, aspect, durationSec);

    await syncReference(page, referenceImagePath);
    await typeVideoPrompt(page, prompt, !!referenceImagePath);
    const before = new Set(await videoSrcs(page));
    const send = page.locator('button[aria-label="Gerar"]').filter({ visible: true }).first();
    await send.click({ timeout: 8000 });

    const deadline = Date.now() + VIDEO_TIMEOUT_MS;
    const started = Date.now();
    while (Date.now() < deadline) {
      if (runId) checkCancelled(runId);
      await page.waitForTimeout(2000);
      const fresh = (await videoSrcs(page)).find((s) => !before.has(s));
      if (fresh) {
        const res = await page.request.get(fresh, { timeout: 60_000 });
        const body = await res.body();
        if (!res.ok() || body.length < 100_000) throw new FlowBrowserError(`Vids returned an unusable video (HTTP ${res.status()}, ${body.length} bytes).`, "capture");
        const tmp = path.join(os.tmpdir(), `vids_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
        fs.writeFileSync(tmp, body);
        try {
          await validateFlowVideoFile(tmp);
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.renameSync(tmp, outPath);
        } catch (e) {
          try { fs.unlinkSync(tmp); } catch { /* best effort */ }
          throw e;
        }
        return outPath;
      }
      const failure = classifyVidsFailure(await panelText(page));
      if (failure && Date.now() - started > 8000) {
        if (failure.code === "credits") state.limitedUntil = Date.now() + LIMIT_COOLDOWN_MS;
        throw new FlowBrowserError(`Google Vids video generation failed: ${failure.message}`, failure.code);
      }
    }
    throw new FlowBrowserError(`No Vids video appeared within ${Math.round(VIDEO_TIMEOUT_MS / 1000)}s.`, "timeout");
  });
}

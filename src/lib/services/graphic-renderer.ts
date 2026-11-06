import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { resolveFfmpeg } from "../ffmpeg-bin";
import { getSetting } from "../settings";
import { pLimit } from "../plimit";
import { validateGraphicData, type GraphicTemplateKey, type GraphicWord } from "./graphic-templates";

/**
 * Graphic beats → silent MP4, deterministically.
 *
 * A template is an HTML page (src/graphics/templates/<key>.html) whose animations are all
 * paused; window.__seek(ms) poses them. We open it in headless Chromium at the output size,
 * call __setup once, then for every frame __seek(i*1000/fps) + screenshot, piping the PNGs
 * straight into ffmpeg (image2pipe → H.264 yuv420p). There is no wall clock anywhere in the
 * loop, so a slow machine renders the same frames as a fast one, just later.
 *
 * Chromium is Playwright's own bundled build, launched headless — NOT the operator's Chrome
 * that flow-browser.ts attaches to. Nothing here signs in to anything.
 */

export const GRAPHICS_DIR = path.join(process.cwd(), "src", "graphics");
export const GRAPHIC_FPS = 30;

export class GraphicRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphicRenderError";
  }
}

export type GraphicRenderInput = {
  template: GraphicTemplateKey | string;
  data: unknown;
  theme?: string;
  words?: GraphicWord[];
  durationSec: number;
  width?: number;
  height?: number;
};

type BrowserState = { browser: Promise<Browser> | null; limit: ReturnType<typeof pLimit> | null; limitSize: number };
const g = globalThis as unknown as { __facelessGraphicRenderer?: BrowserState };
const state: BrowserState = (g.__facelessGraphicRenderer ??= { browser: null, limit: null, limitSize: 0 });

export function graphicRenderConcurrency(): number {
  const n = Number.parseInt(getSetting("GRAPHIC_RENDER_CONCURRENCY") || "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 2;
}

function limiter() {
  const size = graphicRenderConcurrency();
  if (!state.limit || state.limitSize !== size) {
    state.limit = pLimit(size);
    state.limitSize = size;
  }
  return state.limit;
}

async function getBrowser(): Promise<Browser> {
  if (state.browser) {
    const b = await state.browser.catch(() => null);
    if (b && b.isConnected()) return b;
    state.browser = null;
  }
  state.browser = chromium.launch({
    headless: true,
    args: ["--font-render-hinting=none", "--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars"],
  });
  const b = await state.browser.catch((e) => {
    state.browser = null;
    throw new GraphicRenderError(`could not launch Chromium for graphic rendering: ${(e as Error).message}`);
  });
  b.on("disconnected", () => { state.browser = null; });
  return b;
}

/** Close the shared browser (tests; a run that is done with graphics). */
export async function closeGraphicBrowser(): Promise<void> {
  const p = state.browser;
  state.browser = null;
  if (p) await p.then((b) => b.close()).catch(() => {});
}

function templateUrl(template: string): string {
  const file = path.join(GRAPHICS_DIR, "templates", `${template}.html`);
  if (!fs.existsSync(file)) throw new GraphicRenderError(`graphic template file missing: ${file}`);
  return pathToFileURL(file).href;
}

/** Turn every `image` field into something the file:// page can load. */
export function resolveImageRef(ref: string): string {
  const sample = ref.match(/^sample:([a-z0-9_-]+)$/i);
  if (sample) {
    const file = path.join(GRAPHICS_DIR, "samples", `${sample[1]}.svg`);
    if (!fs.existsSync(file)) throw new GraphicRenderError(`unknown sample image "${sample[1]}"`);
    return pathToFileURL(file).href;
  }
  if (ref.startsWith("product:")) throw new GraphicRenderError(`product image "${ref.slice(8)}" was not resolved to a cut-out`);
  if (ref.startsWith("/")) {
    if (!fs.existsSync(ref)) throw new GraphicRenderError(`image not found: ${ref}`);
    return pathToFileURL(ref).href;
  }
  return ref;
}

/** Every `image` field, at any depth (versus sides, polaroid photos), made loadable. */
export function resolveImages<T>(data: T): T {
  if (Array.isArray(data)) return data.map((v) => resolveImages(v)) as T;
  if (!data || typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    out[k] = k === "image" && typeof v === "string" ? resolveImageRef(v) : resolveImages(v);
  }
  return out as T;
}

export function frameCount(durationSec: number, fps = GRAPHIC_FPS): number {
  return Math.max(1, Math.round(durationSec * fps));
}

/** Open a page and run __setup. The caller must close the page. */
async function preparePage(input: GraphicRenderInput): Promise<{ page: Page; durationMs: number }> {
  const v = validateGraphicData(String(input.template), input.data);
  if (!v.ok) throw new GraphicRenderError(v.error);
  if (!(input.durationSec > 0) || input.durationSec > 120) throw new GraphicRenderError(`bad graphic duration: ${input.durationSec}s`);
  const width = Math.round(input.width || 1920);
  const height = Math.round(input.height || 1080);
  const durationMs = Math.round(input.durationSec * 1000);
  const data = resolveImages(v.data);

  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  try {
    await page.goto(templateUrl(String(input.template)), { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(
      ([d, theme, words, ms]) => (window as any).__setup(d, theme, words, { durationMs: ms }),
      [data, input.theme || "arden", input.words || [], durationMs] as const,
    );
  } catch (e) {
    await page.close().catch(() => {});
    const extra = pageErrors.length ? ` (page: ${pageErrors.join(" | ").slice(0, 300)})` : "";
    throw new GraphicRenderError(`graphic setup failed for ${input.template}: ${(e as Error).message}${extra}`);
  }
  return { page, durationMs };
}

type Capture = (ms: number) => Promise<Buffer>;

/**
 * Frame capture through CDP rather than page.screenshot(): Playwright's PNG encoder runs at
 * full zlib effort and measured ~400 ms per 1080p frame; `optimizeForSpeed` is still a
 * lossless PNG at ~80 ms. That is the difference between a 15-min video's graphics taking
 * ~2 h and ~25 min. The seek waits one animation frame so the capture can never be the
 * previous pose.
 */
async function capturer(page: Page): Promise<Capture> {
  const cdp = await page.context().newCDPSession(page);
  return async (ms: number) => {
    await page.evaluate((t) => {
      (window as any).__seek(t);
      return new Promise<void>((r) => requestAnimationFrame(() => r()));
    }, ms);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false });
    return Buffer.from(data, "base64");
  };
}

/** PNG frames at each of `times` (ms), rendered on ONE page in order. */
export async function renderGraphicFrames(input: GraphicRenderInput, times: number[]): Promise<Buffer[]> {
  return limiter()(async () => {
    const { page, durationMs } = await preparePage(input);
    try {
      const capture = await capturer(page);
      const out: Buffer[] = [];
      for (const t of times) out.push(await capture(Math.min(Math.max(0, t), durationMs)));
      return out;
    } finally {
      await page.close().catch(() => {});
    }
  });
}

/** One PNG frame at `atMs` — for iterating on a design without encoding a clip. */
export async function renderGraphicFrame(input: GraphicRenderInput & { atMs: number }): Promise<Buffer> {
  const [png] = await renderGraphicFrames(input, [input.atMs]);
  return png;
}

/**
 * Render a graphic beat to a silent H.264 MP4 of exactly frameCount(durationSec) frames.
 * Throws GraphicRenderError on any failure; a partial output file is removed.
 */
export async function renderGraphicClip(
  input: GraphicRenderInput & { outPath: string; fps?: number; /** exact frame count (the compositor's own rounding of the beat) */ frames?: number },
): Promise<{ path: string; frames: number; ms: number }> {
  const fps = input.fps || GRAPHIC_FPS;
  const started = Date.now();
  return limiter()(async () => {
    const { page } = await preparePage(input);
    const frames = input.frames && input.frames > 0 ? Math.round(input.frames) : frameCount(input.durationSec, fps);
    fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
    const ff = spawn(resolveFfmpeg(), [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "pipe:0",
      "-frames:v", String(frames),
      "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
      "-r", String(fps), "-an", "-movflags", "+faststart",
      input.outPath,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (d) => { stderr += String(d); });
    const exited = new Promise<number>((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", (code) => resolve(code ?? -1));
    });
    let stdinError: Error | null = null;
    ff.stdin.on("error", (e) => { stdinError = e; });

    try {
      const capture = await capturer(page);
      for (let i = 0; i < frames; i++) {
        if (stdinError) throw stdinError;
        const png = await capture((i * 1000) / fps);
        if (!ff.stdin.write(png)) await new Promise<void>((r) => ff.stdin.once("drain", () => r()));
      }
      ff.stdin.end();
      const code = await exited;
      if (code !== 0) throw new GraphicRenderError(`ffmpeg exited ${code}: ${stderr.trim().slice(-400)}`);
      return { path: input.outPath, frames, ms: Date.now() - started };
    } catch (e) {
      ff.stdin.destroy();
      ff.kill("SIGKILL");
      await exited.catch(() => {});
      try { fs.unlinkSync(input.outPath); } catch {}
      if (e instanceof GraphicRenderError) throw e;
      throw new GraphicRenderError(`graphic render failed for ${input.template}: ${(e as Error).message}`);
    } finally {
      await page.close().catch(() => {});
    }
  });
}

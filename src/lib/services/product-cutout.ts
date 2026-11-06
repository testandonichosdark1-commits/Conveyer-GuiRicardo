import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DATA_DIR } from "../data-dir";
import { getSetting } from "../settings";
import { log } from "../logger";
import { recordGemini } from "./cost-ledger";
import { callGemini } from "./gemini-models";
import { searchStillPhotos } from "./visual-source";

/**
 * Cut-out product images for graphic beats (docs/SPEC-motion-graphics.md 3.5).
 *
 * A planner-written `product:<name>` becomes a transparent PNG cached at
 * `<DATA_DIR>/products/<slug>.png` — the same product appears many times in one video and
 * across videos, and is fetched once.
 *
 *  1. Photo: the FREE still sources only (wigolo / Openverse / Pixabay images), queried for
 *     "<name> product photo white background".
 *  2. Background: removed HERE, with sharp, by flood-filling the light background in from the
 *     image border. That only works on a product shot against a plain light ground — which is
 *     exactly what the query asks for — so a photo whose border is not mostly light is skipped
 *     rather than half-cut. No ML model, no new dependency: the spec's two options were
 *     @imgly/background-removal-node (AGPL, ~130 MB + onnxruntime) and rembg (Python, no
 *     wheels for this machine's Python), neither "without friction".
 *  3. Identity: Gemini looks at the cut-out and must agree it is that product; a wrong
 *     product on screen is worse than none. No GOOGLE_API_KEY → accepted unverified, logged.
 *
 * Any failure throws ProductImageError; the caller renders the beat as b-roll instead.
 * Not done yet: generating the product with the AI provider when no photo works.
 */

export class ProductImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductImageError";
  }
}

const UA = "FacelessVideoGenerator/0.1 (local video tool; contact: operator)";
const MAX_CANDIDATES = 8;
const inflight = new Map<string, Promise<string>>();

export function productSlug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "product";
}

export function productCacheDir(): string {
  return path.join(DATA_DIR, "products");
}

/** Light, unsaturated — what a studio "white" background looks like after JPEG. */
function isLight(r: number, g: number, b: number): boolean {
  const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
  return mn >= 222 && mx - mn <= 22;
}

/**
 * Remove a plain light background by flood fill from the border. Returns a trimmed
 * transparent PNG, or null when the image is not a product on a light ground (border not
 * light enough, or what is left is too small/too large to be one object). Exported for tests.
 */
export async function cutoutOnLightBackground(input: Buffer): Promise<Buffer | null> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, C = info.channels;
  if (C !== 4 || w < 64 || h < 64) return null;
  const px = (i: number) => isLight(data[i * C], data[i * C + 1], data[i * C + 2]);

  // 1. The border must be (almost) all background.
  let border = 0, light = 0;
  const seeds: number[] = [];
  const visitBorder = (x: number, y: number) => {
    const i = y * w + x;
    border++;
    if (px(i)) { light++; seeds.push(i); }
  };
  for (let x = 0; x < w; x++) { visitBorder(x, 0); visitBorder(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { visitBorder(0, y); visitBorder(w - 1, y); }
  if (light / border < 0.88) return null;

  // 2. Flood fill the light region connected to the border.
  const bg = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  for (const s of seeds) if (!bg[s]) { bg[s] = 1; stack[sp++] = s; }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w, y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const n of nb) if (n >= 0 && !bg[n] && px(n)) { bg[n] = 1; stack[sp++] = n; }
  }

  // 3. Keep the product, drop the debris: a shop photo often carries a logo, a model name or
  //    a badge printed beside the product (measured on a real run: "MINI MAGLITE 2AA" under
  //    the flashlight). Those are separate islands; anything under 12% of the largest goes.
  const comp = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (bg[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    comp[s] = id; stack[sp++] = s;
    while (sp > 0) {
      const i = stack[--sp];
      n++;
      const x = i % w, y = (i - x) / w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const m of nb) if (m >= 0 && !bg[m] && comp[m] < 0) { comp[m] = id; stack[sp++] = m; }
    }
    sizes.push(n);
  }
  const largest = sizes.length ? Math.max(...sizes) : 0;
  for (let i = 0; i < w * h; i++) if (!bg[i] && sizes[comp[i]] < largest * 0.12) bg[i] = 1;

  // 4. Alpha: background out; edge pixels next to it fade by how light they are, so the
  //    anti-aliased rim of the photo does not leave a white halo.
  let fg = 0;
  for (let i = 0; i < w * h; i++) {
    if (bg[i]) { data[i * C + 3] = 0; continue; }
    fg++;
    const x = i % w, y = (i - x) / w;
    const edge = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w]);
    if (edge) {
      const mn = Math.min(data[i * C], data[i * C + 1], data[i * C + 2]);
      data[i * C + 3] = Math.max(0, Math.min(255, Math.round(((255 - mn) / 70) * 255)));
    }
  }
  const coverage = fg / (w * h);
  if (coverage < 0.03 || coverage > 0.85) return null;
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().trim({ threshold: 1 }).toBuffer();
}

async function download(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok || !/^image\//.test(res.headers.get("content-type") || "")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= 15 * 1024 * 1024 ? buf : null;
  } catch {
    return null;
  }
}

export interface ProductVerdict { ok: boolean; layFlat: boolean }

/** Read the judge's JSON. Accepted only when it is the product AND nothing else is in frame. */
export function parseProductVerdict(text: string): ProductVerdict {
  const flag = (k: string) => new RegExp(`"${k}"\\s*:\\s*true`).test(text);
  return { ok: flag("match") && flag("isolated"), layFlat: flag("upright_long_object") };
}

/**
 * Is this cut-out `name`, alone? "Alone" is the half the first version lacked: a real run
 * accepted the right flashlight still standing on its shop's grey display plate, which then
 * filled the hero shot. Unverifiable (no key / judge down) → accepted as is, logged.
 */
async function judgeProduct(png: Buffer, name: string, runId: string): Promise<ProductVerdict> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) return { ok: true, layFlat: false };
  const small = await sharp(png).resize({ width: 512, height: 512, fit: "inside" }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [
      { text:
        `This is a cut-out product image (shown on white) for a documentary video. Answer strictly JSON ` +
        `{"match": true|false, "isolated": true|false, "upright_long_object": true|false}.\n` +
        `match: it is the product "${name}", or what a viewer would accept as exactly that product (a different product, a logo, packaging only, a person or a scene is not).\n` +
        `isolated: ONLY the product is visible — no table, plate, stand or surface, no reflection, no box, no logo or printed text graphics, no hand, no second object.\n` +
        `upright_long_object: it is a long thin handheld object (flashlight, pen, knife, tool) shown standing vertically.` },
      { inline_data: { mime_type: "image/jpeg", data: small.toString("base64") } },
    ] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 80, thinkingConfig: { thinkingBudget: 0 } },
  });
  try {
    const { json } = await callGemini({
      apiKey, model: getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL"), body, maxAttempts: 2, timeoutMs: 30_000,
      validate: (j, usedModel) => {
        recordGemini(runId, "geminiVision", j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0, usedModel);
      },
    });
    return parseProductVerdict((json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""));
  } catch (e) {
    log(runId, "warn", `Product check for "${name}" unavailable (${(e as Error).message.slice(0, 80)}) — accepting the cut-out unverified`, { stage: "visual" });
    return { ok: true, layFlat: false };
  }
}

/**
 * A long tool photographed standing up becomes a thin sliver in a 16:9 layout (a real run:
 * a 266×1100 flashlight drawn ~100 px wide). Lay it down, head to the left, as the reference
 * video shows every flashlight. Only for objects the judge called long and handheld, and only
 * when clearly portrait — a bottle stays upright.
 */
export async function layFlatIfUpright(png: Buffer, judgeSaysLong: boolean): Promise<Buffer> {
  if (!judgeSaysLong) return png;
  const m = await sharp(png).metadata();
  if (!m.width || !m.height || m.height / m.width < 1.8) return png;
  return sharp(png).rotate(270).png().toBuffer();
}

async function findProduct(name: string, runId: string, file: string): Promise<string> {
  const hits = await searchStillPhotos(`${name} product photo white background`, runId);
  if (!hits.length) throw new ProductImageError(`no photo found for "${name}"`);
  let tried = 0, cut = 0;
  for (const hit of hits.slice(0, MAX_CANDIDATES)) {
    tried++;
    const buf = await download(hit.url);
    if (!buf) continue;
    const cutout = await cutoutOnLightBackground(buf).catch(() => null);
    if (!cutout) continue;
    cut++;
    const verdict = await judgeProduct(cutout, name, runId);
    if (!verdict.ok) continue;
    const png = await layFlatIfUpright(cutout, verdict.layFlat);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, file);
    log(runId, "info", `Product "${name}": cut-out from ${hit.provider ?? "photo"} (${hit.sourceUrl ?? hit.url}) → ${path.basename(file)}`, { stage: "visual" });
    return file;
  }
  throw new ProductImageError(`no usable cut-out for "${name}" (${tried} photos tried, ${cut} on a plain background, none confirmed as the product alone)`);
}

/** Bumped whenever the cut-out rules change, so cut-outs made under the old rules (which a
 *  real run showed can include a display plate and a logo) are not served from cache. */
const CACHE_VERSION = "v2";

/** Path of a transparent PNG of `name`, from cache or freshly cut. Throws ProductImageError. */
export async function resolveProductImage(name: string, runId: string): Promise<string> {
  const file = path.join(productCacheDir(), `${productSlug(name)}.${CACHE_VERSION}.png`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const key = file;
  let p = inflight.get(key);
  if (!p) {
    p = findProduct(name.trim(), runId, file).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

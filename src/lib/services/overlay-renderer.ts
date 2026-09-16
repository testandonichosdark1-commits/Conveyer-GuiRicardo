import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { log } from "../logger";
import type { Beat, Overlay } from "./studio-plan";
import { DEFAULT_OVERLAY_THEME, PRESTIGE_THEME, type OverlayTheme } from "./overlay-themes";

// Re-exported so existing importers (tests, assembler) keep resolving these from the renderer.
export { DEFAULT_OVERLAY_THEME } from "./overlay-themes";
export type { OverlayTheme } from "./overlay-themes";

/**
 * OverlayRenderer — the typography layer.
 *
 * The ONE place overlay pixels are produced. It turns a beat's semantic {@link Overlay} into
 * (1) a rasterized card PNG on disk and (2) an ffmpeg `overlay`/`fade` filter fragment. The
 * assembler stays dumb: it adds the returned PNGs as inputs and drops the returned `filter` into
 * a single `-filter_complex`. No `drawtext`, and no font/escaping concern leaks into the
 * assembler — everything text-related lives here.
 *
 * WHY a rasterized card and not `drawtext`: the target ffmpeg builds ship WITHOUT libfreetype
 * (no `drawtext`) and without libass (no `subtitles`). The `overlay` filter is always present.
 * So the card is drawn with sharp → a transparent PNG → composited by `overlay`. It also makes
 * theming trivial: the appearance is entirely a passed {@link OverlayTheme}, so a new look is a
 * new theme value, never a renderer change.
 *
 * Contract with the assembler:
 *   - ffmpeg input 0 is the base video ([0:v]); the returned `inputs[]` are cards, added in order
 *     as inputs 1..N (each with `-loop 1 -i`). The `filter` references them as [1:v]..[N:v] and
 *     ends in a single [vout] pad.
 *   - Everything is best-effort: a card that fails to render is skipped; if none survive the plan
 *     is null and the video ships with no overlays. Overlays NEVER fail a render.
 */

export interface OverlayCard {
  pngPath: string;
  /** Absolute seconds on the master timeline. */
  startSec: number;
  endSec: number;
  /** Top-left composite position, in output pixels. */
  x: number;
  y: number;
}

export interface OverlayPlan {
  /** Card PNG paths, in the order the assembler must add them as inputs 1..N. */
  inputs: string[];
  /** filter_complex body: base [0:v] + cards [1:v].. → single [vout]. */
  filter: string;
}

/**
 * Theme for one overlay, chosen by its semantic type. Rank/chapter cards (`section`) and year
 * stamps (`date`) get the large centred serif PRESTIGE treatment — this is what makes a countdown
 * "10" render large and on the baseline. Everything else stays on the documentary lower-third.
 */
export function themeForOverlay(overlay: Overlay): OverlayTheme {
  return overlay.type === "section" || overlay.type === "date" ? PRESTIGE_THEME : DEFAULT_OVERLAY_THEME;
}

/** XML/SVG text escaping — the ONLY untrusted text (planner-authored) reaches an SVG here. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Uppercase a title while KEEPING a decade's lowercase suffix: "1930s" → "1930s", not "1930S".
 *
 * The planner writes decades the way a human does, and a capital S welded to a year reads as a
 * typo on screen. Only a suffix directly after digits is spared — an ordinary word-initial S, and
 * ordinals like "19th Century" (correctly "19TH CENTURY" in caps), are untouched.
 */
export function titleCaseForDisplay(text: string): string {
  return text.toUpperCase().replace(/(\d)S\b/g, "$1s");
}

/**
 * Per-glyph advance widths as a fraction of the font size, for a serif/sans display face.
 *
 * A single flat average was wrong in BOTH directions: capitals are far wider than the old 0.58
 * constant (so an all-caps title over-ran the box it had itself been sized from), while the same
 * constant over-counted a mixed-case string (so "Asheville, North Carolina" was cut mid-word).
 * Still an estimate, not metrics — no measuring dependency at this layer — but case-aware.
 */
function glyphAdvance(ch: string): number {
  if (ch === " ") return 0.26;
  if (/[.,;:'!|]/.test(ch)) return 0.28;
  if (/[iIlj]/.test(ch)) return 0.32;
  if (/[frt()[\]-]/.test(ch)) return 0.38;
  if (/[A-Z]/.test(ch)) return 0.72;
  if (/[0-9]/.test(ch)) return 0.56;
  if (/[mwMW]/.test(ch)) return 0.88;
  return 0.5; // ordinary lowercase
}

/** Estimated width in px. `tracking` is the theme's letter-spacing, which genuinely widens a line.
 *  Exported so a test can assert the card box was sized from the SAME measure that positions the
 *  glyphs — the mismatch between those two is exactly what let text bleed past the padding. */
export function estimateTextWidth(text: string, fontSize: number, tracking = 0): number {
  let em = 0;
  for (const ch of text) em += glyphAdvance(ch);
  return Math.ceil(em * fontSize + text.length * tracking);
}

/** How far the title may shrink to avoid being cut. Below this it stops being a display title. */
const MIN_TITLE_SCALE = 0.72;

/**
 * Fit a title to `maxWidth` by SHRINKING first and only truncating as a last resort.
 *
 * Cutting a title is destructive and unrecoverable for the viewer — "ASHEVILLE, NORTH CAROL…"
 * tells them less than the same words one size smaller. So step the size down to MIN_TITLE_SCALE,
 * and ellipsize only if it still does not fit, which for a realistic title now essentially never
 * happens.
 */
export function fitTitle(
  text: string,
  fontSize: number,
  maxWidth: number,
  tracking: number
): { text: string; fontSize: number; tracking: number } {
  if (estimateTextWidth(text, fontSize, tracking) <= maxWidth) return { text, fontSize, tracking };
  const floor = Math.max(1, Math.round(fontSize * MIN_TITLE_SCALE));
  for (let size = fontSize - 1; size >= floor; size--) {
    // Tracking is a ratio of the size, so it must shrink with it — otherwise a shrunk title keeps
    // display-sized letterspacing and the saving is largely given back.
    const tr = fontSize > 0 ? Math.round((tracking * size) / fontSize) : tracking;
    if (estimateTextWidth(text, size, tr) <= maxWidth) return { text, fontSize: size, tracking: tr };
  }
  const tr = fontSize > 0 ? Math.round((tracking * floor) / fontSize) : tracking;
  return { text: truncateToWidth(text, floor, maxWidth, tr), fontSize: floor, tracking: tr };
}

/** Trim a single line to fit `maxWidth`, appending an ellipsis when it had to cut. */
function truncateToWidth(text: string, fontSize: number, maxWidth: number, tracking = 0): string {
  if (estimateTextWidth(text, fontSize, tracking) <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && estimateTextWidth(`${s}…`, fontSize, tracking) > maxWidth) s = s.slice(0, -1);
  return `${s.replace(/\s+$/, "")}…`;
}

/**
 * Greedily wrap `text` into at most `maxLines` lines that each fit `maxWidth`, ellipsizing the
 * last line if words remain. Guarantees every returned line fits (a single over-long word is
 * truncated) — this is what makes a long subtitle resilient instead of clipped or overflowing.
 */
function wrapText(text: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = "";
  let truncated = false;
  for (let i = 0; i < words.length; i++) {
    const trial = cur ? `${cur} ${words[i]}` : words[i];
    if (estimateTextWidth(trial, fontSize) <= maxWidth || !cur) {
      cur = trial;
    } else if (lines.length + 1 >= maxLines) {
      truncated = true;
      break;
    } else {
      lines.push(cur);
      cur = words[i];
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (truncated && lines.length) {
    const last = lines.length - 1;
    lines[last] = truncateToWidth(`${lines[last]} …`, fontSize, maxWidth);
  }
  return lines.map((l) => truncateToWidth(l, fontSize, maxWidth));
}

interface CardGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardBuild {
  svg: string;
  geo: CardGeometry;
}

/**
 * Build the card SVG + its composite geometry — pure (no I/O), so the visual design is
 * unit-testable without rasterizing.
 *
 * Two placements, both lower-third: `lower-left` puts a left-aligned block behind a vertical
 * accent bar (the news lower-third), `lower-center` centres the text under a horizontal hairline
 * (the chapter/rank/year card). Which one, and everything else, comes from the theme.
 *
 * The title is single-line: it SHRINKS to fit (`fitTitle`) and only ellipsizes as a last resort.
 * The subtitle is RESILIENT, wrapping to at most `theme.subtitleMaxLines` lines and ellipsizing
 * beyond that. Both carry a drop shadow so they stay legible over any footage.
 */
export function buildCardSvg(
  overlay: Overlay,
  dim: { w: number; h: number },
  theme: OverlayTheme = DEFAULT_OVERLAY_THEME,
  /**
   * How much wider the host actually draws these glyphs than `estimateTextWidth` predicts.
   *
   * The estimator has no notion of font WEIGHT and the family is a fontconfig chain resolved on
   * the machine, not a bundled file — measured on the documentary theme (weight 800 Arial) it
   * runs 9–16% low, which is enough to build the card narrower than its own text and let the
   * SVG viewport clip the tail. `renderOverlayCard` measures the real ink and passes the ratio
   * back in. 1 = trust the estimate, which is what every pure unit test still does.
   */
  widthScale = 1
): CardBuild {
  const { w, h } = dim;
  const px = (frac: number, min: number) => (frac <= 0 && min <= 0 ? 0 : Math.max(min, Math.round(h * frac)));
  const titleFont = px(theme.titleFontFrac, theme.titleFontMin);
  const subFont = px(theme.subtitleFontFrac, theme.subtitleFontMin);
  const pad = px(theme.padFrac, theme.padMin);
  const accentW = px(theme.accentFrac, theme.accentMin);
  const ruleH = px(theme.ruleFrac, theme.ruleMin);
  const corner = px(theme.cornerFrac, theme.cornerMin);
  const gap = Math.round(h * theme.gapFrac);
  const shadow = px(theme.shadowFrac, theme.shadowMin);
  const tracking = Math.round(titleFont * theme.titleLetterSpacingRatio);
  const lineGap = Math.round(subFont * theme.lineGapRatio);
  const centered = theme.placement === "lower-center";

  const textX = accentW + pad;
  // Both uses of the estimate are corrected by the SAME factor, in opposite directions: the
  // budget the text must fit into shrinks, and the space the card reserves for it grows. Doing
  // it here keeps fitTitle/wrapText untouched — they still compare an estimate to a budget, and
  // `estimate <= budget/scale` is exactly `real <= budget`.
  const scale = Math.max(1, widthScale);
  const maxTextW = Math.max(1, Math.round((Math.round(w * theme.maxWidthFrac) - textX - pad) / scale));

  const rawTitle = theme.titleUppercase ? titleCaseForDisplay(overlay.title) : overlay.title;
  const fitted = fitTitle(rawTitle, titleFont, maxTextW, tracking);
  const title = fitted.text;
  const titleSize = fitted.fontSize;
  const titleTracking = fitted.tracking;
  const subLines = overlay.subtitle ? wrapText(overlay.subtitle, subFont, maxTextW, theme.subtitleMaxLines) : [];

  const textAreaW = Math.ceil(
    Math.max(
      estimateTextWidth(title, titleSize, titleTracking),
      ...subLines.map((l) => estimateTextWidth(l, subFont)),
      0
    ) * scale
  );
  // Stroke scales with the ACTUAL title size — a shrunk title with display-sized stroke would
  // thicken into a faux-bold.
  const titleStroke = theme.titleStrokeRatio > 0 ? Math.max(0.5, titleSize * theme.titleStrokeRatio) : 0;
  const minW = Math.round(w * theme.minWidthFrac);
  const maxW = Math.round(w * theme.maxWidthFrac);
  const cardW = Math.min(maxW, Math.max(minW, accentW + pad + textAreaW + pad));

  const titleBaselineY = pad + titleSize;
  // The hairline sits in the gap between title and subtitle (or below the title when there is
  // none), which is what makes the prestige card read as a title card rather than a chip.
  const ruleY = ruleH > 0 ? titleBaselineY + Math.round(gap * 0.55) : 0;
  const subBaseline0 = titleBaselineY + gap + (ruleH > 0 ? ruleH + Math.round(gap * 0.4) : 0) + subFont;
  const lastSubBaselineY = subLines.length ? subBaseline0 + (subLines.length - 1) * (subFont + lineGap) : titleBaselineY;
  const contentBottom = Math.max(lastSubBaselineY, ruleY + ruleH) + Math.round((subLines.length ? subFont : titleSize) * 0.28);
  const cardH = contentBottom + pad;

  // Centred placement anchors text at the card's midpoint; left placement at the text column.
  const anchorX = centered ? Math.round(cardW / 2) : textX;
  const anchorAttr = centered ? ` text-anchor="middle"` : "";
  const trackAttr = titleTracking ? ` letter-spacing="${titleTracking}"` : "";
  const titleAttrs = `font-family="${theme.fontFamily}" font-size="${titleSize}" font-weight="${theme.titleWeight}"${anchorAttr}${trackAttr}`;
  const subAttrs = `font-family="${theme.fontFamily}" font-size="${subFont}" font-weight="${theme.subtitleWeight}"${anchorAttr}`;
  const t = xmlEscape(title);

  const subSvg = subLines
    .map((line, i) => {
      const y = subBaseline0 + i * (subFont + lineGap);
      const s = xmlEscape(line);
      return (
        `<text x="${anchorX + shadow}" y="${y + shadow}" ${subAttrs} fill="${theme.shadowColor}" fill-opacity="${theme.shadowOpacity}">${s}</text>` +
        `<text x="${anchorX}" y="${y}" ${subAttrs} fill="${theme.subtitleColor}">${s}</text>`
      );
    })
    .join("");

  const accentSvg = accentW > 0
    ? `<rect x="0" y="0" width="${accentW}" height="${cardH}" fill="${theme.accentColor}"/>`
    : "";
  // The rule spans the text column, centred with the text when the placement is centred.
  const ruleW = Math.max(1, Math.round(Math.min(textAreaW, cardW - textX - pad)));
  const ruleX = centered ? Math.round((cardW - ruleW) / 2) : textX;
  const ruleSvg = ruleH > 0
    ? `<rect x="${ruleX}" y="${ruleY}" width="${ruleW}" height="${ruleH}" fill="${theme.accentColor}"/>`
    : "";
  const titleStrokeAttr = titleStroke > 0
    ? ` stroke="${theme.titleColor}" stroke-width="${titleStroke}" paint-order="stroke"`
    : "";

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cardW}" height="${cardH}" viewBox="0 0 ${cardW} ${cardH}">` +
    (corner > 0
      ? `<defs><clipPath id="c"><rect x="0" y="0" width="${cardW}" height="${cardH}" rx="${corner}" ry="${corner}"/></clipPath></defs><g clip-path="url(#c)">`
      : `<g>`) +
    `<rect x="0" y="0" width="${cardW}" height="${cardH}" fill="${theme.cardColor}" fill-opacity="${theme.cardOpacity}"/>` +
    accentSvg +
    `</g>` +
    ruleSvg +
    // Title: drop-shadow copy first, then the (optionally stroked) title on top.
    `<text x="${anchorX + shadow}" y="${titleBaselineY + shadow}" ${titleAttrs} fill="${theme.shadowColor}" fill-opacity="${theme.shadowOpacity}">${t}</text>` +
    `<text x="${anchorX}" y="${titleBaselineY}" ${titleAttrs} fill="${theme.titleColor}"${titleStrokeAttr}>${t}</text>` +
    subSvg +
    `</svg>`;

  const x = centered ? Math.round((w - cardW) / 2) : Math.round(w * theme.marginXFrac);
  const y = Math.max(Math.round(h * theme.marginTopMinFrac), h - cardH - Math.round(h * theme.marginBottomFrac));
  return { svg, geo: { x, y, w: cardW, h: cardH } };
}

/** Wider than any card we build, so a measured line is never itself clipped by the canvas. */
const MEASURE_CANVAS_W = 6000;

/**
 * The width the host's font engine ACTUALLY draws these lines at.
 *
 * Each `<text>` from the card is re-emitted at x=0, left-anchored, with every attribute that
 * affects advance width kept (family, size, weight, letter-spacing, stroke). Rasterising the
 * card itself would measure nothing: its background rect is opaque across the full width, so
 * every column has ink. Returns the widest line, or null if it cannot be measured.
 */
async function measureRenderedTextWidth(svg: string, height: number): Promise<number | null> {
  const texts = [...svg.matchAll(/<text\b[^>]*>.*?<\/text>/g)].map((m) =>
    m[0].replace(/\bx="[^"]*"/, 'x="0"').replace(/\stext-anchor="[^"]*"/, "")
  );
  if (texts.length === 0) return null;
  try {
    const probe =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${MEASURE_CANVAS_W}" height="${Math.max(1, height)}" ` +
      `viewBox="0 0 ${MEASURE_CANVAS_W} ${Math.max(1, height)}">${texts.join("")}</svg>`;
    const { data, info } = await sharp(Buffer.from(probe)).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    let right = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = info.width - 1; x > right; x--) {
        if (data[(y * info.width + x) * info.channels + 3] > 8) {
          right = x;
          break;
        }
      }
    }
    return right < 0 ? null : right + 1;
  } catch {
    // Measurement is an improvement on a guess, never a new way for a video to fail.
    return null;
  }
}

/** Refuse to inflate without bound — past this the estimator is wrong about something else. */
const MAX_WIDTH_SCALE = 2;

/**
 * Draw one overlay card to `pngPath` and return where the assembler must place it.
 *
 * The card is sized from an estimate of how wide its text will be, and the estimate is
 * systematically LOW for bold type (measured: 9–16% on the documentary theme), so cards were
 * built narrower than their own titles and the SVG viewport cut the tail off — the clipped
 * "Venomous Primat" a client reported. Rather than tune the estimator's constants against one
 * machine's fonts, render the text, measure it, and rebuild from the measurement.
 *
 * Converges rather than correcting once: a wider budget can let fitTitle keep a LARGER font,
 * which is wider again. Two extra passes are plenty in practice and the loop always terminates.
 */
export async function buildFittedCard(
  overlay: Overlay,
  dim: { w: number; h: number },
  theme: OverlayTheme = DEFAULT_OVERLAY_THEME
): Promise<CardBuild> {
  let build = buildCardSvg(overlay, dim, theme);
  let scale = 1;
  for (let pass = 0; pass < 3; pass++) {
    const real = await measureRenderedTextWidth(build.svg, build.geo.h);
    if (real == null) break; // unmeasurable → ship the estimate, exactly as before
    const pad = Math.max(theme.padMin, Math.round(dim.h * theme.padFrac));
    const accentW =
      theme.accentFrac <= 0 && theme.accentMin <= 0 ? 0 : Math.max(theme.accentMin, Math.round(dim.h * theme.accentFrac));
    const reserved = build.geo.w - accentW - 2 * pad;
    if (reserved <= 0 || real <= reserved) break; // it fits — done
    const next = Math.min(MAX_WIDTH_SCALE, scale * (real / reserved));
    if (next <= scale + 0.001) break; // clamped or converged; further passes cannot help
    scale = next;
    build = buildCardSvg(overlay, dim, theme, scale);
  }
  return build;
}

/** Measured width of the widest line in a built card — exported so a test can assert the fit. */
export async function measuredTextWidth(build: CardBuild): Promise<number | null> {
  return measureRenderedTextWidth(build.svg, build.geo.h);
}

export async function renderOverlayCard(
  overlay: Overlay,
  dim: { w: number; h: number },
  pngPath: string,
  theme: OverlayTheme = DEFAULT_OVERLAY_THEME
): Promise<CardGeometry> {
  const build = await buildFittedCard(overlay, dim, theme);
  await sharp(Buffer.from(build.svg)).png().toFile(pngPath);
  return build.geo;
}

/**
 * Build the filter_complex that fades each card in/out and composites it over the base video
 * only within its time window. Pure (no I/O) so it is unit-testable in isolation.
 *
 * Base video is [0:v]; card i is input [i+1:v]. The card image is looped by the caller
 * (`-loop 1 -i`), so its stream time aligns with the base timeline (both start at 0) and an
 * absolute `fade` start time is correct. `enable='between(t,a,b)'` gates visibility; the fades
 * ride just inside that window. Output pad is [vout]. Fade timing uses the documentary theme's
 * clamp for every card (the per-theme fade difference is cosmetic and kept out of the assembler
 * contract so the single-filter/one-index-per-card shape is unchanged).
 */
export function buildOverlayFilter(cards: Pick<OverlayCard, "startSec" | "endSec" | "x" | "y">[]): string {
  if (cards.length === 0) return "";
  const f = (n: number) => n.toFixed(3);
  const parts: string[] = [];
  let prev = "[0:v]";
  const th = DEFAULT_OVERLAY_THEME;
  cards.forEach((c, i) => {
    const inIdx = i + 1;
    const dur = Math.max(0.001, c.endSec - c.startSec);
    // Fade proportional to lifetime, clamped: short cards snap in/out, long cards ease.
    const fade = Math.min(Math.min(th.fadeMaxSec, Math.max(th.fadeMinSec, dur * th.fadeRatio)), dur / 2);
    const outStart = Math.max(c.startSec, c.endSec - fade);
    parts.push(
      `[${inIdx}:v]format=rgba,fade=t=in:st=${f(c.startSec)}:d=${f(fade)}:alpha=1,` +
        `fade=t=out:st=${f(outStart)}:d=${f(fade)}:alpha=1[ov${i}]`
    );
    const out = i === cards.length - 1 ? "[vout]" : `[base${i}]`;
    parts.push(`${prev}[ov${i}]overlay=${c.x}:${c.y}:enable='between(t,${f(c.startSec)},${f(c.endSec)})'${out}`);
    prev = `[base${i}]`;
  });
  return parts.join(";");
}

/**
 * Turn the run's beats into a renderable overlay plan, or null when there is nothing to draw.
 * Each beat contributes its ESTABLISHING overlay (start = spoken cue, fall back to the beat
 * window for a pre-scheduling beats.json) and, for a structured item, an optional SUPPORTING card
 * — a second, time-separated card in the same lower-third, rendered ONLY when it was scheduled.
 * Each card is drawn with the theme its semantic type selects (section/date → prestige, else
 * documentary). A card that fails to render is logged and skipped (fail-open). Returns null when
 * no beat has an overlay or every card failed — either way the caller assembles with no overlays.
 */
export async function buildOverlayPlan(
  beats: readonly Beat[],
  dim: { w: number; h: number },
  overlaysDir: string,
  runId: string
): Promise<OverlayPlan | null> {
  interface Job { overlay: Overlay; theme: OverlayTheme; startMs: number; endMs: number; pngPath: string; label: string }
  const jobs: Job[] = [];
  for (const b of beats) {
    const idx = String(b.index).padStart(4, "0");
    if (b.overlay?.title) {
      jobs.push({ overlay: b.overlay, theme: themeForOverlay(b.overlay), startMs: b.overlayStartMs ?? b.startMs, endMs: b.overlayEndMs ?? b.endMs, pngPath: path.join(overlaysDir, `overlay_${idx}.png`), label: `beat ${b.index}` });
    }
    if (b.supporting?.title && b.supportingStartMs != null && b.supportingEndMs != null) {
      jobs.push({ overlay: b.supporting, theme: themeForOverlay(b.supporting), startMs: b.supportingStartMs, endMs: b.supportingEndMs, pngPath: path.join(overlaysDir, `support_${idx}.png`), label: `beat ${b.index} (supporting)` });
    }
  }
  if (jobs.length === 0) return null;

  fs.mkdirSync(overlaysDir, { recursive: true });
  const cards: OverlayCard[] = [];
  for (const j of jobs) {
    let geo: CardGeometry;
    try {
      geo = await renderOverlayCard(j.overlay, dim, j.pngPath, j.theme);
    } catch (e) {
      log(runId, "error", `Overlay card for ${j.label} failed to render — skipping it: ${(e as Error).message.slice(0, 120)}`, { stage: "assemble" });
      continue;
    }
    const startSec = Math.max(0, j.startMs / 1000);
    const endSec = Math.max(startSec + 0.2, j.endMs / 1000);
    cards.push({ pngPath: j.pngPath, startSec, endSec, x: geo.x, y: geo.y });
  }
  if (cards.length === 0) return null;
  return { inputs: cards.map((c) => c.pngPath), filter: buildOverlayFilter(cards) };
}

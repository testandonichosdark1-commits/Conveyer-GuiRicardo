/**
 * OverlayTheme — the ENTIRE visual appearance of an on-screen card, as data.
 *
 * Kept in its own module, deliberately: `overlay-renderer.ts` imports `sharp` (a native module).
 * If the themes lived beside the renderer, every consumer — and therefore every unit test that
 * touches one — would pull a native binary into its import graph for a handful of colour strings.
 *
 * Every colour, weight, size and position is a value here, so a new look is a NEW theme object,
 * never a renderer rewrite. All sizes are fractions of the frame HEIGHT (text, padding, accent,
 * corner, shadow) or WIDTH (margins, min/max card width) so one theme serves landscape and
 * portrait unchanged, with a pixel floor for tiny frames.
 */

/** Where the card sits in the frame. */
export type CardPlacement =
  /** Left-aligned lower third — the news/documentary lower-third. */
  | "lower-left"
  /** Horizontally centred, lower third — a title/chapter card. */
  | "lower-center";

export interface OverlayTheme {
  /** Stable id, referenced by a visual profile. */
  key: string;
  // Colours
  cardColor: string;
  cardOpacity: number;
  accentColor: string;
  titleColor: string;
  subtitleColor: string;
  shadowColor: string;
  shadowOpacity: number;
  // Typography
  fontFamily: string;
  titleWeight: number;
  subtitleWeight: number;
  titleStrokeRatio: number; // stroke width as a fraction of the title font size
  /** Extra tracking on the title, as a fraction of the title font size. A display serif reads
   *  as a chapter card with letter-spacing; a news lower-third does not want it. */
  titleLetterSpacingRatio: number;
  /** Uppercase the title. */
  titleUppercase: boolean;
  // Sizing — fractions of frame HEIGHT, each with a px floor
  titleFontFrac: number; titleFontMin: number;
  subtitleFontFrac: number; subtitleFontMin: number;
  padFrac: number; padMin: number;
  /** Accent bar width (vertical rule at the card's left edge). 0 = no bar. */
  accentFrac: number; accentMin: number;
  /** Horizontal hairline rule under the title. 0 = none. Mutually useful with accent 0. */
  ruleFrac: number; ruleMin: number;
  cornerFrac: number; cornerMin: number;
  gapFrac: number;
  lineGapRatio: number; // extra leading between wrapped subtitle lines, as a fraction of subtitle font
  shadowFrac: number; shadowMin: number;
  // Layout
  placement: CardPlacement;
  minWidthFrac: number;
  maxWidthFrac: number;
  marginXFrac: number;
  marginBottomFrac: number;
  marginTopMinFrac: number;
  // Subtitle resilience
  subtitleMaxLines: number;
  // Fade — proportional to the card's lifetime, clamped: `ratio` of the window, but never below
  // fadeMinSec (snappy for short cards) nor above fadeMaxSec (smooth for long ones).
  fadeRatio: number;
  fadeMinSec: number;
  fadeMaxSec: number;
}

/**
 * FONT CAVEAT — read before promising a typeface to anyone.
 *
 * `fontFamily` is a CHAIN resolved by the HOST (librsvg/fontconfig), not a bundled font. On
 * macOS the serif chain lands on Times New Roman; on a typical Linux box it lands on DejaVu
 * Serif or Liberation Serif. Matching a specific display face means shipping a licensed font
 * file and registering it with fontconfig — separate work. What these themes guarantee today is
 * correct STRUCTURE and correct CLASS of typeface (sans vs serif), not the exact face.
 */
const SANS = "'Arial','Helvetica Neue','Helvetica','DejaVu Sans','Liberation Sans',sans-serif";
/**
 * LINING figures are non-negotiable here, which is why Georgia is NOT in this chain.
 *
 * Georgia sets old-style (text) figures by default: 3 4 5 7 9 descend below the baseline and
 * 0 1 2 are x-height. Against `titleUppercase: true` every numeral card came out visibly broken —
 * "4 ACRES" with a small low 4, "10,000 VOLUMES" with a number two sizes smaller than the word
 * beside it, and a countdown "10" that reads small and off the baseline. Numerals are the POINT
 * of these cards (rank stamps, year stamps), so the figure style outranks the face. Every face
 * below sets lining figures natively — Times New Roman on macOS/Windows, Liberation Serif and
 * DejaVu Serif on Linux.
 */
const SERIF = "'Times New Roman','Times','Liberation Serif','DejaVu Serif','Nimbus Roman',serif";

/**
 * The documentary lower-third: a dark card with a yellow accent bar and heavy sans type. This
 * is the default look for person/fact/quote/title lower-thirds. Title/subtitle sizes were bumped
 * up from the original 0.048/0.032 on operator request ("make the text bigger").
 */
export const DOCUMENTARY_THEME: OverlayTheme = {
  key: "documentary",
  cardColor: "#000000",
  cardOpacity: 0.66,
  accentColor: "#FFC400",
  titleColor: "#FFFFFF",
  subtitleColor: "#ECECEC",
  shadowColor: "#000000",
  shadowOpacity: 0.55,
  fontFamily: SANS,
  titleWeight: 800,
  subtitleWeight: 500,
  titleStrokeRatio: 0.02,
  titleLetterSpacingRatio: 0,
  titleUppercase: false,
  titleFontFrac: 0.064, titleFontMin: 28, // bigger on operator request (was 0.048/22)
  subtitleFontFrac: 0.04, subtitleFontMin: 20, // was 0.032/16
  padFrac: 0.026, padMin: 16,
  accentFrac: 0.009, accentMin: 7,
  ruleFrac: 0, ruleMin: 0,
  cornerFrac: 0.016, cornerMin: 8,
  gapFrac: 0.012,
  lineGapRatio: 0.28,
  shadowFrac: 0.0028, shadowMin: 2,
  placement: "lower-left",
  minWidthFrac: 0.16,
  maxWidthFrac: 0.82,
  marginXFrac: 0.055,
  marginBottomFrac: 0.085,
  marginTopMinFrac: 0.02,
  subtitleMaxLines: 2,
  fadeRatio: 0.15,
  fadeMinSec: 0.15,
  fadeMaxSec: 0.6,
};

/**
 * The prestige card: centred, letterspaced serif over a near-black wash with a thin gold rule
 * instead of an accent bar — large elegant rank/year stamps and serif chapter cards. Used for
 * `section` (countdown rank cards) and `date` overlays.
 *
 * The differences from the documentary theme are all deliberate and all visible at a glance:
 * centred rather than left-aligned, serif rather than sans, a horizontal hairline rather than a
 * vertical bar, a much larger and letterspaced title, a quieter card, and slower fades.
 */
export const PRESTIGE_THEME: OverlayTheme = {
  key: "prestige",
  cardColor: "#0B0B0C",
  cardOpacity: 0.5,
  accentColor: "#C9A227", // gold hairline
  titleColor: "#F6F1E7", // warm off-white, not pure white
  subtitleColor: "#DCD3C4",
  shadowColor: "#000000",
  shadowOpacity: 0.6,
  fontFamily: SERIF,
  titleWeight: 400, // a display serif carries at 400; 800 renders as a clumsy faux-bold
  subtitleWeight: 400,
  titleStrokeRatio: 0,
  titleLetterSpacingRatio: 0.12,
  titleUppercase: true,
  titleFontFrac: 0.072, titleFontMin: 30, // the rank/year stamp is the largest thing on screen
  subtitleFontFrac: 0.028, subtitleFontMin: 15,
  padFrac: 0.034, padMin: 20,
  accentFrac: 0, accentMin: 0,
  ruleFrac: 0.0022, ruleMin: 1,
  cornerFrac: 0, cornerMin: 0, // square corners; a rounded chip reads as UI, not as a title card
  gapFrac: 0.02,
  lineGapRatio: 0.3,
  shadowFrac: 0.0026, shadowMin: 2,
  placement: "lower-center",
  minWidthFrac: 0.2,
  maxWidthFrac: 0.7,
  marginXFrac: 0.055,
  marginBottomFrac: 0.12,
  marginTopMinFrac: 0.02,
  subtitleMaxLines: 2,
  fadeRatio: 0.2,
  fadeMinSec: 0.3,
  fadeMaxSec: 1.0,
};

export const OVERLAY_THEMES: Readonly<Record<string, OverlayTheme>> = {
  [DOCUMENTARY_THEME.key]: DOCUMENTARY_THEME,
  [PRESTIGE_THEME.key]: PRESTIGE_THEME,
};

export const DEFAULT_OVERLAY_THEME = DOCUMENTARY_THEME;

/** Resolve a theme key. Never throws; unknown/blank → the documentary default. */
export function resolveOverlayTheme(key: string | null | undefined): OverlayTheme {
  const k = typeof key === "string" ? key.trim() : "";
  return OVERLAY_THEMES[k] ?? DEFAULT_OVERLAY_THEME;
}

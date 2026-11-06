import { validateGraphicData, type GraphicTemplateKey } from "./graphic-templates";
import type { GraphicSpec } from "./graphic-plan";

/**
 * A b-roll beat that found no visual, in a run that has graphics, becomes a TEXT graphic of
 * its own narration instead of repeating a neighbour's shot (a real run showed the same mill
 * clip twice). Deterministic and free — no model call: the text is copied from what is said,
 * which is the spec's rule for on-screen text anyway.
 *
 *  - The line: a sentence (or comma clause) of 3–12 words, preferring one with a number or a
 *    name in it; failing that, the first 10 words of the beat with an ellipsis.
 *  - Highlight: numbers and mid-sentence capitalised words; else the last two words.
 *  - Template: kinetic_quote, or impact_bars when a neighbouring graphic is already a
 *    kinetic_quote (never the same template twice in a row).
 */

const MAX_WORDS = 12;

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/** Pick the line to put on screen. Exported for tests. */
export function pickLine(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const sentences = clean.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const clauses = sentences.flatMap((s) => s.split(/(?<=[,;:])\s+/).map((c) => c.trim()));
  // A clause that opens on a conjunction ("and so did half the guys…") reads as a fragment.
  const fits = (s: string) => { const n = words(s).length; return n >= 3 && n <= MAX_WORDS && !CONJ.test(s); };
  const pool = [...sentences.filter(fits), ...clauses.filter(fits)];
  const best = pool.find(salient) ?? pool[0];
  if (best) return best.replace(/[,;:]$/, "");
  // Nothing short enough: the head of the first sentence, cut back to a content word.
  const head = words(sentences[0] ?? clean).slice(0, MAX_WORDS);
  while (head.length > 3 && TRAILING.test(head[head.length - 1].replace(/[^\p{L}]/gu, ""))) head.pop();
  const s = head.join(" ").replace(/[,;:.]$/, "");
  return s ? `${s}…` : null;
}

const CONJ = /^(and|but|so|or|because|then|which|that)\b/i;
const TRAILING = /^(a|an|the|of|for|to|in|on|at|and|or|but|that|my|his|her|their|our|with|from|by|as|is|was)$/i;
/** A number, or a capitalised word that is not "I" and not the sentence's first. */
function salient(s: string): boolean {
  return /\d/.test(s) || words(s).slice(1).some((w) => /^[A-Z][a-z]/.test(w));
}

/** Words worth gold: numbers and names. Exported for tests. */
export function pickHighlights(line: string): string[] {
  const ws = words(line);
  const strip = (w: string) => w.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, "");
  const hits = ws.filter((w, i) => /\d/.test(w) || (i > 0 && /^[A-Z][a-z]/.test(w))).map(strip).filter(Boolean);
  if (hits.length) return [...new Set(hits)].slice(0, 3);
  return ws.length >= 3 ? [ws.slice(-2).map(strip).join(" ")] : [];
}

function barsFor(line: string, highlight: string[]): { text: string; gold?: boolean }[] {
  const ws = words(line);
  const per = Math.max(2, Math.ceil(ws.length / Math.min(4, Math.ceil(ws.length / 3))));
  const lines: { text: string; gold?: boolean }[] = [];
  for (let i = 0; i < ws.length && lines.length < 4; i += per) lines.push({ text: ws.slice(i, i + per).join(" ").slice(0, 40) });
  const hl = highlight.map((h) => h.toLowerCase());
  const goldIdx = lines.findIndex((l) => hl.some((h) => l.text.toLowerCase().includes(h)));
  lines[goldIdx >= 0 ? goldIdx : lines.length - 1].gold = true;
  return lines;
}

/**
 * The text graphic for a beat, or null when no valid one can be made. `neighbours` are the
 * templates of the beats right before and after (undefined when they are not graphics).
 */
export function textGraphicFor(text: string, neighbours: (GraphicTemplateKey | undefined)[], theme?: string): GraphicSpec | null {
  const line = pickLine(text);
  if (!line) return null;
  const highlight = pickHighlights(line);
  const template: GraphicTemplateKey = neighbours.includes("kinetic_quote") ? "impact_bars" : "kinetic_quote";
  const raw = template === "kinetic_quote"
    ? { text: line.slice(0, 140), highlight, style: "outline-fill", bg: "parchment" }
    : { lines: barsFor(line, highlight), bg: "dark" };
  const v = validateGraphicData(template, raw);
  if (!v.ok) return null;
  return { template, data: v.data, ...(theme ? { theme } : {}) };
}

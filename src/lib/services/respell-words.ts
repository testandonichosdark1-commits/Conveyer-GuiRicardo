/**
 * Whisper times the narration well but spells NAMES by ear. Measured: the script said "Draper
 * Kauffman", Whisper wrote "Kaufman", the planner searched for that, and Wikimedia — which has
 * 127 files of the real man under the right spelling — returned nothing usable. When we
 * synthesized the audio ourselves the script is known, so each timed word is matched back to the
 * script and, where the two are the same word heard slightly differently, the script's spelling
 * wins. Timings are never changed; a word that doesn't clearly correspond is left as Whisper
 * wrote it (e.g. "29" vs "twenty-nine" — different tokens, not a misspelling).
 */
import type { WordTiming } from "./elevenlabs-voiceover";

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Same word, spelled differently: close in edit distance and sharing the first letter. */
function sameWordHeard(a: string, b: string): boolean {
  if (!a || !b || a === b || a[0] !== b[0]) return false;
  const d = levenshtein(a, b);
  return d <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.34));
}

/** Script spelling, Whisper's surrounding punctuation (sentence ends drive beat cuts). */
function withScriptCore(heard: string, scriptWord: string): string {
  const lead = heard.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? "";
  const trail = heard.match(/[^\p{L}\p{N}]*$/u)?.[0] ?? "";
  const core = scriptWord.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return `${lead}${core}${trail}`;
}

const WINDOW = 6;

export function respellFromScript(words: WordTiming[], script: string): WordTiming[] {
  const src = script.split(/\s+/).filter((t) => norm(t));
  if (!src.length || !words.length) return words;
  const out = words.map((w) => ({ ...w }));
  const W = out.map((w) => norm(w.word));
  const S = src.map(norm);
  let i = 0;
  let j = 0;
  const fix = (wi: number, sj: number) => {
    if (sameWordHeard(W[wi], S[sj])) out[wi].word = withScriptCore(out[wi].word, src[sj]);
  };
  while (i < W.length && j < S.length) {
    if (W[i] === S[j]) {
      i++;
      j++;
      continue;
    }
    // Resync on the nearest pair of consecutive matches within a small window.
    let best: [number, number] | null = null;
    for (let span = 1; span <= WINDOW * 2 && !best; span++) {
      for (let a = 0; a <= Math.min(span, WINDOW); a++) {
        const b = span - a;
        if (b > WINDOW) continue;
        const wi = i + a;
        const sj = j + b;
        if (wi < W.length && sj < S.length && W[wi] === S[sj] && (wi + 1 >= W.length || sj + 1 >= S.length || W[wi + 1] === S[sj + 1])) {
          best = [a, b];
          break;
        }
      }
    }
    if (best) {
      const [a, b] = best;
      if (a === b) for (let t = 0; t < a; t++) fix(i + t, j + t);
      i += a;
      j += b;
    } else {
      fix(i, j);
      i++;
      j++;
    }
  }
  return out;
}

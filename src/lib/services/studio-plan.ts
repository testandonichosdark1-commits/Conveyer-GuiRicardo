import { getSetting } from "../settings";
import { log } from "../logger";
import type { WordTiming } from "./elevenlabs-voiceover";
import { recordGemini } from "./cost-ledger";
import { callGemini, type GeminiGenerateContentResponse } from "./gemini-models";
import { noteGeminiQuota, noteGeminiKeyMissing, geminiQuotaHit } from "./gemini-quota";

/**
 * Beat planner.
 *
 * 1. Fold the ElevenLabs word timeline into BEATS of ~secondsPerVisual each,
 *    preferring to end a beat on sentence punctuation.
 * 2. Decide each beat's layout:
 *      - the hook (beat 0) and an even spread of ~avatarPercent of beats show
 *        the recurring AVATAR. Beat 0 is full-screen "avatar"; the others are
 *        "split" (avatar shares the screen with a relevant visual).
 *      - every other beat is full-screen B-roll ("broll").
 * 3. For every visual beat (broll/split) ask Gemini for a short concrete visual
 *    search query, and assign its source (real footage vs AI) by realPercent,
 *    evenly spread across the timeline.
 *
 * Mirrors the base avatar-plan.ts but is driven by the script's own word timings
 * (not a transcription of an uploaded video) and adds the real/AI + image/video
 * source decision.
 */

export type BeatLayout = "avatar" | "split" | "broll";

/** Content domain of a beat (Patch 2.3a). DIAGNOSTIC ONLY — classified by keyword
 * and logged; not yet read by any routing/scoring/assignment logic. */
export type Domain = "history" | "finance" | "ai" | "startup" | "business" | "generic";

/**
 * Informational Overlays — Stage 1.
 *
 * The semantic content of an on-screen information card (a date, a name, a section
 * title, a fact). Deliberately SMALL: content only. Positioning, colours, fonts,
 * themes and animations are the renderer's concern (one fixed template in Stage 1)
 * and are added in later stages WITHOUT changing this shape or the planner output.
 *
 * `type` is a semantic tag that later stages map to a template; Stage 1 renders every
 * type with the same documentary card, so nothing branches on it yet.
 */
export type OverlayType = "date" | "title" | "person" | "fact" | "quote" | "section";

export interface Overlay {
  type: OverlayType;
  title: string;
  subtitle?: string;
}

const OVERLAY_TYPES: readonly OverlayType[] = ["date", "title", "person", "fact", "quote", "section"];

/**
 * Coerce a raw planner-emitted overlay into a validated {@link Overlay}, or undefined.
 *
 * Fail-closed: an unknown/absent type, or a missing/blank title, yields `undefined`
 * (no card) rather than a malformed one. This is what enforces "no hallucinated
 * overlays" — the planner returning `overlay: null` (the common case) and the
 * planner returning garbage both collapse to "no overlay" here. Exported for tests.
 */
/**
 * Longest label we will ask a model to render. Past this, text quality collapses.
 *
 * Sized against a real product name rather than a round number: "Arm & Hammer Super Washing
 * Soda" is 31 chars over 6 words, and a live planner run proved a tighter cap silently drops
 * exactly the kind of brand this feature exists for. The generated frame renders that
 * wording cleanly, so the cap is set where legibility actually fails, not below it.
 */
const PRODUCT_LABEL_MAX_CHARS = 40;
/** And past this many words it stops being a label and starts being a sentence. */
const PRODUCT_LABEL_MAX_WORDS = 6;

/**
 * Coerce the planner's `product_label` into wording we are willing to print on a pack.
 *
 * Fail-closed, and the failure is the COMMON case: most shots are not product shots, so
 * `undefined` here restores the pre-feature prompt verbatim. Two rejections carry real
 * weight beyond tidiness:
 *
 *  - **Length.** This string is handed to an image model as text to render. A sentence
 *    comes back as unreadable scribble across the packaging, which looks worse than the
 *    blank box it replaced.
 *  - **A line of the narration.** The reason the blanket text ban existed in the first
 *    place is that these models happily render the prompt onto the props. If the planner
 *    echoes the spoken line here, we would be re-introducing that bug deliberately.
 *
 * Exported for tests.
 */
export function normalizeProductLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Models like to wrap the value in quotes; they are punctuation, not part of the label.
  const cleaned = raw.replace(/\s+/g, " ").trim().replace(/^["'“”«»]+|["'“”«»]+$/g, "").trim();
  if (!cleaned) return undefined;
  if (cleaned.length > PRODUCT_LABEL_MAX_CHARS) return undefined;
  if (cleaned.split(" ").filter(Boolean).length > PRODUCT_LABEL_MAX_WORDS) return undefined;
  // Sentence punctuation is the giveaway that this is narration, not packaging copy.
  if (/[.!?;:]/.test(cleaned)) return undefined;
  return cleaned;
}

export function normalizeOverlay(raw: unknown): Overlay | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as { type?: unknown; title?: unknown; subtitle?: unknown };
  const type = typeof o.type === "string" ? (o.type.trim().toLowerCase() as OverlayType) : undefined;
  if (!type || !OVERLAY_TYPES.includes(type)) return undefined;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (!title) return undefined;
  const subtitle = typeof o.subtitle === "string" && o.subtitle.trim() ? o.subtitle.trim() : undefined;
  return subtitle ? { type, title, subtitle } : { type, title };
}

/**
 * Structured-video intelligence — Stage 2.
 *
 * Many documentary/YouTube scripts are LISTS: "Top 10 …", "5 Facts about …", "7 Lessons …",
 * chaptered explainers. For those, viewers expect a ranking/chapter marker on each item
 * ("#10", "Fact #3", "Lesson #2", "Chapter 4"). We produce those in TWO deterministic steps,
 * mirroring Stage 1's "the model decides salience, code owns the mechanics" split:
 *
 *   1. detectVideoStructure() — a cheap, API-free heuristic over the title + narration lead
 *      classifies the video (or returns null = not a list → today's behavior).
 *   2. The planner prompt asks the model only to MARK where each item BEGINS (as a `section`
 *      overlay carrying the item's topic) — never to number it. Then applyStructureNumbering()
 *      walks the finished beats IN ORDER and assigns the numbers. The model can't count across
 *      the 6-beat planning chunks, so numbering is done globally in code — always consistent.
 *
 * Fully backward-compatible: this whole path is inert unless overlays are enabled AND a
 * structure is detected, and every step is fail-open (a throw leaves the Stage-1 overlays as-is).
 */
export type VideoStructureKind = "countdown" | "facts" | "tips" | "lessons" | "secrets" | "chapters" | "steps" | "sequence";

export interface VideoStructure {
  kind: VideoStructureKind;
  /** "down" counts a Top-N from N→1; "up" counts 1→N (facts/tips/chapters/…). */
  direction: "up" | "down";
  /** Known item count (from "Top 10" / "5 Facts"); undefined when only the format is known. */
  total?: number;
  /** Which evidence path produced this classification. Provenance only — NO downstream consumer
   * reads it; it exists for telemetry + the run-level snapshot. Absent = "title" (the phrasing path
   * leaves it unset so every pre-existing title-detected result stays byte-identical). */
  source?: "title" | "cue";
}

/**
 * Classify a video as a structured list, or null. THE single canonical producer of VideoStructure —
 * deterministic, no API. It weighs three independent evidence paths, TITLE FIRST:
 *
 *   1. TITLE / LEAD phrasing (authoritative, unchanged) — "Top 10 …", "5 Facts …", a bare "…tips…".
 *   2. SPOKEN NUMBER CUES (fallback, only when path 1 finds nothing) — the narrator actually counting
 *      ("Number five … four … three"). Stronger evidence than the title, but title wins when present,
 *      so every video that classifies today classifies identically. Strict grammar (see
 *      detectStructureFromCues) keeps false positives low. Needs the word timings.
 *   3. ORDINAL DISCOURSE markers (last resort, only when paths 1–2 find nothing) — an ordered walk
 *      with "First … Next … Then … Finally" and NO spoken numbers. Yields a NAME-ONLY "sequence"
 *      (see detectStructureFromOrdinals); its strict bookended/spread grammar keeps ordinary prose
 *      connectives from flipping a normal script into list mode.
 *
 * `onDebug`, when supplied, receives a one-line reason each time the cue path REJECTS a candidate
 * (inconsistent labels, too few cues, non-monotonic, clustered) — wired to the run log at debug level
 * by the caller, omitted by unit tests so the function stays logger-free.
 */
export function detectVideoStructure(
  text: string,
  words?: WordTiming[],
  onDebug?: (message: string) => void
): VideoStructure | null {
  const byTitle = detectStructureFromPhrasing(text);
  if (byTitle) return byTitle; // author intent wins → backward compatible; the cue paths never run
  if (words && words.length) {
    // Spoken NUMBERS first (they carry real ranks); fall back to ordinal DISCOURSE markers
    // ("First … Next … Finally") only when there are no numeric cues at all.
    return detectStructureFromCues(words, onDebug) ?? detectStructureFromOrdinals(words, onDebug);
  }
  return null;
}

/**
 * Evidence path 1 — the original title/lead phrasing heuristic (behavior unchanged). Matches the
 * explicitly-named formats; the most specific pattern (Top-N countdown) is tried first. Returns
 * {kind,direction,total?} with NO `source` field, so every existing title-detected result is
 * byte-identical to before this change.
 */
function detectStructureFromPhrasing(text: string): VideoStructure | null {
  const t = ` ${text.toLowerCase()} `.replace(/\s+/g, " ");
  const clamp = (n: number): number | undefined => (Number.isFinite(n) && n > 0 && n <= 100 ? n : undefined);

  // Top-N / "N best|worst|…" → a countdown with "#n" labels, counted DOWN by convention.
  const top = t.match(/\btop\s+(\d{1,3})\b/) || t.match(/\b(\d{1,3})\s+(?:best|worst|biggest|greatest|most|craziest|scariest)\b/);
  if (top) {
    const total = clamp(parseInt(top[1], 10));
    if (total) return { kind: "countdown", direction: "down", total };
  }

  // "N [adjective…] <label>s" → labeled list counted UP. Up to two words may sit between
  // the count and the label ("8 Productivity Tips", "10 Amazing Space Facts").
  const gap = String.raw`(?:[a-z]+\s+){0,2}`;
  const labeled: [RegExp, VideoStructureKind][] = [
    [new RegExp(`\\b(\\d{1,3})\\s+${gap}(?:facts?|things|reasons|myths?|mistakes?|questions?)\\b`), "facts"],
    [new RegExp(`\\b(\\d{1,3})\\s+${gap}(?:tips?|tricks?|hacks?)\\b`), "tips"],
    [new RegExp(`\\b(\\d{1,3})\\s+${gap}lessons?\\b`), "lessons"],
    [new RegExp(`\\b(\\d{1,3})\\s+${gap}secrets?\\b`), "secrets"],
    [new RegExp(`\\b(\\d{1,3})\\s+${gap}steps?\\b`), "steps"],
  ];
  for (const [re, kind] of labeled) {
    const m = t.match(re);
    if (m) return { kind, direction: "up", total: clamp(parseInt(m[1], 10)) };
  }

  // Plural label word without a count — still structured (count up, unknown total).
  if (/\bfacts\b/.test(t)) return { kind: "facts", direction: "up" };
  if (/\btips\b|\btricks\b|\bhacks\b/.test(t)) return { kind: "tips", direction: "up" };
  if (/\blessons\b/.test(t)) return { kind: "lessons", direction: "up" };
  if (/\bsecrets\b/.test(t)) return { kind: "secrets", direction: "up" };
  if (/\bchapters?\b/.test(t)) return { kind: "chapters", direction: "up" };
  if (/\bsteps\b/.test(t)) return { kind: "steps", direction: "up" };
  return null;
}

/**
 * Detection-specific label → kind map. DELIBERATELY STRICTER than the localization {@link CUE_LABELS}:
 * only words that strongly imply enumeration AND map unambiguously to a kind. The ambiguous connectives
 * localization relies on ("at", "next", "coming", "thing", "no", "entry", "part", "reason", …) are
 * EXCLUDED here — reusing them for DETECTION would misread "at 3 … at 4 … at 5" (times of day) as a
 * countdown. Localization may stay broad because it already trusts the structure; detection has no prior.
 */
const DETECTION_LABELS: Record<string, VideoStructureKind> = {
  number: "countdown",
  fact: "facts",
  tip: "tips", trick: "tips", hack: "tips",
  lesson: "lessons",
  secret: "secrets",
  step: "steps",
  chapter: "chapters",
};

/** Minimum labeled announcements to trust a cue-based classification. */
const CUE_DETECT_MIN = 3;
/** Cues must span at least this fraction of the narration — guards against a run clustered into one
 * sentence ("3, 4, 5" in one breath) being read as the whole video's structure. */
const CUE_DETECT_MIN_SPREAD = 0.25;

/**
 * Evidence path 2 — infer structure from the SPOKEN CUES. Strict by design (detection has no prior,
 * unlike localization), so ALL of these must hold or it returns null:
 *   • ≥ {@link CUE_DETECT_MIN} labeled cues (a {@link DETECTION_LABELS} word 1–2 words before a number);
 *   • ONE consistent kind across every cue (a mixed "number … fact …" run → reject);
 *   • strictly monotone AND consecutive (±1) numbering — ascending or descending;
 *   • cues distributed across ≥ {@link CUE_DETECT_MIN_SPREAD} of the timeline (not one sentence).
 * Pure over `words`; deterministic → Resume-safe. Tags the result `source:"cue"`.
 */
function detectStructureFromCues(words: WordTiming[], onDebug?: (m: string) => void): VideoStructure | null {
  const cues: { kind: VideoStructureKind; value: number; atMs: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    const v = wordToNum(words[i].word);
    if (v == null) continue;
    for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
      const kind = DETECTION_LABELS[words[j].word.toLowerCase().replace(/[^a-z]/g, "")];
      if (kind) { cues.push({ kind, value: v, atMs: words[j].startMs }); break; }
    }
  }
  if (cues.length < CUE_DETECT_MIN) {
    onDebug?.(`cue detection: ${cues.length} labeled cue(s) (< ${CUE_DETECT_MIN}) — not structured`);
    return null;
  }

  const kinds = new Set(cues.map((c) => c.kind));
  if (kinds.size !== 1) {
    onDebug?.(`cue detection: inconsistent labels (${[...kinds].join(", ")}) — not structured`);
    return null;
  }
  const kind = cues[0].kind;

  const vals = cues.map((c) => c.value);
  const down = vals.every((v, k) => k === 0 || v === vals[k - 1] - 1);
  const up = vals.every((v, k) => k === 0 || v === vals[k - 1] + 1);
  if (!down && !up) {
    onDebug?.(`cue detection: non-monotonic/gapped sequence [${vals.join(",")}] — not structured`);
    return null;
  }

  const span = cues[cues.length - 1].atMs - cues[0].atMs;
  const duration = (words[words.length - 1]?.endMs ?? 0) - (words[0]?.startMs ?? 0);
  if (duration > 0 && span < duration * CUE_DETECT_MIN_SPREAD) {
    onDebug?.(`cue detection: cues clustered (span ${span}ms < ${Math.round(CUE_DETECT_MIN_SPREAD * 100)}% of ${duration}ms) — not structured`);
    return null;
  }

  return { kind, direction: down ? "down" : "up", total: Math.max(...vals), source: "cue" };
}

/**
 * Reconcile a detected structure's DIRECTION and TOTAL against what the narrator actually counts.
 *
 * `detectVideoStructure` lets the TITLE win (backward-compatible), but a title like "10 secrets"
 * always yields direction:"up" even when the narration is a DESCENDING countdown ("Number 10 …
 * Number 1"). The numbering LABEL side already self-heals per item ({@link resolveSectionRanks});
 * this does the same for the three consumers that read direction/total GLOBALLY — {@link firstItemRank},
 * {@link introRegionEndMs} and {@link announcementCutMs} — so the intro region and item cuts are
 * oriented from the correct end and the first item's ("Number 10") establishing card is not stripped
 * as intro (the source of the "Number 10 card missing" + "numbered only 4 of 10" defects).
 *
 * Conservative: overrides ONLY when the spoken cues form a coherent run (the same strict grammar
 * {@link detectStructureFromCues} enforces) AND it disagrees with the detected direction/total.
 * Otherwise returns the input unchanged → byte-identical for every video that already agrees or has
 * no coherent spoken run. `kind` is intentionally left to resolveSectionRanks (which reconciles it
 * per item). Pure over `words` → Resume-safe.
 */
export function reconcileStructureFromCues(structure: VideoStructure, words: WordTiming[]): VideoStructure {
  const spoken = detectStructureFromCues(words);
  if (!spoken) return structure;
  const sameDir = spoken.direction === structure.direction;
  const sameTotal = (spoken.total ?? null) === (structure.total ?? null);
  if (sameDir && sameTotal) return structure;
  return { ...structure, direction: spoken.direction, total: spoken.total ?? structure.total };
}

// ── Evidence path 3 — ordinal-sequence detection ─────────────────────────────
// Recognizes a narration that walks an ORDERED list with DISCOURSE MARKERS ("First … Next … Then …
// After that … Finally") rather than spoken numbers or a "Top N" title. These connectives are
// ubiquitous in ordinary prose, so — like the cue path — the grammar is deliberately strict: it
// takes a run only when it is BOOKENDED (one opener + one closer, the closer last), every marker is
// SENTENCE-INITIAL, any numeric ordinals ASCEND, and the run SPREADS across the timeline. Items are
// un-numbered by nature → the cards are NAME-ONLY (kind "sequence"); the split + numbering derive
// from the marker ORDER, not from any spoken number.

type OrdinalRole = "open" | "cont" | "close";

/** Single-word ordinal markers → role (+ numeric position when the word is itself an ordinal). The
 *  noisiest connectives ("also", "another") are omitted — too common outside real lists. */
const ORDINAL_WORDS: Record<string, { role: OrdinalRole; pos?: number }> = {
  first: { role: "open", pos: 1 }, firstly: { role: "open", pos: 1 },
  second: { role: "cont", pos: 2 }, secondly: { role: "cont", pos: 2 },
  third: { role: "cont", pos: 3 }, thirdly: { role: "cont", pos: 3 },
  fourth: { role: "cont", pos: 4 }, fifth: { role: "cont", pos: 5 }, sixth: { role: "cont", pos: 6 },
  seventh: { role: "cont", pos: 7 }, eighth: { role: "cont", pos: 8 }, ninth: { role: "cont", pos: 9 }, tenth: { role: "cont", pos: 10 },
  next: { role: "cont" }, then: { role: "cont" }, subsequently: { role: "cont" }, afterward: { role: "cont" }, afterwards: { role: "cont" },
  finally: { role: "close" }, lastly: { role: "close" },
};

/** Two-word ordinal phrases → role. Checked BEFORE the single-word table so "after that" beats a
 *  bare "after", and "and finally" collapses to one closer instead of matching "finally" twice. */
const ORDINAL_PHRASES: Record<string, { role: OrdinalRole }> = {
  "after that": { role: "cont" }, "up next": { role: "cont" }, "moving on": { role: "cont" },
  "first up": { role: "open" }, "to start": { role: "open" }, "to begin": { role: "open" },
  "and finally": { role: "close" }, "in closing": { role: "close" },
};

/** Minimum fraction of the narration the markers must span — a real ordered list runs the length of
 *  the video, a clustered "first…then…finally" aside does not. Stricter than the numeric-cue spread. */
const ORDINAL_MIN_SPREAD = 0.35;
/** Pause (ms) that stands in for a sentence boundary when the timings carry no punctuation (Whisper). */
const ORDINAL_PAUSE_MS = 350;

const ordNorm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** Is `words[i]` at the start of a sentence? Punctuation on the previous token is the strong signal
 *  (ElevenLabs keeps it); a pause falls back for sources that strip it (Whisper). */
function isSentenceStart(words: WordTiming[], i: number): boolean {
  if (i === 0) return true;
  const prev = words[i - 1].word.trim();
  if (/[.!?;:]["')\]]?$/.test(prev)) return true;
  return words[i].startMs - words[i - 1].endMs >= ORDINAL_PAUSE_MS;
}

/** The ordered, sentence-initial ordinal markers in the narration. Shared by detection AND the split
 *  (announcementCutMs) / intro (introRegionEndMs), so the cuts land exactly where detection saw them. */
function orderedOrdinalMarkers(words: WordTiming[]): { atMs: number; role: OrdinalRole; pos?: number }[] {
  const out: { atMs: number; role: OrdinalRole; pos?: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!isSentenceStart(words, i)) continue;
    const w = ordNorm(words[i].word);
    if (!w) continue;
    const two = i + 1 < words.length ? `${w} ${ordNorm(words[i + 1].word)}` : "";
    const phrase = two ? ORDINAL_PHRASES[two] : undefined;
    if (phrase) { out.push({ atMs: words[i].startMs, role: phrase.role }); continue; }
    const single = ORDINAL_WORDS[w];
    if (single) out.push({ atMs: words[i].startMs, role: single.role, pos: single.pos });
  }
  return out;
}

/** Sorted, de-duplicated ordinal-marker times — the item cut points for a video announced with
 *  discourse markers. Used both by the "sequence" kind directly and as the FALLBACK for a
 *  numeric/title structure whose narration never speaks the numbers (see announcementCutMs). */
function ordinalCutMs(words: WordTiming[]): number[] {
  return [...new Set(orderedOrdinalMarkers(words).map((m) => m.atMs))].sort((a, b) => a - b);
}

/**
 * Evidence path 3 — classify from ordinal discourse markers. Returns {kind:"sequence"} only when ALL
 * hold (each rejection logged once via onDebug):
 *   • ≥ {@link CUE_DETECT_MIN} sentence-initial markers;
 *   • BOOKENDED — the first is an opener, the last is a closer, and there is EXACTLY one of each
 *     (a paragraph that merely reuses these words has no clean single open/close);
 *   • any numeric ordinals present ASCEND (first < second < third …);
 *   • markers SPREAD ≥ {@link ORDINAL_MIN_SPREAD} of the timeline.
 * Pure over `words` → Resume-safe. total = the marker count (the item count).
 */
function detectStructureFromOrdinals(words: WordTiming[], onDebug?: (m: string) => void): VideoStructure | null {
  const marks = orderedOrdinalMarkers(words);
  if (marks.length < CUE_DETECT_MIN) {
    onDebug?.(`ordinal detection: ${marks.length} sequence marker(s) (< ${CUE_DETECT_MIN}) — not structured`);
    return null;
  }
  const opens = marks.filter((m) => m.role === "open").length;
  const closes = marks.filter((m) => m.role === "close").length;
  if (marks[0].role !== "open" || marks[marks.length - 1].role !== "close" || opens !== 1 || closes !== 1) {
    onDebug?.(`ordinal detection: not cleanly bookended (opener-first=${marks[0].role === "open"}, closer-last=${marks[marks.length - 1].role === "close"}, opens=${opens}, closes=${closes}) — not structured`);
    return null;
  }
  const positions = marks.map((m) => m.pos).filter((p): p is number => p != null);
  if (!positions.every((p, k) => k === 0 || p > positions[k - 1])) {
    onDebug?.(`ordinal detection: numeric ordinals out of order [${positions.join(",")}] — not structured`);
    return null;
  }
  const span = marks[marks.length - 1].atMs - marks[0].atMs;
  const duration = (words[words.length - 1]?.endMs ?? 0) - (words[0]?.startMs ?? 0);
  if (duration > 0 && span < duration * ORDINAL_MIN_SPREAD) {
    onDebug?.(`ordinal detection: markers clustered (span ${span}ms < ${Math.round(ORDINAL_MIN_SPREAD * 100)}% of ${duration}ms) — not structured`);
    return null;
  }
  return { kind: "sequence", direction: "up", total: marks.length, source: "cue" };
}

/**
 * The SINGLE source of truth for every generated overlay label + prompt noun.
 *
 * One row per structure kind: `noun` is how the planner prompt refers to an item; `label(n)`
 * formats the on-screen text for item `n`. Adding a new structured format (e.g. "myths",
 * "rules") is one row here — no scattered strings, no `switch` to update in three places.
 */
interface StructureLabelSpec {
  /** Item noun for the prompt ("fact", "tip", "ranked entry"). */
  noun: string;
  /** On-screen label for item n ("#10", "Fact #3", "Chapter 4"). */
  label: (n: number) => string;
}

const STRUCTURE_LABELS: Record<VideoStructureKind, StructureLabelSpec> = {
  countdown: { noun: "ranked entry", label: (n) => `#${n}` },
  facts: { noun: "fact", label: (n) => `Fact #${n}` },
  tips: { noun: "tip", label: (n) => `Tip #${n}` },
  lessons: { noun: "lesson", label: (n) => `Lesson #${n}` },
  secrets: { noun: "secret", label: (n) => `Secret #${n}` },
  steps: { noun: "step", label: (n) => `Step #${n}` },
  chapters: { noun: "chapter", label: (n) => `Chapter ${n}` },
  // Ordinal sequence ("First … Next … Finally"): the items are ORDERED but not ranked or numbered,
  // so the card is NAME-ONLY. An empty label is the signal to applyStructureNumbering to omit the
  // rank chip entirely (the `n` still exists as the transient order used for splitting + spans).
  sequence: { noun: "item", label: () => "" },
};

/** The on-screen label for item `n` of a structured video, e.g. "#10", "Fact #3", "Chapter 4". */
export function overlayLabel(structure: VideoStructure, n: number): string {
  return STRUCTURE_LABELS[structure.kind].label(n);
}

/** The item noun used in the planner prompt for a given structure. */
function structureNoun(kind: VideoStructureKind): string {
  return STRUCTURE_LABELS[kind].noun;
}

/**
 * Strip a numbering/label prefix the model may have prepended to a section topic, so we never
 * DOUBLE it (our deterministic number is authoritative). Removes `#10`, `10.`, `10)`, `10:`,
 * `10 -`, and label-prefixed forms (`Fact 3`, `Chapter #4`, `Tip 7 -`). A bare number with no
 * label and no trailing punctuation (`1943 discovery`, `3 Gorges Dam`) is left ALONE — it is
 * real content, not enumeration. Returns the cleaned topic (may be empty if it was all label).
 */
export function stripLeadingNumbering(text: string): string {
  const labelWords = "facts?|tips?|tricks?|hacks?|lessons?|secrets?|steps?|chapters?|parts?|numbers?|no|items?|reasons?|things|myths?|mistakes?|questions?";
  const re = new RegExp(
    `^\\s*(?:` +
      `(?:${labelWords})\\s*#?\\s*\\d{1,3}` + // "Fact 3", "Chapter #4"
      `|#\\s*\\d{1,3}` + //                      "#10"
      `|\\d{1,3}\\s*[:.)\\-–—]` + //             "10.", "10)", "10:", "10 -"
    `)\\s*[:.)\\-–—]?\\s*`,
    "i"
  );
  return text.replace(re, "").trim();
}

/** Prompt fragment telling the model to mark item boundaries (but never number them). */
export function structurePromptHint(s: VideoStructure): string {
  if (s.kind === "sequence") {
    // Ordered but un-numbered — the model marks each item's first line with its NAME; no number is
    // ever shown, and the card is name-only.
    return (
      `STRUCTURED VIDEO — this narration walks an ORDERED SEQUENCE of items, announced with cues like "First … Next … Then … After that … Finally". ` +
      `Whenever a line BEGINS a new item, set that line's "overlay" to {"type":"section","title":"<the item's SHORT name, a few words>","subtitle":"<OPTIONAL: ONE short supporting fact the narration states for this item — a number, date or vivid detail, e.g. \\"21,000 km long\\" or \\"Built in 1372\\"; omit if none>"}. ` +
      `Mark ONLY the first line of each item, never every line. Items are shown by NAME in order — do NOT write a number or rank yourself. ` +
      `The card shows the name automatically; the optional subtitle becomes a SECOND supporting card shown a little later, in sync with the narration. Set "overlay" to null on all OTHER lines — do NOT add separate date/person/fact cards.\n`
    );
  }
  const noun = structureNoun(s.kind);
  const label = s.kind === "countdown" ? "Top " + (s.total ?? "N") : s.kind;
  const example = s.kind === "countdown" ? "#10, then #9, then #8" : `${overlayLabel(s, 1)}, then ${overlayLabel(s, 2)}`;
  return (
    `STRUCTURED VIDEO — this narration is a ${label} list made of numbered ${noun}s. ` +
    `Whenever a line BEGINS a new ${noun}, set that line's "overlay" to {"type":"section","title":"<the ${noun}'s SHORT name, a few words>","subtitle":"<OPTIONAL: ONE short supporting fact the narration states for this ${noun} — a number, date or vivid detail, e.g. \\"21,000 km long\\" or \\"Built in 1372\\"; omit if none>"}. ` +
    `Mark ONLY the first line of each ${noun}, never every line. Do NOT write a number yourself — the ${noun} number (${example}) is added automatically, in order. ` +
    `The card shows the ranking + name automatically; the optional subtitle becomes a SECOND supporting card shown a little later, in sync with the narration. Set "overlay" to null on all OTHER lines — do NOT add separate date/person/fact cards.\n`
  );
}

/** First DETECTION-labeled number spoken within a word span ("Number five" → {countdown, 5}), or null.
 * Uses the strict {@link DETECTION_LABELS} (kind-mapped) — not the broad localization {@link CUE_LABELS} —
 * so an ambiguous "at 5" / "no 5" never sets a card's rank or kind. */
function firstLabeledNumber(words: WordTiming[]): { kind: VideoStructureKind; value: number } | null {
  for (let i = 0; i < words.length; i++) {
    const v = wordToNum(words[i].word);
    if (v == null) continue;
    for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
      const kind = DETECTION_LABELS[words[j].word.toLowerCase().replace(/[^a-z]/g, "")];
      if (kind) return { kind, value: v };
    }
  }
  return null;
}

/** The single ±1 step of the spoken anchors, or null when there are <2 anchors or they do not form a
 * consistent consecutive run — a guard so a stray/misheard number never drives the whole sequence. */
function anchorStep(anchors: { i: number; v: number }[]): 1 | -1 | null {
  if (anchors.length < 2) return null;
  let step: 1 | -1 | null = null;
  for (let k = 1; k < anchors.length; k++) {
    const di = anchors[k].i - anchors[k - 1].i;
    const dv = anchors[k].v - anchors[k - 1].v;
    if (di === 0 || dv % di !== 0) return null;
    const s = dv / di;
    if (s !== 1 && s !== -1) return null;
    if (step === null) step = s; else if (step !== s) return null;
  }
  return step;
}

/**
 * Resolve each section beat's (kind, rank) for its card. The SPOKEN CUE in an item's own narration is
 * authoritative — it corrects a mis-detected structure kind/direction/total (this is what turns a
 * "Secret #1" card back into the "#5" the voice actually says) — with a deterministic fallback to the
 * ordinal sequence from `structure` when the items are not verbally numbered or the spoken numbers are
 * incoherent. Sequence-reconciled: spoken numbers are trusted only as a consistent ±1 run, gaps filled
 * by interpolation. Pure over (sections, structure, words) → Resume-safe.
 */
function resolveSectionRanks(
  sections: Beat[],
  structure: VideoStructure,
  words: WordTiming[]
): Map<number, { kind: VideoStructureKind; value: number }> {
  const down = structure.direction === "down" && !!structure.total;
  const ordinal = (i: number) => Math.max(1, down ? structure.total! - i : i + 1);

  const spoken = sections.map((b) =>
    firstLabeledNumber(words.filter((w) => w.startMs >= b.startMs && w.startMs < b.endMs))
  );
  // Kind: a single consistent spoken kind wins over the (possibly mis-detected) structure kind.
  const spokenKinds = new Set(spoken.filter(Boolean).map((s) => s!.kind));
  const kind: VideoStructureKind = spokenKinds.size === 1 ? [...spokenKinds][0] : structure.kind;

  const anchors = spoken
    .map((s, i) => (s ? { i, v: s.value } : null))
    .filter((a): a is { i: number; v: number } => a != null);
  const step = anchorStep(anchors);

  let values: number[];
  if (step !== null) {
    const nearest = (i: number) => anchors.reduce((best, a) => (Math.abs(a.i - i) < Math.abs(best.i - i) ? a : best));
    values = sections.map((_, i) => { const a = nearest(i); return a.v + step * (i - a.i); });
    const coherent = values.every((v, i) => v >= 1 && (i === 0 || v === values[i - 1] + step));
    if (!coherent) values = sections.map((_, i) => ordinal(i)); // spoken numbers don't line up → ordinal
  } else {
    values = sections.map((_, i) => ordinal(i)); // not verbally numbered → today's ordinal behavior
  }

  const out = new Map<number, { kind: VideoStructureKind; value: number }>();
  sections.forEach((b, i) => out.set(b.index, { kind, value: values[i] }));
  return out;
}

/**
 * Number the `section` overlays of a structured video and set each card to
 * `{ title: <item heading>, subtitle: <rank label> }` — the item NAME is the primary field, the rank
 * label ("#5", "Fact #3") is secondary. The rank (number + kind) comes from the SPOKEN CUE per item
 * (see {@link resolveSectionRanks}), with an ordinal fallback; this fixes the reported "Secret #1"
 * vs. spoken "Number five" mismatch (both the wrong label word and the wrong number).
 *
 * Mutates in place; order of `beats` is the on-screen order. Non-`section` overlays and beats without
 * an overlay are left untouched. Returns `beat.index → resolved rank` — a TRANSIENT, non-persisted
 * value the scheduler consumes, so it never parses the rank back out of the card text.
 */
export function applyStructureNumbering(beats: Beat[], structure: VideoStructure, words: WordTiming[] = []): Map<number, number> {
  const sections = beats.filter((b) => b.overlay?.type === "section");
  const resolved = resolveSectionRanks(sections, structure, words);
  const rankByIndex = new Map<number, number>();
  for (const b of sections) {
    const r = resolved.get(b.index)!;
    const label = STRUCTURE_LABELS[r.kind].label(r.value);
    // The model puts the item name in `title`; strip any number it prefixed. Heading is PRIMARY (title);
    // fall back to the subtitle only if the title was pure label. Rank label goes to the SECONDARY field.
    const heading = stripLeadingNumbering(b.overlay!.title) || (b.overlay!.subtitle ? stripLeadingNumbering(b.overlay!.subtitle) : "");
    if (!label) {
      // Name-only kind (sequence): the card is just the item heading — no rank chip. The rank `r.value`
      // still rides in rankByIndex as the transient ORDER (drives splitting + supporting-card spans).
      if (heading) b.overlay = { type: "section", title: heading };
      // No heading → leave the model's section overlay as-is (numberStructuredOverlays guarantees one).
    } else {
      b.overlay = heading && heading.toLowerCase() !== label.toLowerCase()
        ? { type: "section", title: heading, subtitle: label }
        : { type: "section", title: label };
    }
    rankByIndex.set(b.index, r.value);
  }
  return rankByIndex;
}

/** The first item number a structure announces: the top rank of a countdown (counts N→1), else 1. */
function firstItemRank(structure: VideoStructure): number {
  return structure.direction === "down" && structure.total ? structure.total : 1;
}

/**
 * Stage C — the end of the INTRO REGION. The introduction is everything the narrator says before the
 * first item is announced: the span `[0, introRegionEndMs)`. It is defined by a narration EVENT — the
 * first ItemAnnouncement (the spoken cue for the first item, #firstRank) — located globally over the
 * word stream, so it is independent of beat segmentation. When the narration never verbalizes that
 * first number, it falls back to the end of the hook (beat 0), which is structurally always intro.
 * No ranking or supporting overlay may live before this ms; a `section` overlay whose beat ends
 * within the region is an intro preview / the hook, never a ranked item.
 */
export function introRegionEndMs(beats: readonly Pick<Beat, "endMs">[], words: WordTiming[], structure: VideoStructure): number {
  if (structure.kind === "sequence") {
    // An ordinal sequence has no spoken number; the first item begins at the first ordinal marker
    // ("First …"), so everything before it is the intro.
    const first = orderedOrdinalMarkers(words)[0];
    return first ? first.atMs : beats[0]?.endMs ?? 0;
  }
  const first = locateItemAnnouncements(words, [firstItemRank(structure)])[0];
  if (first) return first.atMs;
  // Fallback: no spoken NUMBER for the first item — reuse the ordinal scanner (a "Top N" narrated
  // "First … Next … Finally"), so the intro ends where the first item is verbally announced.
  const firstOrdinal = orderedOrdinalMarkers(words)[0];
  if (firstOrdinal) return firstOrdinal.atMs;
  return beats[0]?.endMs ?? 0; // no spoken first-item cue at all → the hook (beat 0) is the intro
}

/** A beat's VISUAL role on the Item Timeline: introduction footage, or a specific ranked object. */
export type VisualRole = "intro" | "item";

/**
 * Visual Stage 1 — classify each beat as INTRO or ITEM from the SAME Item Timeline the overlays use
 * (Stages A–C): a beat that ends inside the Intro Region `[0, introRegionEndMs)` is INTRO (the hook /
 * everything before the first item is announced), otherwise ITEM. Deterministic and independent of
 * beat segmentation. Returns an empty map for a non-structured video (no roles → no prompt change).
 */
export function assignVisualRoles(
  beats: readonly Pick<Beat, "index" | "endMs">[],
  words: WordTiming[],
  structure: VideoStructure | null
): Map<number, VisualRole> {
  const roles = new Map<number, VisualRole>();
  if (!structure) return roles;
  const introEnd = introRegionEndMs(beats, words, structure);
  for (const b of beats) roles.set(b.index, b.endMs <= introEnd ? "intro" : "item");
  return roles;
}

/** The ItemAnnouncement times (ms), de-duplicated and sorted, for the items a structure will show.
 * Ranks are enumerated from the structure (a countdown counts total→1; a list 1→total, or 1→30 when
 * the total is unknown) and located over the WHOLE word stream — the same spoken cues the overlays
 * bind to, so the footage cut and the ranking card share one clock. */
function announcementCutMs(words: WordTiming[], structure: VideoStructure): number[] {
  if (structure.kind === "sequence") {
    // Un-numbered ordered list — the item cuts are the ordinal markers themselves ("First", "Next", …).
    return ordinalCutMs(words);
  }
  const ranks = structure.direction === "down" && structure.total
    ? Array.from({ length: structure.total }, (_, i) => structure.total! - i) // total, total-1, … 1
    : Array.from({ length: structure.total ?? 30 }, (_, i) => i + 1); //          1, 2, … (or 1…30)
  const numeric = [...new Set(
    locateItemAnnouncements(words, ranks)
      .filter((a): a is ItemAnnouncement => a != null)
      .map((a) => a.atMs)
  )].sort((a, b) => a - b);
  if (numeric.length > 0) return numeric; // SPOKEN NUMBERS win — today's behavior, unchanged.
  // Fallback: a numeric/title structure (e.g. a "Top 5" title) whose narration announces items with
  // ordinal DISCOURSE markers ("First … Next … Then … Finally") instead of spoken numbers. Reuse the
  // ordinal scanner so the splitter still cuts each item. Only reached when NO number was located, so
  // it never competes with a working numeric path. Returns [] (no split) when there are no markers.
  return ordinalCutMs(words);
}

/**
 * Beat-boundary synchronization (Issue 2) — an ADDITIVE post-processing pass over the FROZEN
 * buildBeats() output. It splits ONLY the beats that STRADDLE an ItemAnnouncement (a beat whose span
 * contains the spoken cue strictly inside it) so the item's visual cut lands exactly on the cue
 * instead of at the next length-based boundary — the lag diagnosed in Issue 2 ("Number three" spoken
 * while the previous item's footage is still up). Everything else is deliberately conservative:
 *
 *   • buildBeats() is never touched — this composes on top of its result.
 *   • A beat with no interior cue passes through byte-identical (===), so no other boundary moves.
 *   • Only an INTERNAL boundary is added; each split beat's outer [startMs,endMs] is preserved, and
 *     the new segment starts exactly at the cue ms (which the pipeline's tiling then closes to).
 *   • Beats are renumbered 0..n-1 so downstream index-keyed maps (avatarSet, roles, queries) stay
 *     consistent — the only field that changes on a passed-through beat is never touched; index only
 *     shifts for beats after a split, and nothing depends on the absolute pre-split index value.
 *   • Deterministic and pure over (beats, words, structure); idempotent — re-running finds the new
 *     boundary already on a beat start (not strictly inside), so it splits nothing further. This is
 *     what keeps Resume stable. Returns the input unchanged when no cue straddles any beat.
 *
 * Gated by the caller to overlays-on + structured videos, so OFF / unstructured runs never call it
 * and their beats remain byte-identical.
 */
export function splitBeatsAtAnnouncements<T extends { index: number; startMs: number; endMs: number; text: string }>(
  beats: T[],
  words: WordTiming[],
  structure: VideoStructure
): T[] {
  const cuts = announcementCutMs(words, structure);
  if (cuts.length === 0) return beats; // no located announcement → today's beats, untouched

  const out: T[] = [];
  for (const b of beats) {
    const inside = cuts.filter((ms) => ms > b.startMs && ms < b.endMs); // STRICTLY inside → a straddle
    if (inside.length === 0) { out.push(b); continue; } //                aligned / no cue → unchanged (===)
    const bw = words.filter((wt) => wt.startMs >= b.startMs && wt.startMs < b.endMs);
    const bounds = [b.startMs, ...inside]; // each segment begins here and ends at its own last word
    for (let s = 0; s < bounds.length; s++) {
      const lo = bounds[s];
      const hi = s + 1 < bounds.length ? bounds[s + 1] : b.endMs + 1; // last segment takes the remainder
      const seg = bw.filter((wt) => wt.startMs >= lo && wt.startMs < hi);
      if (seg.length === 0) continue; // never emit an empty beat
      out.push({
        ...b,
        startMs: lo, //                     = b.startMs on the first segment; = the cue ms afterwards
        endMs: seg[seg.length - 1].endMs, // word-aligned; the pipeline's tiling closes the gap to `lo`
        text: seg.map((wt) => wt.word).join(" "),
      });
    }
  }
  return out.map((b, i) => ({ ...b, index: i })); // contiguous indices for downstream Set/Map keying
}

/**
 * Post-split pass — enforce the invariant that NO beat which STARTS an announced section is shorter
 * than `minMs`. buildBeats segments by DURATION and the announcement splitter cuts at ITEM ONSETS;
 * the two grids are unaligned, so a marker landing near a buildBeats boundary can leave a sub-`minMs`
 * leading beat for a section (e.g. a ~1s "Then, Pompeii." clip that flashes under the still-visible
 * establishing card while the next visual is already up). This merges such a short leading beat
 * FORWARD into the following beat(s) of the SAME section until it reaches `minMs`.
 *
 * Deliberately minimal and section-preserving:
 *   • Only a beat whose startMs is an announcement cut (`sectionStartMs`) is a section START; the intro
 *     (startMs 0, never a cut) and continuation beats are never leads and are copied through untouched.
 *   • It absorbs following SAME-section beats one at a time and STOPS as soon as the lead reaches
 *     `minMs` — so a genuinely long section keeps its extra visual beats (only the short LEAD is
 *     absorbed, never the whole section) and a lead already ≥ `minMs` is left exactly as-is.
 *   • It NEVER crosses a section boundary: the moment the next beat is itself a section start, it stops
 *     (a whole section shorter than `minMs` — its entire narration < minMs — is simply left as-is).
 *   • The merged beat keeps the LEAD's fields (so its establishing card / section metadata ride along),
 *     extending only its endMs + text.
 * Pure over its inputs; renumbers to contiguous indices; idempotent (a second pass finds no short lead).
 */
export function mergeShortSectionLeads<T extends { index: number; startMs: number; endMs: number; text: string }>(
  beats: T[],
  sectionStartMs: number[],
  minMs: number
): T[] {
  const starts = new Set(sectionStartMs);
  const isStart = (b: T) => starts.has(b.startMs);
  const out: T[] = [];
  let i = 0;
  while (i < beats.length) {
    let b = beats[i];
    if (isStart(b)) {
      let j = i + 1;
      // Absorb the immediately-following SAME-section beats (never a section start) while the lead is
      // still too short. Stops at minMs (keeps long sections multi-visual) or at the next section.
      while (b.endMs - b.startMs < minMs && j < beats.length && !isStart(beats[j])) {
        b = { ...b, endMs: beats[j].endMs, text: `${b.text} ${beats[j].text}`.trim() };
        j++;
      }
      out.push(b);
      i = j;
    } else {
      out.push(b);
      i++;
    }
  }
  return out.map((b, idx) => ({ ...b, index: idx }));
}

/**
 * Stage 2 — the ONE deterministic pass that owns structured-overlay numbering. Drops intro overlays,
 * THEN numbers the real items in on-screen order, so section 1 is always the first item's number (#N
 * for a countdown, #1 for a list), section 2 the next, and so on — regardless of how the narration
 * was folded into beats (numbering is duration-independent, and lives in one place so it can't drift).
 *
 * Intro handling (Stage C): the single, event-defined INTRO REGION (see introRegionEndMs) replaces
 * the old beat[0] + preview heuristics — a `section` overlay whose beat ends inside the region (the
 * hook, or a preview like "here are the top five…") is an intro overlay, never a ranked item, so it
 * can neither steal the first number nor flash a card during the introduction. Fail-open: with no
 * spoken first-item cue the region is just the hook, so numbering degrades to order-based.
 *
 * It ALSO enforces the Stage-1 establishing-card guarantee: a structured item's only overlay is the
 * ranking + title card, so a model-chosen date/fact/etc. can never appear as the first card (those
 * are a SUPPORTING role, added in Stage 2). Scoped to structured videos — generic overlays untouched.
 *
 * MUST run before scheduleOverlays(). Mutates in place; returns the TRANSIENT `beat.index → rank` map
 * (non-persisted) that scheduleOverlays consumes so the rank is never parsed back out of the card text.
 */
export function numberStructuredOverlays(
  beats: Beat[],
  structure: VideoStructure,
  words: WordTiming[] = []
): Map<number, number> {
  // Stage C — drop every `section` overlay inside the INTRO REGION [0, introEnd). A beat that ends
  // at/before introEnd lies wholly before the first item is announced (the hook, or an intro
  // preview), so its ranking mark is not a real item. The first item beat CONTAINS the announcement,
  // so its end is > introEnd → it survives and becomes section 1.
  const introEnd = introRegionEndMs(beats, words, structure);
  for (const b of beats) {
    if (b.overlay?.type === "section" && b.endMs <= introEnd) b.overlay = undefined;
  }

  // Capture the item HEADING (name) and optional SUPPORTING fact from the MODEL's overlay BEFORE
  // numbering rewrites it (model shape: item name in `title`, one short fact in `subtitle`). Keyed by
  // beat index. The fact is kept only when there is a real name AND a distinct fact (never the name).
  const headingByIndex = new Map<number, string>();
  const supportingFact = new Map<number, string>();
  for (const b of beats) {
    if (b.overlay?.type !== "section") continue;
    const name = stripLeadingNumbering(b.overlay.title).trim();
    if (name) headingByIndex.set(b.index, name);
    const fact = b.overlay.subtitle?.trim();
    if (name && fact && fact.toLowerCase() !== name.toLowerCase()) supportingFact.set(b.index, fact);
  }

  // Number the surviving sections: card = { title: heading, subtitle: rank label }, rank from the
  // spoken cue (kind + number) with an ordinal fallback. Returns the transient rank map (beat.index →
  // rank) that scheduleOverlays consumes, so the rank is never parsed back out of the card text.
  const rankByIndex = applyStructureNumbering(beats, structure, words);

  // Attach the supporting card to each surviving item (a beat dropped as intro/preview has no overlay
  // now, so it correctly gets none). The item NAME rides along as a subtle secondary label so the fact
  // always re-anchors to its object if the viewer glanced away. Timing is assigned by scheduleOverlays().
  for (const b of beats) {
    if (b.overlay?.type === "section" && supportingFact.has(b.index)) {
      const name = headingByIndex.get(b.index);
      b.supporting = { type: "fact", title: supportingFact.get(b.index)!, ...(name ? { subtitle: name } : {}) };
    }
  }

  // Stage 1 — GUARANTEED ESTABLISHING CARD. In a structured countdown the model no longer decides
  // what appears first: the establishing card is ALWAYS the ranking card (heading + rank). Any other
  // overlay the model chose on a beat (a date / fact / person / quote) must NOT stand in as an item's
  // first card, so drop the rest (their content, if useful, arrives as the supporting card above).
  // Scoped to structured videos only — generic overlays untouched.
  for (const b of beats) {
    if (b.overlay && b.overlay.type !== "section") b.overlay = undefined;
  }
  return rankByIndex;
}

/* ── Overlay scheduling (Stage 2.1): narration-synchronized timing ─────────────────────────
 *
 * Overlays must sync to the SPOKEN NARRATION, not to visual-segment boundaries. A ranking card
 * ("#5") appears the instant the voice says "Number five" — which may be 12 s into a 25 s visual
 * beat — and stays up for a reading-time hold, not the whole segment. We compute this ONCE at
 * plan time from the existing word timings (Whisper / proportional — no new AI call) and persist
 * the window on the beat, so Resume replays identical times. Fail-open: any gap falls back to the
 * beat window, i.e. today's behavior.
 */

/** Card lifetime bounds. Lifetime aims at the sentence boundary, clamped to [min, max]; the
 * reading-time estimate is the fallback when the timings carry no sentence punctuation. */
const OVERLAY_HOLD_MIN_MS = 2500;
const OVERLAY_HOLD_MAX_MS = 6000;
const OVERLAY_READ_CHARS_PER_SEC = 12;
/** Absolute floor kept even when the next card / video end forces a short window. */
const OVERLAY_MIN_VISIBLE_MS = 1200;

/** Spoken-number vocabulary → value, for locating an item announcement in the narration. */
const NUM_WORDS: Record<string, number> = {
  one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5,
  six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10,
  eleven: 11, eleventh: 11, twelve: 12, twelfth: 12, thirteen: 13, thirteenth: 13, fourteen: 14, fourteenth: 14,
  fifteen: 15, fifteenth: 15, sixteen: 16, sixteenth: 16, seventeen: 17, seventeenth: 17, eighteen: 18, eighteenth: 18,
  nineteen: 19, nineteenth: 19, twenty: 20, twentieth: 20, thirty: 30, thirtieth: 30, forty: 40, fortieth: 40,
  fifty: 50, fiftieth: 50, sixty: 60, sixtieth: 60, seventy: 70, seventieth: 70, eighty: 80, eightieth: 80,
  ninety: 90, ninetieth: 90, hundred: 100, hundredth: 100,
};

/** Words that typically precede an item number in narration ("number five", "fact four"). */
const CUE_LABELS = new Set([
  "number", "no", "fact", "tip", "trick", "hack", "lesson", "secret", "step", "chapter", "part",
  "reason", "thing", "myth", "mistake", "question", "entry", "coming", "next", "at",
]);

/** Numeric value of a spoken token (digit or spelled cardinal/ordinal), or null. */
function wordToNum(raw: string): number | null {
  const tok = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!tok) return null;
  if (/^\d+$/.test(tok)) {
    const n = parseInt(tok, 10);
    return n > 0 && n <= 100 ? n : null;
  }
  return NUM_WORDS[tok] ?? null;
}

/**
 * Find the ms at which the narration announces item `rank` within `beatWords`, or null.
 * Matches the number word/digit; if a label ("number"/"fact"/…) sits 1–2 words before it, the
 * cue starts at the label ("Number five" → the "Number"), else at the number itself.
 */
export function findItemCueMs(beatWords: WordTiming[], rank: number): number | null {
  for (let i = 0; i < beatWords.length; i++) {
    if (wordToNum(beatWords[i].word) !== rank) continue;
    for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
      const lw = beatWords[j].word.toLowerCase().replace(/[^a-z]/g, "");
      if (CUE_LABELS.has(lw)) return beatWords[j].startMs;
    }
    return beatWords[i].startMs;
  }
  return null;
}

/** A narration EVENT: the ms at which the voice announces ranked item `rank`. */
export interface ItemAnnouncement {
  rank: number;
  atMs: number;
}

/**
 * Stage A — locate where the narration ANNOUNCES each ranked item, scanning the WHOLE word stream
 * (never a beat window), so a ranking card's time is a fact of the SPEECH, independent of how the
 * footage was segmented into beats (i.e. independent of Seconds-per-Footage). Two safeguards:
 *
 *   • SEQUENCE-anchored — each rank is matched only at/after the previous rank's match (a forward
 *     cursor), so a recap ("…and that was number five, now number four") or a repeated number never
 *     produces a phantom announcement. Ranks are consumed positionally, so a clamped list with
 *     duplicate ranks (more items than the declared total) still aligns 1:1 with the input.
 *   • LABEL-required — a number counts as an announcement only with a cue label ("number", "at",
 *     "fact", …) 1–2 words before it, so a total ("the top FIVE") or an incidental number ("FIVE
 *     years ago") is never mistaken for an item cue. The cue START is that label ("Number five" →
 *     the "Number"), matching how a viewer perceives the announcement beginning.
 *
 * Returns one entry per input rank, in order; null where that item is never verbally announced (the
 * caller then falls back). Pure and deterministic → Resume-safe.
 */
export function locateItemAnnouncements(words: WordTiming[], ranks: number[]): (ItemAnnouncement | null)[] {
  const out: (ItemAnnouncement | null)[] = [];
  let cursor = 0; // forward-only scan position; enforces spoken order across ranks
  for (const rank of ranks) {
    let atMs: number | null = null;
    if (Number.isFinite(rank)) {
      for (let i = cursor; i < words.length; i++) {
        if (wordToNum(words[i].word) !== rank) continue;
        let labelIdx = -1;
        for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
          const lw = words[j].word.toLowerCase().replace(/[^a-z]/g, "");
          if (CUE_LABELS.has(lw)) { labelIdx = j; break; }
        }
        if (labelIdx >= 0) { atMs = words[labelIdx].startMs; cursor = i + 1; break; }
      }
    }
    out.push(atMs == null ? null : { rank, atMs });
  }
  return out;
}

/** A narration EVENT: the ms at which the voice begins delivering a supporting fact. */
export interface FactSpoken {
  atMs: number;
}

/** Function words ignored when matching a fact against the narration — they carry no anchor value. */
const FACT_STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "is", "are", "was", "were",
  "it", "its", "this", "that", "with", "by", "as", "from", "over", "more", "than", "about", "up",
  "has", "had", "have", "been", "which", "into", "out", "per", "its",
]);

/** Normalize a token for matching: lowercase, keep only [a-z0-9] (so "21,000" → "21000", "km." → "km"). */
function normalizeFactToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Stage B — locate the FactSpoken event: the ms at which the narration begins delivering `factText`,
 * searched ONLY inside the item's narration span `[spanStartMs, spanEndMs)` (from Stage A
 * announcements). Deterministic and tolerant of small wording differences, with NO AI call:
 *
 *   • The fact's significant tokens (numbers/dates are STRONG anchors; content words otherwise) are
 *     matched against the spoken words. A number/date match alone is enough (highly discriminative);
 *     without one, ≥2 distinct content-word matches within a short window are required — so a stray
 *     single word never triggers a false positive.
 *   • Returns the START of the SENTENCE that contains the anchor (within the span), so the card
 *     appears as the narrator OPENS that thought — not mid-sentence.
 *
 * Returns null when the fact is not confidently found in the span → the caller simply shows no
 * supporting card (never a mis-timed one).
 */
export function locateFactSpoken(
  words: WordTiming[],
  factText: string,
  spanStartMs: number,
  spanEndMs: number
): FactSpoken | null {
  const span = words.filter((w) => w.startMs >= spanStartMs && w.startMs < spanEndMs);
  if (span.length === 0) return null;

  const factTokens = factText.split(/\s+/).map(normalizeFactToken).filter((t) => t.length >= 2 && !FACT_STOPWORDS.has(t));
  if (factTokens.length === 0) return null;
  const factSet = new Set(factTokens);
  const strong = new Set(factTokens.filter((t) => /\d/.test(t))); // numbers / dates

  let anchorIdx = -1;
  if (strong.size) {
    for (let i = 0; i < span.length; i++) {
      if (strong.has(normalizeFactToken(span[i].word))) { anchorIdx = i; break; }
    }
  }
  if (anchorIdx < 0) {
    // No number matched → require a cluster of ≥2 distinct content words to avoid false positives.
    for (let i = 0; i < span.length && anchorIdx < 0; i++) {
      if (!factSet.has(normalizeFactToken(span[i].word))) continue;
      const hits = new Set<string>();
      for (let j = i; j < span.length && j < i + Math.max(factTokens.length + 3, 6); j++) {
        const t = normalizeFactToken(span[j].word);
        if (factSet.has(t)) hits.add(t);
      }
      if (hits.size >= Math.min(2, factTokens.length)) anchorIdx = i;
    }
  }
  if (anchorIdx < 0) return null;

  // Start of the sentence CONTAINING the anchor: step back to just after the previous terminal
  // punctuation within the span (else the span's first word).
  let sentStartIdx = 0;
  for (let j = anchorIdx - 1; j >= 0; j--) {
    if (/[.!?][)"'\]]*$/.test(span[j].word.trim())) { sentStartIdx = j + 1; break; }
  }
  return { atMs: span[sentStartIdx].startMs };
}

/**
 * The end-ms of the narration sentence that is being spoken at/after `fromMs` — the first word
 * whose token ends with sentence punctuation (`.`, `!`, `?`, allowing trailing quotes/brackets).
 * Returns null when the timings carry no such punctuation (e.g. bare proportional timing), so the
 * caller can fall back to a reading-time hold.
 */
export function findSentenceEndMs(words: WordTiming[], fromMs: number): number | null {
  for (const wt of words) {
    if (wt.startMs < fromMs) continue;
    if (/[.!?][)"'\]]*$/.test(wt.word.trim())) return wt.endMs;
  }
  return null;
}

/**
 * Compute each overlaid beat's on-screen window from the narration word timings, in place.
 *
 *  • Ranking cards are timed to a NARRATION EVENT — the global item announcement ("Number five")
 *    located over the whole word stream (Stage A) — NOT to the beat's word window. So a card's time
 *    is a fact of the speech, invariant to beat length / Seconds-per-Footage / how many visuals fill
 *    the item. It falls back to the beat start ONLY when the number is never spoken.
 *  • Every card's lifetime is a reading-time hold (clamped), NOT the visual duration — so a card
 *    on a 25 s beat shows for a few seconds, in sync with the voice, then disappears.
 *  • Windows never overlap the next card (bounded by the next card's announcement, not its beat).
 *
 * Pure over (beats, words); deterministic; the result is persisted so Resume is stable. `onDebug`,
 * when supplied, receives a one-line diagnostic for each supporting card skipped by the collision
 * guard (fact spoken inside the establishing card's window) — wired to the run log by the caller,
 * left undefined by the unit tests so the function stays logger-free.
 */
export function scheduleOverlays(
  beats: Beat[],
  words: WordTiming[],
  onDebug?: (message: string) => void,
  rankByIndex?: Map<number, number>,
  /** Sequence videos ("First … Next … Finally") have no spoken number to locate — the beats were
   *  already split AT the ordinal markers, so each establishing card sits at its beat start, and each
   *  item's supporting-fact span is [this item start, next item start). Skips the numeric-announcement
   *  hunt entirely, which also avoids an incidental "at one"/"number two" phantom-matching a card. */
  sequenceMode = false
): void {
  const videoEndMs = Math.max(
    beats.length ? beats[beats.length - 1].endMs : 0,
    words.length ? words[words.length - 1].endMs : 0
  );
  const overlaid = beats.filter((b) => b.overlay);

  // Stage A — bind every ranking card to its GLOBAL item announcement in the word stream. Ranks come
  // from the TRANSIENT rank map the numbering pass produced (beat.index → rank), NOT from the card
  // text — the section card's title is now the item heading. `locateItemAnnouncements` aligns the
  // ranks 1:1 to spoken announcements; this map, not the beat window, is the source of a card's time.
  const rankingBeats = overlaid.filter((b) => b.overlay!.type === "section");
  const ranks = rankingBeats.map((b) => {
    const fromMap = rankByIndex?.get(b.index);
    if (fromMap != null) return fromMap;
    // Legacy/test fallback ONLY when no rank map is supplied (isolated scheduleOverlays unit tests
    // that build pre-numbered "#5" section overlays). The real pipeline always passes rankByIndex.
    const n = Number(b.overlay!.title.match(/(\d+)/)?.[1]);
    return Number.isFinite(n) ? n : NaN;
  });
  // Sequence videos carry no spoken number, so there is nothing to locate — the beat start (= the
  // ordinal marker the beats were split at) is the card time. Numeric videos hunt the spoken cue.
  const announced = sequenceMode ? rankingBeats.map(() => null) : locateItemAnnouncements(words, ranks);
  const announcedStart = new Map<number, number>(); // beat.index → spoken announcement ms
  rankingBeats.forEach((b, i) => { const a = announced[i]; if (a) announcedStart.set(b.index, a.atMs); });
  // A card's START: the spoken announcement for a ranking card (else the beat start); the beat start
  // for a non-ranking card. Fully decoupled from Seconds-per-Footage whenever the item is announced.
  const startOf = (b: Beat): number =>
    b.overlay!.type === "section" ? (announcedStart.get(b.index) ?? b.startMs) : b.startMs;

  for (let k = 0; k < overlaid.length; k++) {
    const b = overlaid[k];
    const ov = b.overlay!;
    const startMs = startOf(b);

    // LIFETIME: align to the SEMANTIC boundary — the end of the current narration sentence —
    // rather than a fixed duration, so the card lives exactly as long as the thought it labels.
    // Fall back to a reading-time hold when the timings carry no sentence punctuation. Then clamp
    // to a sensible [min, max], keep it clear of the next card, and inside the narration.
    const chars = ov.title.length + (ov.subtitle?.length ?? 0);
    const readHold = Math.min(OVERLAY_HOLD_MAX_MS, Math.max(OVERLAY_HOLD_MIN_MS, Math.round((chars / OVERLAY_READ_CHARS_PER_SEC) * 1000)));
    const sentenceEnd = findSentenceEndMs(words, startMs);
    let endMs = sentenceEnd ?? startMs + readHold;
    endMs = Math.max(endMs, startMs + OVERLAY_HOLD_MIN_MS); // never flash by
    endMs = Math.min(endMs, startMs + OVERLAY_HOLD_MAX_MS); // never linger
    const next = overlaid[k + 1];
    const nextStart = next ? startOf(next) : undefined; // the next card's ANNOUNCEMENT, not its beat
    if (nextStart != null) endMs = Math.min(endMs, nextStart); // ...or just before the next card begins
    endMs = Math.min(endMs, videoEndMs);
    // Keep a minimum visible even after the next/video clamps (bounded BY them).
    endMs = Math.max(endMs, Math.min(startMs + OVERLAY_MIN_VISIBLE_MS, nextStart ?? videoEndMs, videoEndMs));

    b.overlayStartMs = Math.round(startMs);
    b.overlayEndMs = Math.round(endMs);
  }

  // Stage B — schedule each item's optional SUPPORTING card DIRECTLY from a FactSpoken narration
  // event: the ms the narrator begins delivering that fact, located inside the item's narration span
  // [announcement_k, announcement_{k+1}) (Stage A). Its time comes from the SPEECH, not from the
  // establishing card's lifetime, an artificial gap, or any beat — so it is invariant to
  // Seconds-per-Footage exactly like the ranking card. The establishing END is read ONLY as a
  // collision guard so two lower-thirds never stack; it never sets the timestamp.
  for (const b of beats) {
    b.supportingStartMs = undefined; // reset — deterministic regardless of prior state
    b.supportingEndMs = undefined;
  }
  for (let i = 0; i < rankingBeats.length; i++) {
    const b = rankingBeats[i];
    // Item narration span: numeric videos read it from the spoken announcements; sequence videos read
    // it from the item beats themselves (already cut at the ordinal markers) — [this start, next start).
    const spanStart = sequenceMode ? b.startMs : announced[i]?.atMs;
    if (!b.supporting || spanStart == null) continue; // no fact, or item never announced → no span

    // Span ends at the NEXT item (else the narration end) — the fact is never sought or shown across
    // the boundary into the next item.
    let spanEnd = videoEndMs;
    if (sequenceMode) {
      if (i + 1 < rankingBeats.length) spanEnd = rankingBeats[i + 1].startMs;
    } else {
      for (let j = i + 1; j < announced.length; j++) { const a = announced[j]; if (a) { spanEnd = a.atMs; break; } }
    }

    const fact = locateFactSpoken(words, b.supporting.title, spanStart, spanEnd);
    if (!fact) continue; // fact not confidently found in the span → no supporting card
    const supStart = fact.atMs;
    if (b.overlayEndMs != null && supStart < b.overlayEndMs) {
      // Collision guard (speech-based): the fact is spoken while the establishing card is still up,
      // so a second lower-third would stack on it — skip it rather than stack or shove it around.
      onDebug?.(`Supporting card "${b.supporting.title}" skipped: fact spoken at ${supStart}ms overlaps the establishing card (up to ${b.overlayEndMs}ms)`);
      continue;
    }
    if (supStart + OVERLAY_MIN_VISIBLE_MS > spanEnd) continue; // no room before the next item

    const sup = b.supporting;
    const chars = sup.title.length + (sup.subtitle?.length ?? 0);
    const readHold = Math.min(OVERLAY_HOLD_MAX_MS, Math.max(OVERLAY_HOLD_MIN_MS, Math.round((chars / OVERLAY_READ_CHARS_PER_SEC) * 1000)));
    let endMs = findSentenceEndMs(words, supStart) ?? supStart + readHold;
    endMs = Math.max(endMs, supStart + OVERLAY_HOLD_MIN_MS);
    endMs = Math.min(endMs, supStart + OVERLAY_HOLD_MAX_MS);
    endMs = Math.min(endMs, spanEnd, videoEndMs); // never cross into the next item
    endMs = Math.max(endMs, Math.min(supStart + OVERLAY_MIN_VISIBLE_MS, spanEnd, videoEndMs));

    b.supportingStartMs = Math.round(supStart);
    b.supportingEndMs = Math.round(endMs);
  }
}

export interface Beat {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  layout: BeatLayout;
  /** Concrete search/generation query for the B-roll. "" when layout = avatar. */
  visualQuery: string;
  /** Short title-like YouTube search query (#1): planner-compressed, 2–6 high-signal
   * keywords optimized for what is VISUALLY retrievable on YouTube. Undefined → the
   * YouTube fallback uses visualQuery (today's behavior). Consumed only when
   * YT_SEPARATE_QUERY=1. */
  youtubeQuery?: string;
  /** Rich Gemini-written prompt for AI generation (falls back to visualQuery). */
  aiPrompt?: string;
  /** This beat is a PRODUCT shot, and this is the wording that should be legible on the
   * packaging. Undefined on every other beat — which is most of them — and that is what
   * keeps their generation prompt byte-identical to before this existed. */
  productLabel?: string;
  /** Planner's per-beat AI media verdict (Patch 2 producer). Undefined → the
   * resolver in visual-source falls back to keyword heuristic, then global mode. */
  aiMedia?: "image" | "video";
  /** `aiMedia` above was set by the OPERATOR'S run-level ratio, not by the planner —
   * `resolveAiMedia` must honour it instead of re-deciding. Only ever set by
   * `applyAiVideoRatio`; undefined everywhere else, which is what keeps every run that
   * did not ask for a ratio byte-identical. */
  aiMediaPinned?: boolean;
  /** Planner's per-beat source-routing class (Smart Routing Patch 1). DIAGNOSTIC
   * ONLY — not yet read by acquireVisual/acquireReal. Undefined when absent/invalid. */
  queryType?: "entity" | "generic" | "abstract";
  /** Which visual engine fills the B-roll. Ignored when layout = avatar. */
  source: "real" | "ai";
  /** Keyword-classified content domain (Patch 2.3a). DIAGNOSTIC ONLY — logged for
   * observability, read by nothing yet (routing stays domain-blind until 2.3b). */
  domain?: Domain;
  /** Planner's per-beat footage-intent (Patch 2.4a). Drives modality routing in 2.4b
   * (archival → YouTube-first); undefined → today's behavior. */
  footageKind?: "archival" | "contemporary" | "conceptual";
  /** Topic Pool Retrieval key (P0): a canonicalized footage-intent identity shared by
   * beats that should reuse ONE provider search. `${footageKind}::<normalized visualQuery>`.
   * Only set on real-source visual beats; undefined otherwise. Read only when TOPIC_POOL=1;
   * beats with the same topicKey share a gathered candidate pool. Grouping is CONSERVATIVE:
   * exact normalized-query match (never fuzzy-merges distinct subjects), so a unique query is
   * its own singleton topic (= today's behavior). */
  topicKey?: string;
  /** Informational Overlay for this beat (Stage 1). Present ONLY when overlays were
   * enabled for the run AND the planner judged a card useful; undefined otherwise
   * (the overwhelming majority of beats). Serialized into beats.json with the beat,
   * so Resume replays it for free without re-planning. */
  overlay?: Overlay;
  /** Overlay SCHEDULE (Stage 2.1) — the absolute ms window the card is on screen, computed
   * from narration WORD TIMINGS at plan time, NOT from the beat's visual boundaries. A ranking
   * card starts when the narration announces the item ("Number five"); every card's lifetime is
   * a reading-time hold, so it stays in sync no matter how long the visual segment runs (15s, 25s).
   * Persisted in beats.json → Resume replays it deterministically. Undefined → the assembler
   * falls back to the beat window (backward compatible with pre-scheduling beats.json). */
  overlayStartMs?: number;
  overlayEndMs?: number;
  /** Optional SUPPORTING overlay (Stage 2) — a second card for a structured item (e.g. a stat/date),
   * shown AFTER the establishing card and a breathing gap, in the same lower-third. At most one per
   * item; absent when the model gave no supporting fact or there was no room. Its own window below. */
  supporting?: Overlay;
  /** Supporting card SCHEDULE (Stage 2) — absolute ms window, anchored to the next narrated sentence
   * after the establishing card + gap. Undefined when no supporting card was scheduled (fail-open).
   * Persisted in beats.json → Resume replays it deterministically. */
  supportingStartMs?: number;
  supportingEndMs?: number;
}

const SENTENCE_END = /[.!?]["')\]]?$/;
const CLAUSE_BREAK = /[,;:—–]["')\]]?$/;
// Connective tokens a beat must NOT end on — flushing here yields fragments like
// "turning into" / "hiding in". When the boundary token is one of these, the
// flush is deferred until a better (non-connective) boundary.
const BEAT_CONNECTIVES = new Set(["into", "and", "or", "that", "the", "a", "an", "of", "to", "in", "on"]);
const endsOnConnective = (token: string): boolean =>
  BEAT_CONNECTIVES.has(token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));

/**
 * Fold words into beats of ~targetSec, breaking at natural pauses.
 *
 * Beats vary between minSec and maxSec (defaults 3–10 s, settings
 * BEAT_MIN_SEC / BEAT_MAX_SEC) instead of all hitting the hard cap:
 *  - a sentence end closes the beat once it's past ~max(min, 55% of target);
 *  - a clause break (comma, colon…) closes it once it's ~15% past target —
 *    long sentences used to ride to the cap, making every beat the same length;
 *  - maxSec is the hard cap (mid-sentence cut as a last resort).
 */
export function buildBeats(
  words: WordTiming[],
  targetSec: number,
  minSec = 3,
  maxSec = 10
): Omit<Beat, "layout" | "visualQuery" | "source">[] {
  const target = Math.max(1.5, targetSec) * 1000;
  const minMs = Math.max(1000, Math.min(minSec, targetSec) * 1000);
  const maxMs = Math.max(target * 1.15, maxSec * 1000);
  const sentenceFloor = Math.max(minMs, target * 0.55);
  const beats: Omit<Beat, "layout" | "visualQuery" | "source">[] = [];
  let cur: WordTiming[] = [];
  let startMs = words[0]?.startMs ?? 0;

  const flush = () => {
    if (cur.length === 0) return;
    beats.push({
      index: beats.length,
      startMs,
      endMs: cur[cur.length - 1].endMs,
      text: cur.map((w) => w.word).join(" "),
    });
    cur = [];
  };

  for (const w of words) {
    if (cur.length === 0) startMs = w.startMs;
    cur.push(w);
    const dur = w.endMs - startMs;
    const wantFlush =
      (SENTENCE_END.test(w.word) && dur >= sentenceFloor) ||
      (CLAUSE_BREAK.test(w.word) && dur >= target * 1.15) ||
      dur >= maxMs;
    // FIX B: never end a beat on a connective token — keep accumulating to a
    // better boundary (applies to sentence, clause, AND hard-cap flushes).
    if (wantFlush && !endsOnConnective(w.word)) {
      flush();
    }
  }
  flush();

  // FIX A: merge a too-small trailing beat (e.g. "three-pound") into the previous
  // one — the final flush above is unconditional and can emit a weak tail beat.
  if (beats.length >= 2) {
    const last = beats[beats.length - 1];
    const lastWords = last.text.trim().split(/\s+/).filter(Boolean).length;
    if (last.endMs - last.startMs < minMs || lastWords <= 2) {
      const prev = beats[beats.length - 2];
      prev.text += " " + last.text;
      prev.endMs = last.endMs;
      beats.pop();
    }
  }
  return beats;
}

export interface GeminiQuery {
  index: number;
  visual_query?: string;
  youtube_query?: string;
  ai_prompt?: string;
  ai_media?: string;
  query_type?: string;
  footage_kind?: string;
  /** Wording that should be legible on the product's packaging. Empty/absent on every
   * non-product shot, which is the majority — see normalizeProductLabel. */
  product_label?: string;
  /** Overlays Stage 1 — present in the response only when overlays are enabled for
   * the run. `null` (the model's "no card") or malformed → dropped by normalizeOverlay. */
  overlay?: { type?: string; title?: string; subtitle?: string } | null;
}

export interface PlannedVisual {
  /** Short concrete stock-search query (3–9 words). */
  query: string;
  /** Short title-like YouTube search query (#1), 2–6 high-signal keywords. Undefined when absent/invalid. */
  youtubeQuery?: string;
  /** Rich 30–60 word generation prompt for AI beats (nano-banana / Veo). */
  aiPrompt?: string;
  /** Packaging wording for a product shot. Undefined when absent/invalid/not a product. */
  productLabel?: string;
  /** Planner's per-beat AI media verdict. Undefined when absent/invalid. */
  aiMedia?: "image" | "video";
  /** Planner's per-beat source-routing class (Patch 1: diagnostics only — NOT
   * yet consumed by any routing logic). Undefined when absent/invalid. */
  queryType?: "entity" | "generic" | "abstract";
  /** Planner's per-beat footage-intent (Patch 2.4a). Undefined when absent/invalid. */
  footageKind?: "archival" | "contemporary" | "conceptual";
  /** Validated informational overlay (Stage 1). Undefined = no card for this beat. */
  overlay?: Overlay;
}

/**
 * Default "split"/visual prompt — the editable guidance that tells the model what
 * to show on screen for each beat. A channel's `visual_prompt` overrides this.
 * The JSON-contract scaffolding (numbered list + return format) is always added
 * around it, so a channel only edits the creative guidance, never the contract.
 */
export const DEFAULT_VISUAL_GUIDANCE =
  "You are sourcing B-roll for a documentary-style narration. Choose what a viewer should see on screen " +
  "for each line: concrete nouns, places and actions — searchable, real-world imagery, never abstract concepts. " +
  "Always depict what the line actually says; any style preference only shapes the look, not the subject.";

// Chunked planning: a few beats per Gemini request instead of one giant call.
// Smaller requests 503 far less, return faster, and plan more reliably.
const PLAN_CHUNK_SIZE = 6;

/**
 * Build the per-chunk planning prompt. The rules (entity, abstract-scene,
 * ai_prompt, JSON schema) are IDENTICAL to the original single-call prompt — only
 * the beat list is a chunk, and an optional carry-over line preserves the
 * "nearest previous concrete subject" continuity the ABSTRACT SCENE RULE needs.
 */
export function buildPlanPrompt(
  chunk: { index: number; text: string; role?: VisualRole }[],
  guidance: string | undefined,
  scriptContext: string | undefined,
  carryOver: string,
  overlays = false,
  structureHint = ""
): string {
  // Visual Stage 1 — when the beats carry a role (structured video), tag each line and explain the
  // two roles, so the planner requests ESTABLISHING footage for the intro and the object for items.
  // Absent roles → byte-identical to before (untagged lines, no role block).
  const hasRoles = chunk.some((b) => b.role);
  const numbered = chunk
    .map((b) => `[${b.index}]${b.role ? ` (${b.role.toUpperCase()})` : ""} ${b.text}`)
    .join("\n");
  const roleGuidance = hasRoles
    ? `VISUAL ROLE — each narration line is tagged (INTRO) or (ITEM):\n` +
      `- (INTRO): the introduction, spoken BEFORE any ranked item is announced. Its "visual_query", ` +
      `"youtube_query" and "ai_prompt" must be ESTABLISHING / THEME footage of the overall subject — ` +
      `atmospheric, contextual, montage-style, scene-setting — and must NOT depict any specific object ` +
      `that will be counted down later, even if this line names it.\n` +
      `- (ITEM): describes a specific ranked object; depict THAT object concretely, per the rules below.\n\n`
    : "";
  // Overlays OFF (default) → the instruction block and the "overlay" field in the
  // return line are BOTH omitted, so the prompt string is byte-identical to today's.
  // The structure hint (Stage 2) is appended to the overlay block only when both overlays
  // are on AND a list structure was detected — otherwise it is empty.
  const overlayInstr = overlays
    ? `- "overlay": OPTIONAL informational card for this line, or null. Return an object ONLY when the line states a specific, self-contained fact worth putting on screen — ` +
      `a date/year (1969), a named person (Albert Einstein), a place or event (Moon Landing), a section/chapter marker (Chapter 4, Fact #7, Tip #3), a short striking statistic, or a quote. ` +
      `Shape: {"type": one of "date"|"title"|"person"|"fact"|"quote"|"section", "title": the SHORT primary text (a few words — the year, the name, the label), "subtitle": OPTIONAL one short supporting line}. ` +
      `Keep "title" terse (ideally ≤ 4 words); never a full sentence. Use "subtitle" only to add essential context (e.g. title "Apollo 11", subtitle "First Moon Landing"). ` +
      `Return null for ordinary narration, transitions, or anything without a concrete on-screen-worthy fact. Do NOT invent facts not present in the line. Most lines should be null.\n`
    : "";
  const overlayField = overlays
    ? `, "overlay": {"type": "<date|title|person|fact|quote|section>", "title": "<short string>", "subtitle": "<optional short string>"} OR null`
    : "";
  return (
    `${(guidance && guidance.trim()) || DEFAULT_VISUAL_GUIDANCE}\n\n` +
    (scriptContext ? `Overall video context (use it to keep visuals coherent): "${scriptContext}"\n\n` : "") +
    (carryOver ? `Context from previous chunk:\nLast concrete subject: ${carryOver}\n\n` : "") +
    roleGuidance +
    `Narration lines:\n${numbered}\n\n` +
    `For EACH line return BOTH:\n` +
    `- "visual_query": 3-9 words of concrete nouns/actions that LITERALLY depict what this line says. ` +
    `Style/region guidance above only flavors HOW it looks — it must never replace WHAT the line is about.\n` +
    `CRITICAL ENTITY RULE: If the line contains a proper noun (brand, product, company, store, landmark, organization, or person — ` +
    `e.g. Tide, Coca-Cola, Arm & Hammer Super Washing Soda, Walmart, Apple, Roman Colosseum) you MUST preserve that entity inside "visual_query". ` +
    `(1) Copy the named entity verbatim whenever possible (keep exact spelling, including "&"). ` +
    `(2) Place the named entity at the BEGINNING of "visual_query". ` +
    `(3) Add descriptive words around it only AFTER the entity. ` +
    `(4) NEVER replace a named entity with a generic description, color, shape, or category. ` +
    `Wrong: "Tide" -> "orange detergent bottle". Wrong: "Arm & Hammer Super Washing Soda" -> "yellow box". ` +
    `Good: "Tide detergent bottle". Good: "Arm & Hammer washing soda yellow box". ` +
    `(5) The SAME rule applies to "ai_prompt": name the actual product there too, never a colour-and-shape ` +
    `paraphrase of it. Wrong: "a bright yellow three-pound box on a shelf". ` +
    `Good: "a bright yellow three-pound box of Arm & Hammer Super Washing Soda on a shelf".\n` +
    `ABSTRACT SCENE RULE: If a line is abstract, rhetorical, metaphorical, transitional, or contains NO concrete depictable subject, ` +
    `do NOT output abstract words from the narration. Instead generate a CONCRETE documentary B-roll query grounded in, IN PRIORITY ORDER: ` +
    `(1) the NEAREST PREVIOUS CONCRETE SUBJECT in the narration (carry it forward across consecutive abstract lines), then ` +
    `(2) the OVERALL VIDEO TOPIC above if no recent concrete subject exists. ` +
    `Prefer: establishing shots, contextual B-roll, product close-ups, environment shots, process footage, crowd shots, hands interacting with objects. ` +
    `Wrong: "walking past" -> "walking past". Wrong: "nose trained validate markup" -> "nose validate markup". Wrong: "where it gets interesting" -> "interesting moment". ` +
    `Good (detergent documentary): "walking past" -> "shoppers walking past detergent aisle". "nose trained validate markup" -> "person smelling freshly washed clothes closeup". "where it gets interesting" -> "detergent bottle closeup on supermarket shelf". ` +
    `visual_query must ALWAYS be concrete and searchable in stock-footage libraries — NEVER abstract concepts, rhetoric, or connective phrases.\n` +
    `NEGATION RULE: "visual_query" must describe ONLY what is VISIBLE in the frame, never what is ABSENT. NEVER use negation words ` +
    `(no, not, without, never, none). Stock search has no concept of negation — "spinning without power" matches power turbines (the opposite subject). ` +
    `Drop the absence entirely. Wrong: "turbine ventilator spinning without power" -> keep "without power". ` +
    `Wrong: "turbine ventilators no electricity no electronics". Good: "turbine ventilator spinning on roof". Good: "turbine ventilators on warehouse rooftops".\n` +
    `- "youtube_query": a SHORT keyword search query (2-6 high-signal keywords) optimized for finding real B-roll on YouTube, where search matches human-written video TITLES. ` +
    `This is SEPARATE from visual_query — do NOT just copy it. Rules: ` +
    `(1) Lead with the most specific NAMEABLE subject (entity, product, place, object). ` +
    `(2) Drop filler, adjectives, connectives, and descriptive clauses — keep only concrete searchable nouns. ` +
    `(3) NEVER add production words like "cinematic", "b roll", "footage", "4k", "stock" — they pull camera/filmmaking tutorials, not the subject. ` +
    `(4) MOST IMPORTANT: optimize for the most VISUALLY SEARCHABLE subject, NOT the most semantically central phrase — prioritize what real footage of this actually EXISTS on YouTube. ` +
    `Bad: "large language models" -> Good: "GPU server racks". Bad: "Japanese daily life convenient innovations" -> Good: "Japan vending machine". ` +
    `Good examples: "Tokyo train platform safety doors", "NVIDIA H100 data center racks", "Parker shotgun", "Annie Oakley archival". ` +
    `For abstract/vague lines, apply the same NEAREST-CONCRETE-SUBJECT rule as visual_query. Always 2-6 words, never a full sentence.\n` +
    `- "ai_prompt": a 30-60 word PHOTOREALISTIC, real-world documentary image-generation prompt for the same line ` +
    `(concrete subject, real setting, composition, lighting), consistent with the overall video topic above. ` +
    `It must depict a believable real photograph — NEVER fantasy, sci-fi, surreal, abstract, magical or artistic imagery, ` +
    `even if the sentence is metaphorical (translate metaphors into a literal real-world object/scene). ` +
    `No captions, subtitles, signs or posters — but a product's OWN packaging label is part of the product and is allowed.\n` +
    `- "product_label": ONLY for a shot whose main subject is a product or its packaging. Give the wording that should be ` +
    `legible on the pack: the named brand copied verbatim when the line names one, otherwise a short plausible category ` +
    `wording (e.g. "LAUNDRY BOOSTER"). 1-4 words, no quotes, never a sentence from the narration. ` +
    `Leave it EMPTY ("") for every other shot — people, places, landscapes, processes, abstract scenes. ` +
    `An empty value is the normal case; do not invent a product shot to fill it.\n` +
    `- "ai_media": either "video" or "image", deciding how this beat is generated IF it becomes an AI beat. ` +
    `Choose "video" ONLY if motion materially improves the semantic meaning of the scene — the point of the shot is something moving, reacting, ` +
    `flowing, colliding, transforming, or a deliberate camera move (e.g. "surfactants attacking grease", "molecules colliding", "energy waves spreading"). ` +
    `If the scene communicates well as a still frame, choose "image" (e.g. product packshots, shelves, labels, comparisons, before/after, static compositions). ` +
    `Do NOT choose "video" merely because motion looks nicer. When unsure, choose "image".\n` +
    `- "query_type": exactly one of "entity", "generic", or "abstract", classifying what KIND of footage best fits this beat. ` +
    `Judge by WHAT MUST APPEAR ON SCREEN and whether ordinary stock can supply it — NOT by which proper nouns appear in the sentence. ` +
    `"entity" = the on-screen subject is a SPECIFIC, nameable real-world thing whose exact identity matters and that generic stock CANNOT substitute: ` +
    `a named famous person (e.g. Richard Nixon), a specific landmark or building (e.g. Eiffel Tower, Berlin Wall, Roman Colosseum), ` +
    `a branded product/store/logo (e.g. Walmart aisle, Tesla factory), or an iconic datable event with known archival footage (e.g. the moon landing). ` +
    `IMPORTANT EXCLUSION: if the sentence merely MENTIONS a country, organization, or economic/historical event but the VISUAL is a generic depictable subject ` +
    `(gold bars, bank vault, money, offices, trading floors, maps, crowds), classify "generic" — NOT "entity". ` +
    `e.g. "France moved gold reserves from foreign banks" -> generic (visual = gold bars / bank vault, well covered by stock). ` +
    `"generic" = a common, unbranded scene, environment, object, or action that ordinary stock footage covers well ` +
    `(e.g. "beach sunset", "person typing on laptop", "washing machine spinning", "city traffic", "gold bars in a vault"). ` +
    `"abstract" = a scientific, microscopic, conceptual, or process scene that real footage rarely provides and AI suits better ` +
    `(e.g. "molecules colliding", "surfactants dissolving grease", "energy waves", "particle interactions", "chemical reaction"). ` +
    `When unsure between entity and generic, prefer "generic"; when unsure between generic and abstract, prefer "generic".\n` +
    `- "footage_kind": exactly one of "archival", "contemporary", or "conceptual", deciding WHICH REAL-WORLD FOOTAGE SOURCE best fits — judged by WHERE usable footage of this subject actually exists. ` +
    `"archival" = a historical event, era, or figure whose real footage is OLD broadcast/newsreel/documentary material (e.g. "Berlin Wall falling 1989", "Apollo 11 launch", "Nixon resignation", "Chernobyl 1986", WWII, the Cold War) — found on archives/YouTube, NOT modern stock. ` +
    `"contemporary" = a MODERN real-world subject whose footage is present-day B-roll on stock libraries (e.g. data centers, NVIDIA chips, office workers, trading floors, factories, city streets, products) — even if a modern brand/person is named. ` +
    `"conceptual" = no real footage exists; a scientific/microscopic/abstract/process visual better generated by AI (e.g. "molecules colliding", "neural network visualization", "energy waves") — typically aligns with query_type "abstract". ` +
    `Judge by the ERA and AVAILABILITY of real footage, NOT the topic: a modern company is "contemporary", a 20th-century event is "archival". When unsure between archival and contemporary, prefer "contemporary".\n\n` +
    overlayInstr +
    (overlays ? structureHint : "") +
    `Return STRICTLY a JSON array, one object per line IN ORDER: {"index": <int>, "visual_query": "<string>", "youtube_query": "<string>", "ai_prompt": "<string>", "ai_media": "<image|video>", "query_type": "<entity|generic|abstract>", "footage_kind": "<archival|contemporary|conceptual>"${overlayField}}. No markdown.`
  );
}

/**
 * Concatenate the ANSWER text of a Gemini response, skipping THOUGHT parts.
 *
 * `thinkingConfig: { thinkingBudget: 0 }` should preclude thought parts on the default
 * flash ladder, but SCENE_SPLIT_MODEL is operator-configurable and a reasoning-tier model
 * can emit `{ thought: true, text: "…" }` alongside the answer. Joining those in produces
 * prose glued to the JSON — which is exactly the class of body that used to kill the
 * chunk. Near-zero-cost future-proofing. `thought` is not in the shared response type
 * (gemini-models.ts stays minimal), so it is narrowed locally rather than widened there.
 */
function plannerText(json: GeminiGenerateContentResponse): string {
  return (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => (p as { thought?: boolean }).thought !== true)
    .map((p) => p.text ?? "")
    .join("");
}

/**
 * Every TOP-LEVEL `[...]` span in `src`, bracket-balanced and string-aware (quotes and
 * backslash escapes are honored, so a `]` inside a string value never closes a span).
 * Unclosed trailing spans are dropped. Used to recover from a model that emits MORE than
 * one array in a single body.
 */
function balancedArraySpans(src: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(src.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}

/**
 * Parse the planner's JSON array out of a raw Gemini text body. Returns null when no
 * non-empty array can be recovered (caller → retry, then keyword fallback).
 *
 * WHY THIS IS NOT JUST `JSON.parse(text.match(/\[[\s\S]*\]/)[0])` (the old one-liner):
 * `responseMimeType: "application/json"` is used WITHOUT a `responseSchema`, which is a
 * SOFT constraint — the model occasionally restarts and emits the array TWICE in one
 * body (`[{…}][{…}]`). The greedy regex spans from the FIRST `[` to the LAST `]`, so it
 * hands JSON.parse a `]` immediately followed by a `[` and throws
 * `Expected ',' or ']' after array element in JSON at position …` — the exact error four
 * clients hit, which cost the whole 6-beat chunk to the crude keyword planner.
 *
 * So we try several candidate spans and keep the LARGEST that yields a non-empty array:
 *   1. the whole body (already-clean JSON — the overwhelmingly common case);
 *   2. the greedy span (historical behavior; strips markdown fences / prose around it);
 *   3. each individual balanced top-level `[...]` span (recovers the duplicated-array case).
 * Pure + total: never throws, so it is safe to use both as the parseability probe inside
 * `validate` and as the real return value.
 */
export function parsePlannerArray(text: string): GeminiQuery[] | null {
  const src = (text ?? "").trim();
  if (!src) return null;
  const candidates: string[] = [];
  const push = (s: string | undefined) => {
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(src);
  push(src.match(/\[[\s\S]*\]/)?.[0]);
  for (const span of balancedArraySpans(src)) push(span);

  let best: GeminiQuery[] | null = null;
  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue; // this span isn't valid JSON — try the next, never throw out of here
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    if (!best || parsed.length > best.length) best = parsed as GeminiQuery[];
  }
  return best;
}

/**
 * Structured-output schema for the planner response (Gemini `responseSchema`). This is the
 * PREVENTION layer that complements parsePlannerArray's RECOVERY layer: with a schema the
 * model is CONSTRAINED to emit a JSON array of exactly these objects, so the soft-constraint
 * failures parsePlannerArray was written to repair — a duplicated/restarted array, markdown
 * fences, a missing comma between elements — become structurally impossible at the source
 * rather than fixed after the fact. It encodes precisely what the prompt already asks for
 * (same fields, order, enums), so a well-formed plan is unchanged; parsePlannerArray + the
 * validate/retry path stay in place as defense-in-depth for the residual cases (e.g. a
 * MAX_TOKENS truncation, or an operator-configured model that ignores the schema). Gemini's
 * schema dialect uses UPPERCASE OpenAPI type names.
 */
const PLAN_RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      index: { type: "INTEGER" },
      visual_query: { type: "STRING" },
      youtube_query: { type: "STRING" },
      ai_prompt: { type: "STRING" },
      ai_media: { type: "STRING", enum: ["image", "video"] },
      query_type: { type: "STRING", enum: ["entity", "generic", "abstract"] },
      footage_kind: { type: "STRING", enum: ["archival", "contemporary", "conceptual"] },
      // Product-shot label. Deliberately NOT in `required`, like `overlay`: the model
      // returns wording only for a product shot and an empty string otherwise, and an
      // empty value must cost nothing — it restores the pre-feature prompt verbatim.
      product_label: { type: "STRING" },
    },
    required: ["index", "visual_query", "youtube_query", "ai_prompt", "ai_media", "query_type", "footage_kind"],
    // Deterministic field order for stable, diffable output (Gemini-specific hint).
    propertyOrdering: ["index", "visual_query", "youtube_query", "ai_prompt", "ai_media", "query_type", "footage_kind", "product_label"],
  },
} as const;

/**
 * Overlays Stage 1 — the response schema WITH the optional `overlay` object.
 *
 * Built by extending the base schema so the two can never drift. `overlay` is
 * `nullable` and deliberately NOT in `required`: the model returns an object only
 * when a card is warranted and `null`/omits it otherwise (enforced downstream by
 * normalizeOverlay). Used only when overlays are enabled — the OFF path keeps
 * PLAN_RESPONSE_SCHEMA byte-identical to before this feature.
 */
const PLAN_RESPONSE_SCHEMA_WITH_OVERLAY = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      ...PLAN_RESPONSE_SCHEMA.items.properties,
      overlay: {
        type: "OBJECT",
        nullable: true,
        properties: {
          type: { type: "STRING", enum: ["date", "title", "person", "fact", "quote", "section"] },
          title: { type: "STRING" },
          subtitle: { type: "STRING" },
        },
        required: ["type", "title"],
        propertyOrdering: ["type", "title", "subtitle"],
      },
    },
    required: [...PLAN_RESPONSE_SCHEMA.items.required],
    propertyOrdering: [...PLAN_RESPONSE_SCHEMA.items.propertyOrdering, "overlay"],
  },
} as const;

/**
 * One Gemini planning request for a single chunk. Delegates all model
 * selection / retry / failover to the shared {@link callGemini} helper (each
 * live model tried once, 45s timeout, transient → back off + fail over,
 * permanent 404/4xx → skip). Returns the parsed rows, or null if every live
 * model failed — the caller then leaves those beats to the keyword fallback.
 *
 * The parse happens INSIDE `validate`, not after the call returns. `callGemini`'s
 * contract is "validate() throw → TRANSIENT retry, model NOT killed", so a malformed
 * body now costs a retry (on the NEXT model in the ladder, where a model-specific
 * quirk is unlikely to recur) instead of silently dumping all PLAN_CHUNK_SIZE beats
 * onto the keyword planner. Mirrors the vision scorer in visual-source.ts.
 *
 * Cost: the shared defaults apply (attempts = ladder length, backoff 4000·n), so a
 * retried chunk adds roughly 5–9 s. planVisualQueries' chunk loop is SEQUENTIAL, so
 * that stacks per failing chunk — acceptable against losing the chunk's plan entirely.
 */
export async function requestPlanChunk(prompt: string, runId: string, apiKey: string, model: string, overlays = false): Promise<GeminiQuery[] | null> {
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      // OFF (default) → the exact schema as before this feature; ON → the same schema
      // plus the optional `overlay` object. Nothing else about the request changes.
      responseSchema: overlays ? PLAN_RESPONSE_SCHEMA_WITH_OVERLAY : PLAN_RESPONSE_SCHEMA, // structured output — prevents malformed JSON at the source
      temperature: 0,
      maxOutputTokens: 20000,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  try {
    const { json: j } = await callGemini({
      apiKey,
      model,
      body,
      timeoutMs: 45_000, // a hung Gemini request once stalled planning for minutes
      validate: (json, usedModel) => {
        // Cost Monitoring — planner is a Gemini text call; meter real token usage.
        // ⚠️ THIS CALL BELONGS HERE, AT THE TOP OF validate, AND NOWHERE ELSE. Do NOT
        // "clean it up" back onto the success path after callGemini returns: retries mean
        // there can be SEVERAL HTTP-200 responses per chunk and Google bills every one of
        // them. Metering only the final one would silently understate /costs. It runs
        // UNCONDITIONALLY, before the parseability probe below, so a billed-but-unparseable
        // attempt still counts. Exactly one recordGemini call exists in this function.
        // (Same placement + same warning as the vision scorer in visual-source.ts.)
        recordGemini(runId, "geminiText", json.usageMetadata?.promptTokenCount ?? 0, json.usageMetadata?.candidatesTokenCount ?? 0, usedModel);
        const text = plannerText(json);
        if (!text.trim()) throw new Error(`empty response (finishReason=${json.candidates?.[0]?.finishReason ?? "?"})`);
        // Parseability probe → a malformed/duplicated array body is a transient retry.
        if (!parsePlannerArray(text)) throw new Error(`unparseable planner JSON (${text.length} chars)`);
      },
      onFailure: ({ attempt, maxAttempts, model: m, nextModel, reason, kind }) => {
        log(runId, "warn",
          `Gemini attempt ${attempt}/${maxAttempts} — model ${m}: ${reason.slice(0, 80)}. ${kind === "permanent" ? "Permanent error, skipping model." : "Transient error."}` +
          (nextModel ? ` ${kind === "permanent" ? "Trying" : "Retrying with"} ${nextModel}.` : ""),
          { stage: "plan" });
      },
    });
    // validate() already proved this parses, so the null branch is unreachable in practice.
    return parsePlannerArray(plannerText(j));
  } catch (e) {
    const msg = (e as Error).message;
    // An exhausted key 429s on every chunk; say so ONCE, above the per-chunk fallback line.
    noteGeminiQuota(runId, msg);
    log(runId, "warn", `Gemini planner unavailable (${msg.slice(0, 120)}) — falling back to keyword planner for those beats`, { stage: "plan" });
    return null;
  }
}

/** Ask Gemini for a concrete visual search query (+ AI prompt) per beat. Best-effort. */
async function planVisualQueries(
  beats: { index: number; text: string; role?: VisualRole }[],
  runId: string,
  guidance?: string,
  scriptContext?: string,
  overlays = false,
  structureHint = ""
): Promise<Map<number, PlannedVisual>> {
  const out = new Map<number, PlannedVisual>();
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) {
    noteGeminiKeyMissing(runId, "plan");
    log(runId, "warn", "GOOGLE_API_KEY not set — using beat text as the visual query", { stage: "plan" });
    return out;
  }
  const model = getSetting("SCENE_SPLIT_MODEL"); // blank/retired → live default via buildGeminiLadder

  // Plan in small chunks (PLAN_CHUNK_SIZE beats each) rather than one giant
  // request — far fewer 503s and steadier quality. `carryOver` threads the last
  // concrete subject of each chunk into the next so the ABSTRACT SCENE RULE's
  // "nearest previous concrete subject" continuity survives chunk boundaries.
  let carryOver = "";
  for (let start = 0; start < beats.length; start += PLAN_CHUNK_SIZE) {
    const chunk = beats.slice(start, start + PLAN_CHUNK_SIZE);
    const prompt = buildPlanPrompt(chunk, guidance, scriptContext, carryOver, overlays, structureHint);
    const arr = await requestPlanChunk(prompt, runId, apiKey, model, overlays);
    if (arr) {
      for (const q of arr) {
        if (typeof q.index === "number" && q.visual_query) {
          // Strict whitelist: anything not exactly "image"/"video" → undefined,
          // so the consumer's keyword/default fallback owns the decision.
          const m = q.ai_media?.trim().toLowerCase();
          const aiMedia = m === "video" || m === "image" ? m : undefined;
          if (aiMedia) {
            log(runId, "debug", `Beat ${q.index}: planner ai_media=${aiMedia}`, { stage: "plan" });
          } else if (q.ai_media != null) {
            log(runId, "debug", `Beat ${q.index}: planner ai_media invalid/ignored ("${q.ai_media}")`, { stage: "plan" });
          }
          // Strict whitelist: only entity/generic/abstract survive; anything else
          // → undefined (DIAGNOSTIC ONLY in Patch 1 — no routing consumes it yet).
          const t = q.query_type?.trim().toLowerCase();
          const queryType = t === "entity" || t === "generic" || t === "abstract" ? t : undefined;
          if (queryType) {
            log(runId, "debug", `Beat ${q.index}: planner query_type=${queryType}`, { stage: "plan" });
          } else if (q.query_type != null) {
            log(runId, "debug", `Beat ${q.index}: planner query_type invalid/ignored ("${q.query_type}")`, { stage: "plan" });
          }
          // Strict whitelist: only archival/contemporary/conceptual survive (Patch 2.4a).
          const f = q.footage_kind?.trim().toLowerCase();
          const footageKind = f === "archival" || f === "contemporary" || f === "conceptual" ? f : undefined;
          if (footageKind) {
            log(runId, "debug", `Beat ${q.index}: planner footage_kind=${footageKind}`, { stage: "plan" });
          } else if (q.footage_kind != null) {
            log(runId, "debug", `Beat ${q.index}: planner footage_kind invalid/ignored ("${q.footage_kind}")`, { stage: "plan" });
          }
          const youtubeQuery = q.youtube_query?.trim() || undefined;
          if (youtubeQuery) log(runId, "debug", `Beat ${q.index}: planner youtube_query="${youtubeQuery}"`, { stage: "plan" });
          // Product-shot label. Empty is the normal answer, so only a REJECTED non-empty
          // value is worth a log line — an empty one would be noise on most beats.
          const productLabel = normalizeProductLabel(q.product_label);
          if (productLabel) {
            log(runId, "debug", `Beat ${q.index}: planner product_label="${productLabel}"`, { stage: "plan" });
          } else if (typeof q.product_label === "string" && q.product_label.trim()) {
            log(runId, "debug", `Beat ${q.index}: planner product_label rejected ("${q.product_label.trim().slice(0, 60)}")`, { stage: "plan" });
          }
          // Overlays Stage 1 — validate the model's card (or drop it). Only ever present
          // when overlays are enabled; normalizeOverlay fail-closes on null/garbage.
          const overlay = overlays ? normalizeOverlay(q.overlay) : undefined;
          if (overlay) log(runId, "debug", `Beat ${q.index}: overlay type=${overlay.type} title="${overlay.title}"`, { stage: "plan" });
          out.set(q.index, { query: q.visual_query.trim(), youtubeQuery, aiPrompt: q.ai_prompt?.trim() || undefined, productLabel, aiMedia, queryType, footageKind, overlay });
        }
      }
    }
    // Carry the LAST concrete subject of this chunk forward. If the chunk failed
    // (arr === null) carryOver is left unchanged, preserving continuity past the gap.
    for (let i = chunk.length - 1; i >= 0; i--) {
      const q = out.get(chunk[i].index)?.query;
      if (q) {
        carryOver = q;
        break;
      }
    }
  }
  return out;
}

// When Gemini is unavailable, we must NOT feed the raw narration sentence as the
// visual query — image models (nano-banana/Veo) render it as on-screen text, and
// stock search treats a whole sentence poorly. Reduce it to a few keywords.
const STOPWORDS = new Set(
  ("the a an and or but of to in on for with by at from as is are was were be been being this that these those it its " +
    "you your we our they their he she his her will would can could should what why how when where who whom about into " +
    "over under then than so just most more very really there here i me my do does did have has had not no yes if then " +
    "this video understand end").split(/\s+/)
);
// WI-7 — narration words that hurt FOOTAGE search (temporal, vague quantifiers, narrative verbs,
// abstract connectives, common capitalized sentence-starters). Dropped from the Gemini-503 fallback
// query so concrete nouns + named entities lead. Kept conservative to avoid stripping the subject.
const QUERY_FILLER = new Set(
  ("last first years year ago today now future past recently century decade era moment time age " +
   "many much most several few some every entire whole across toward through within beyond " +
   "becoming became become transformed transforming transformation shift shifting resembles believed " +
   "started starting powering operating investing pushed considered established understood designed " +
   "inside over meanwhile however despite yet also often where while modern next generation whose aggressively heavily").split(/\s+/)
);
// Narration → FOOTAGE-shaped fallback query (used only when Gemini planning is unavailable). Leads
// with named entities (capitalized proper nouns: NVIDIA, Tesla, "Jensen Huang"), drops STOPWORDS +
// QUERY_FILLER, caps short so YouTube search isn't over-constrained. Never returns empty.
function keywordsFrom(text: string): string {
  // 1. Named entities — capitalized proper-noun tokens in ORIGINAL case, minus stop/filler/starters.
  const entities: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const t = raw.replace(/[^\p{L}\p{N}&]/gu, "");
    const low = t.toLowerCase();
    if (t.length > 1 && /^\p{Lu}/u.test(t) && !STOPWORDS.has(low) && !QUERY_FILLER.has(low) && !seen.has(low)) {
      seen.add(low);
      entities.push(t);
    }
  }
  // 2. Remaining content words — lowercased, minus stopwords + filler (and entities already taken).
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const content = words.filter((w) => w.length > 2 && !STOPWORDS.has(w) && !QUERY_FILLER.has(w) && !seen.has(w));
  // 3. Entity-first, capped at 5 (short = less over-constrained search). Never empty.
  const chosen = [...entities, ...content].slice(0, 5);
  if (chosen.length) return chosen.join(" ");
  const kept = words.filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return (kept.length ? kept : words).slice(0, 6).join(" ");
}

// WI-13 — non-depictable abstract/economic/rhetorical tail words. Gemini sometimes keeps a
// correct concrete subject but appends one of these (e.g. "Battery production lines scaling
// energy output"), which pulls FOOTAGE search off-topic (→ BESS/solar/physics). We strip ONLY
// these from the footage query; concrete depictable nouns (infrastructure, data center, factory,
// robots, energy, chips, …) are deliberately NOT listed. Conservative by design.
const ABSTRACT_QUERY_TERMS = new Set(
  ("scaling scale output powering revolution transformation future era race growth demand " +
   "optimization integration efficiency productivity innovation ecosystem landscape backbone " +
   "frontier paradigm breakthrough intelligence").split(/\s+/)
);
/**
 * WI-13 — trim non-depictable abstract tails from a FOOTAGE query so search stays on-subject.
 * Removes ABSTRACT_QUERY_TERMS tokens (case-insensitive), preserving order + original casing of
 * the rest (named entities kept). FAIL-SAFE: if trimming would leave < 2 words, return the
 * original unchanged — never empty, never reduced to noise. Punctuation-light split on whitespace.
 */
function shapeFootageQuery(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((t) => !ABSTRACT_QUERY_TERMS.has(t.replace(/[^\p{L}\p{N}&]/gu, "").toLowerCase()));
  return kept.length >= 2 ? kept.join(" ") : query;
}

/**
 * Topic Pool Retrieval (P0) — canonical topic identity for a beat's footage search.
 * Normalizes the visual query into a stable key so beats that would issue effectively the SAME
 * search can be grouped and share one gathered pool: lowercase, strip punctuation, drop STOPWORDS
 * + QUERY_FILLER, collapse whitespace. Namespaced by footageKind so archival and contemporary
 * footage of the same subject never share a pool (they route to different sources). Word ORDER is
 * preserved (not sorted) so "river bank" and "bank river" stay distinct. Returns undefined when no
 * meaningful token survives (→ ungrouped singleton). CONSERVATIVE by design: only EXACT normalized
 * matches group — never fuzzy-merges distinct subjects (the canonical floor from the design doc).
 */
function topicKeyFor(visualQuery: string, footageKind: Beat["footageKind"]): string | undefined {
  const norm = visualQuery
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w) && !QUERY_FILLER.has(w))
    .join(" ")
    .trim();
  return norm ? `${footageKind ?? "any"}::${norm}` : undefined;
}

// ── Domain classification (Patch 2.3a) — DIAGNOSTIC ONLY ───────────────────
// Keyword tables per domain. Resolution is PRECEDENCE-FIRST: the FIRST domain in
// DOMAIN_ORDER with any keyword match wins (match count ignored); no match →
// "generic". Sets are disambiguated on overlap cases (valuation→startup,
// market→finance, "tesla" omitted from ai) so mixed beats resolve as specified.
// Read by NOTHING — routing/scoring stay domain-blind until 2.3b.
const DOMAIN_KEYWORDS: Record<Exclude<Domain, "generic">, string[]> = {
  history: ["archival", "newsreel", "war", "world war", "wwii", "ancient", "revolution",
    "dynasty", "cold war", "apollo", "soviet", "nazi", "empire", "historic", "historical", "vintage",
    // Iconic named events/landmarks (keyword coverage is necessarily partial — see Q6;
    // real beats also carry narration + dates, which the 18xx/19xx year rule catches).
    "berlin wall", "chernobyl", "moon landing", "pearl harbor", "hiroshima", "vietnam",
    "titanic", "holocaust", "great depression", "renaissance", "colosseum", "pyramid", "cuban missile"],
  finance: ["federal reserve", "fed", "interest rate", "central bank", "inflation", "earnings",
    "stock", "bond", "yield", "gold reserve", "market", "hedge fund", "goldman sachs", "gdp", "recession"],
  ai: ["artificial intelligence", "machine learning", "neural", "llm", "gpu", "chip", "silicon",
    "semiconductor", "data center", "model training", "accelerator", "nvidia", "openai", "inference", "ai"],
  startup: ["startup", "series a", "series b", "series c", "seed round", "pre-seed", "venture",
    "vc", "founder", "valuation", "funding", "ipo", "unicorn", "pitch deck", "y combinator", "cap table"],
  business: ["warehouse", "logistics", "supply chain", "production line", "factory", "retail",
    "company", "ceo", "revenue", "manufacturing", "operation", "headquarters", "employee"],
};
// Precedence order (history is routing-critical for 2.3b, so it leads).
const DOMAIN_ORDER: Exclude<Domain, "generic">[] = ["history", "finance", "ai", "startup", "business"];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// One word-boundary regex per domain (built once). Trailing `s?` tolerates plurals
// so "chip"→"chips", "gpu"→"gpus", "stock"→"stocks" all match.
const DOMAIN_REGEX = (() => {
  const m = {} as Record<Exclude<Domain, "generic">, RegExp>;
  for (const d of DOMAIN_ORDER) m[d] = new RegExp(`\\b(${DOMAIN_KEYWORDS[d].map(escapeRe).join("|")})s?\\b`, "i");
  return m;
})();
// Historical year markers (18xx/19xx only — modern 20xx is not "history").
const HISTORY_YEAR = /\b(18|19)\d{2}\b/;
/**
 * Keyword-classify a beat's text into one content domain (Patch 2.3a, diagnostic).
 * Pure + total: empty/odd input → "generic"; never throws.
 */
export function classifyDomain(text: string): Domain {
  const hay = (text || "").toLowerCase();
  if (!hay.trim()) return "generic";
  for (const d of DOMAIN_ORDER) {
    if (DOMAIN_REGEX[d].test(hay) || (d === "history" && HISTORY_YEAR.test(hay))) return d;
  }
  return "generic";
}

/**
 * Fix 1 — coarse footage_kind derived from the (locally-computed, always-present) domain,
 * used ONLY as a fallback when the planner omitted footage_kind (Gemini 503 chunk). Recovers
 * those beats into footage_kind-based routing instead of dropping them out of YT_PREFER.
 * history → archival; modern domains → contemporary; generic → undefined (keep today's behavior).
 * Pure + total; never throws.
 */
function coarseFootageKind(domain: Domain, text: string): "archival" | "contemporary" | undefined {
  switch (domain) {
    case "history":
      // WI-3 — only YEAR-confirmed history (18xx/19xx) routes to archival. Keyword-only
      // history is noisy ("NVIDIA gaming…" → history), and mislabeling a modern beat as
      // archival (when Fix 1 fires on a Gemini-plan blackout) sends it down the wrong
      // YouTube path. No year → treat as contemporary.
      return HISTORY_YEAR.test(text) ? "archival" : "contemporary";
    case "finance":
    case "ai":
    case "startup":
    case "business":
      return "contemporary";
    default:
      return undefined; // generic → leave undefined (unchanged routing)
  }
}

/** Evenly-spread `count` indices across `total` (always includes 0 if count>0). */
function spread(total: number, count: number): Set<number> {
  const picks = new Set<number>();
  if (count <= 0 || total <= 0) return picks;
  if (count >= total) {
    for (let i = 0; i < total; i++) picks.add(i);
    return picks;
  }
  const step = total / count;
  for (let i = 0; picks.size < count && i < total; i++) picks.add(Math.floor(i * step));
  return picks;
}

/**
 * Split the AI beats between generated video and stills according to a run-level ratio the
 * operator set on the create page (`aiVideoPercent`).
 *
 * `percent == null` — the ordinary case — returns immediately WITHOUT touching a single beat,
 * so every run that did not ask for a ratio (old clients, resumed runs, and every run whose
 * KIE_AI_MEDIA is not "auto") plans exactly as it did before this existed.
 *
 * The choice is pinned rather than merely written, because `resolveAiMedia` would otherwise
 * treat it as the planner's verdict and could override it. Real-footage and avatar beats are
 * excluded: the ratio governs what we GENERATE, and counting beats we don't generate would
 * quietly deliver less video the more real footage a run uses.
 */
export function applyAiVideoRatio(beats: Beat[], percent: number | null | undefined, runId: string): void {
  if (percent == null) return;
  const pct = Math.max(0, Math.min(100, percent));
  const ai = beats.filter((b) => b.layout !== "avatar" && b.source === "ai");
  if (!ai.length) return;
  const videoCount = Math.round((ai.length * pct) / 100);
  const picks = spread(ai.length, videoCount);
  for (let i = 0; i < ai.length; i++) {
    ai[i].aiMedia = picks.has(i) ? "video" : "image";
    ai[i].aiMediaPinned = true;
  }
  log(
    runId,
    "info",
    `AI media split: ${videoCount} of ${ai.length} AI beat(s) as generated video, ${ai.length - videoCount} as stills (${pct}% requested)`,
    { stage: "plan" }
  );
}

/**
 * AI-affinity of a beat from the planner's content signals: higher = better
 * suited to AI generation, lower = better suited to REAL footage. Drives the
 * content-aware assignment below. Undefined signals contribute 0 (→ neutral,
 * so a signal-less beat behaves positionally like spread()). The video term is
 * gated on NOT-entity: a motion-worthy entity ("Tesla factory robots") belongs
 * to real VIDEO (stock/YouTube), not AI video (which also trips Veo's public-
 * figure/brand safety filters), so video must not pull entities toward AI.
 */
function aiAffinity(beat: Beat): number {
  return (
    (beat.queryType === "abstract" ? 2 : 0) +
    (beat.queryType === "entity" ? -2 : 0) +
    (beat.queryType === "generic" ? -0.5 : 0) +
    (beat.aiMedia === "video" && beat.queryType !== "entity" ? 1.5 : 0)
  );
}

/**
 * Content-aware replacement for spread(): picks exactly `realCount` REAL ordinals
 * (indices into the visual-beat array), preserving spread()'s count and even
 * spacing, but choosing WITHIN each window the beat least suited to AI (lowest
 * score) as real — so abstract/video beats land in the AI subset and AI video
 * actually fires. Score = affinity + 0.25·distanceFromAnchor + 0.5·adjacency.
 * Degrades to spread() when signals are absent (all affinities 0 → anchor wins).
 */
function contentAwareReal(visual: Beat[], realCount: number): Set<number> {
  const picks = new Set<number>();
  const total = visual.length;
  if (realCount <= 0 || total <= 0) return picks;
  if (realCount >= total) {
    for (let i = 0; i < total; i++) picks.add(i);
    return picks;
  }
  const step = total / realCount;
  let lastReal = -2; // so ordinal 0 is never falsely "adjacent" to a previous real
  for (let i = 0; i < realCount; i++) {
    const anchor = Math.floor(i * step);
    // Defensive guard (belt-and-suspenders): window is always non-empty and in
    // bounds even under future refactors / unexpected state. No-op for valid inputs.
    const windowEnd = Math.min(total, Math.max(anchor + 1, Math.floor((i + 1) * step)));
    let bestPos = anchor;
    let bestScore = Infinity;
    for (let pos = anchor; pos < windowEnd; pos++) {
      const score =
        aiAffinity(visual[pos]) +
        0.25 * Math.abs(pos - anchor) +
        0.5 * (pos === lastReal + 1 ? 1 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }
    picks.add(bestPos);
    lastReal = bestPos;
  }
  return picks;
}

export async function planBeats(
  words: WordTiming[],
  opts: {
    secondsPerVisual: number;
    avatarPercent: number;
    realPercent: number;
    hasAvatar: boolean;
    runId: string;
    /** Channel's editable visual/"split" guidance; default used when empty. */
    visualPrompt?: string;
    /** Informational Overlays (Stage 1). false/undefined → the planner request and
     * every beat are byte-identical to before this feature (no overlay field asked
     * for, none attached). true → the planner may emit a card per beat. */
    overlays?: boolean;
    /** Run title (Stage 2) — the strongest signal for detecting a structured/list video
     * ("Top 10 …", "5 Facts …"). Only read when overlays are enabled. */
    title?: string;
    /** Provenance hook — invoked once with the resolved structure (when one is detected) so the
     * caller can persist a run-level snapshot. Optional; nothing downstream depends on it. */
    onStructure?: (s: VideoStructure) => void;
    /** Share of the AI beats to render as generated video rather than stills, 0–100.
     * Only sent when the operator picked AI media = "auto"; undefined/null → the planner's
     * own per-beat verdict decides, exactly as before. */
    aiVideoPercent?: number | null;
  }
): Promise<Beat[]> {
  const minSec = Math.max(1.5, Number(getSetting("BEAT_MIN_SEC") || "3"));
  const maxSec = Math.max(minSec + 1, Number(getSetting("BEAT_MAX_SEC") || "10"));
  let base = buildBeats(words, opts.secondsPerVisual, minSec, maxSec);
  if (base.length === 0) return [];

  // Stage 2 — is this a structured/list video? Detect ONCE, only when overlays are enabled (keeps the
  // OFF path untouched). Two evidence paths inside the one canonical detector: title/lead phrasing
  // first, then the spoken "Number five/four/three" cues (full word stream) if phrasing found nothing.
  // A hit steers the planner to mark item boundaries; numbering is applied deterministically after.
  const detected = opts.overlays === true
    ? detectVideoStructure(
        `${opts.title ?? ""} ${words.slice(0, 120).map((w) => w.word).join(" ")}`,
        words,
        (msg) => log(opts.runId, "debug", msg, { stage: "plan" })
      )
    : null;
  // Reconcile direction/total against the SPOKEN cues before anything reads them. A "10 secrets"
  // title is detected direction:"up", but a descending "Number 10 … 1" narration must orient the
  // intro region + item cuts from the top rank — otherwise the "Number 10" card is dropped as intro.
  // No-op when they already agree or there is no coherent spoken run (byte-identical).
  const structure = detected ? reconcileStructureFromCues(detected, words) : null;
  if (structure) {
    if (detected && (detected.direction !== structure.direction || detected.total !== structure.total)) {
      log(opts.runId, "info", `structure reconciled from spoken cues: direction ${detected.direction}→${structure.direction}${detected.total !== structure.total ? ` total ${detected.total ?? "?"}→${structure.total ?? "?"}` : ""}`, { stage: "plan" });
    }
    log(opts.runId, "info", `structure=${structure.kind} source=${structure.source ?? "title"}${structure.total ? ` total=${structure.total}` : ""} direction=${structure.direction} — ranking/chapter overlays enabled`, { stage: "plan" });
    opts.onStructure?.(structure);
  }

  // Beat-boundary sync (Issue 2) — ADDITIVE post-processing on the frozen buildBeats() output: split
  // ONLY the beats that straddle an ItemAnnouncement so each item's visual cut lands on the spoken
  // cue ("Number three" → the Colosseum beat starts there, not at the next length boundary). Runs
  // before avatar/role/query assignment so the new item beat gets its OWN query and role. All other
  // beats pass through unchanged; OFF / unstructured runs skip it entirely (byte-identical beats).
  if (structure) {
    const before = base.length;
    base = splitBeatsAtAnnouncements(base, words, structure);
    if (base.length !== before) {
      log(opts.runId, "info", `Announcement-aligned split: ${before} → ${base.length} beats (item cuts pinned to spoken cues)`, { stage: "plan" });
    }
    // Post-split: a section-leading beat shorter than BEAT_MIN_SEC (a marker landing near a buildBeats
    // boundary) would flash under its establishing card while the next visual is already up. Merge it
    // forward into the next beat of the SAME section. Long sections keep their extra visuals — only the
    // short lead is absorbed. Runs before avatar/query/overlay assignment so the merged beat is what the
    // model marks and numbers, and the card lands on a full-length visual.
    const beforeMerge = base.length;
    base = mergeShortSectionLeads(base, announcementCutMs(words, structure), minSec * 1000);
    if (base.length !== beforeMerge) {
      log(opts.runId, "info", `Merged ${beforeMerge - base.length} short section-leading beat(s) forward (< ${minSec}s) so each establishing card sits on a full-length visual`, { stage: "plan" });
    }
  }

  // 1. Choose avatar beats (only if an avatar is selected for this run).
  // The hook (beat 0, full-screen) is free — it does not consume the percent —
  // so the avatar keeps reappearing THROUGHOUT the video, not just at the start:
  // extra avatar beats are spread evenly over the rest of the timeline and
  // alternate split-screen → full-screen → split-screen…
  const avatarSet = new Set<number>();
  const fullSet = new Set<number>([0]);
  if (opts.hasAvatar && opts.avatarPercent > 0) {
    avatarSet.add(0);
    const extra = Math.round((base.length * Math.min(100, opts.avatarPercent)) / 100);
    if (extra > 0 && base.length > 1) {
      const step = (base.length - 1) / extra;
      let ordinal = 0;
      for (let i = 1; i <= extra; i++) {
        const idx = Math.min(base.length - 1, Math.max(1, Math.round((i - 0.5) * step)));
        if (avatarSet.has(idx)) continue;
        avatarSet.add(idx);
        ordinal++;
        if (ordinal % 2 === 0) fullSet.add(idx); // every 2nd reappearance is full-screen
      }
    }
  }

  // 2. Visual queries from Gemini for the non-avatar (and split) beats, with the
  // opening of the script as shared context so per-beat choices stay coherent.
  const scriptContext = words.slice(0, 60).map((w) => w.word).join(" ");

  // Visual Stage 1 — classify beats on the Item Timeline (intro vs item) so the planner requests
  // establishing footage for the intro and the object for items. Empty (no-op) for non-list videos.
  const visualRoles = assignVisualRoles(base, words, structure);

  // Full-screen avatar beats need no visual; broll + split beats do.
  const visualBeats = base.filter((b) => !(avatarSet.has(b.index) && fullSet.has(b.index)));
  const queries = await planVisualQueries(
    visualBeats.map((b) => ({ index: b.index, text: b.text, role: visualRoles.get(b.index) })),
    opts.runId,
    opts.visualPrompt,
    scriptContext,
    opts.overlays === true,
    structure ? structurePromptHint(structure) : ""
  );

  // 3. Assemble beats with layout.
  const trimQuery = getSetting("PLAN_QUERY_TRIM") === "1"; // WI-13
  const beats: Beat[] = base.map((b) => {
    let layout: BeatLayout = "broll";
    if (avatarSet.has(b.index)) layout = fullSet.has(b.index) ? "avatar" : "split";
    const planned = queries.get(b.index);
    const rawQuery = layout === "avatar" ? "" : planned?.query || keywordsFrom(b.text);
    // WI-13 — strip non-depictable abstract tails (e.g. "scaling energy output") so footage
    // search stays on-subject. Fail-safe inside shapeFootageQuery; AI prompt left untouched.
    const visualQuery = rawQuery && trimQuery ? shapeFootageQuery(rawQuery) : rawQuery;
    if (visualQuery !== rawQuery) log(opts.runId, "debug", `Beat ${b.index}: query-trim "${rawQuery}" → "${visualQuery}"`, { stage: "plan" });
    // Patch 2.3a — diagnostic domain from visualQuery + narration ONLY (no aiPrompt).
    const domain = classifyDomain(`${visualQuery} ${b.text}`);
    return { ...b, layout, visualQuery, youtubeQuery: planned?.youtubeQuery, aiPrompt: planned?.aiPrompt, productLabel: planned?.productLabel, aiMedia: planned?.aiMedia, queryType: planned?.queryType, source: "ai", domain, footageKind: planned?.footageKind ?? coarseFootageKind(domain, `${visualQuery} ${b.text}`), overlay: planned?.overlay };
  });

  // 4. Assign real vs AI across the visual beats (broll + split). SMART_ASSIGN=1
  // routes by planner content signals (abstract/video → AI, entity/generic → real)
  // while preserving the same realCount and pacing; default 0 = positional spread().
  const visual = beats.filter((b) => b.layout !== "avatar");
  const realCount = Math.round((visual.length * Math.max(0, Math.min(100, opts.realPercent))) / 100);
  const smart = getSetting("SMART_ASSIGN") === "1";
  const realOrdinals = smart
    ? contentAwareReal(visual, realCount)
    : spread(visual.length, realCount);
  let ordinal = 0;
  for (const b of beats) {
    if (b.layout === "avatar") continue;
    b.source = realOrdinals.has(ordinal) ? "real" : "ai";
    if (smart) {
      log(opts.runId, "debug", `Beat ${b.index}: source=${b.source} (SMART_ASSIGN ordinal=${ordinal}, queryType=${b.queryType ?? "—"}, affinity=${aiAffinity(b)})`, { stage: "plan" });
    } else if (b.source === "ai") {
      log(opts.runId, "debug", `Beat ${b.index}: source=ai (planner ratio assignment, ordinal=${ordinal}, realPercent=${opts.realPercent})`, { stage: "plan" });
    }
    // Patch 2.3a/2.4a — diagnostic: log the classified domain + planner footage_kind per visual beat.
    log(opts.runId, "debug", `Beat ${b.index}: domain=${b.domain ?? "generic"} footage_kind=${b.footageKind ?? "—"} (query="${b.visualQuery}")`, { stage: "plan" });
    ordinal++;
  }

  // Split the AI beats between generated video and stills, if the operator set a ratio.
  // AFTER the source loop because it can only run once `source` is final — that loop is
  // what decides which beats are "ai" at all, and they are the denominator.
  applyAiVideoRatio(beats, opts.aiVideoPercent, opts.runId);

  // Topic Pool Retrieval (P0) — attach a canonical topicKey to each REAL visual beat so
  // retrieval can reuse ONE provider search across beats that share it. This is observability
  // only at plan time; the grouping is consumed by acquireReal only when TOPIC_POOL=1. AI/
  // avatar beats and beats whose query yields no meaningful tokens stay ungrouped (singletons).
  const topicMembers = new Map<string, number[]>();
  for (const b of beats) {
    if (b.layout === "avatar" || b.source !== "real") continue;
    const key = topicKeyFor(b.visualQuery, b.footageKind);
    if (!key) continue;
    b.topicKey = key;
    const arr = topicMembers.get(key) ?? [];
    arr.push(b.index);
    topicMembers.set(key, arr);
  }
  const realVisual = beats.filter((b) => b.layout !== "avatar" && b.source === "real").length;
  const keyedBeats = [...topicMembers.values()].reduce((s, m) => s + m.length, 0);
  const shared = [...topicMembers.values()].filter((m) => m.length > 1);
  // Effective attempt-0 searches = distinct topics + real beats that got no key (each a singleton).
  const effectiveSearches = topicMembers.size + (realVisual - keyedBeats);
  const reductionPct = realVisual > 0 ? Math.round(((realVisual - effectiveSearches) / realVisual) * 100) : 0;
  log(
    opts.runId,
    "info",
    `Topic pool: ${topicMembers.size} keyed topics over ${realVisual} real beats · ${shared.length} shared (${shared.reduce((s, m) => s + m.length, 0)} beats) · est. attempt-0 search reduction ≈ ${reductionPct}%`,
    { stage: "plan" }
  );
  for (const m of shared) log(opts.runId, "debug", `Topic shared by beats [${m.join(", ")}]`, { stage: "plan" });

  const c = { avatar: 0, split: 0, broll: 0 };
  for (const b of beats) c[b.layout]++;
  const realN = beats.filter((b) => b.layout !== "avatar" && b.source === "real").length;
  const aiN = beats.filter((b) => b.layout !== "avatar" && b.source === "ai").length;
  // Patch 2.3a — diagnostic domain histogram over visual beats (observability only).
  const dom: Record<Domain, number> = { history: 0, finance: 0, ai: 0, startup: 0, business: 0, generic: 0 };
  for (const b of beats) if (b.layout !== "avatar") dom[b.domain ?? "generic"]++;
  log(
    opts.runId,
    "success",
    `Plan: ${beats.length} beats · avatar=${c.avatar} split=${c.split} broll=${c.broll} · real=${realN} ai=${aiN}` +
      ` · domains: history=${dom.history} finance=${dom.finance} ai=${dom.ai} startup=${dom.startup} business=${dom.business} generic=${dom.generic}`,
    { stage: "plan" }
  );

  // Stage 2 — deterministic ranking/chapter numbering, done as ONE pass that also owns the intro
  // guard (see numberStructuredOverlays): the model marked the item-start beats (as `section`
  // overlays with the item topic); here we drop intro marks and assign the numbers IN ORDER,
  // globally consistent across planning chunks and independent of beat durations. This MUST run
  // before Stage 2.1 so scheduleOverlays() times the FINAL, numbered overlays. Fail-open: numbering
  // must never break a plan.
  let rankByIndex: Map<number, number> | undefined;
  if (structure) {
    try {
      rankByIndex = numberStructuredOverlays(beats, structure, words);
      log(opts.runId, "info", `Applied ${structure.kind} numbering to ${rankByIndex.size} item(s); establishing card = heading (primary) + rank label (secondary), rank from the spoken cue`, { stage: "plan" });
    } catch (e) {
      log(opts.runId, "warn", `Structure numbering skipped (${(e as Error).message.slice(0, 80)}) — overlays kept as planned`, { stage: "plan" });
    }
  }

  // Stage 2.1 — schedule overlay timing from the narration word timings, AFTER the numbering pass
  // above (ranking cards sync to the spoken cue; every card's lifetime is a reading-time hold, not
  // the visual duration). Runs whenever overlays are enabled (generic cards need timing too); the
  // transient rank map lets it bind ranking cards to spoken announcements without parsing the card
  // text. Fail-open (a gap leaves the assembler's beat-window fallback).
  if (opts.overlays === true) {
    try {
      scheduleOverlays(beats, words, (msg) => log(opts.runId, "debug", msg, { stage: "plan" }), rankByIndex, structure?.kind === "sequence");
    } catch (e) {
      log(opts.runId, "warn", `Overlay scheduling skipped (${(e as Error).message.slice(0, 80)}) — overlays fall back to beat timing`, { stage: "plan" });
    }

    // The operator ASKED for cards and the plan has none — say so here, where the cause is still
    // known, instead of leaving it to the assembler's one line 10 minutes later. Card text comes
    // only from Gemini, so an exhausted key guarantees this outcome; naming that is the difference
    // between "the feature is broken" and "your key is out of quota". Reporting only.
    if (!beats.some((b) => b.overlay)) {
      log(
        opts.runId,
        "warn",
        geminiQuotaHit(opts.runId)
          ? "Text cards were requested but NONE could be written: Gemini is out of quota (see the error above). The video will have no overlays — fix the GOOGLE_API_KEY quota and re-run."
          : "Text cards were requested but the planner marked no beat as card-worthy — the video will have no overlays.",
        { stage: "plan" }
      );
    }
  }

  return beats;
}

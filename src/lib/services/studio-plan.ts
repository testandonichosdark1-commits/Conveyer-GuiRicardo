import { getSetting } from "../settings";
import { log } from "../logger";
import type { WordTiming } from "./elevenlabs-voiceover";
import { recordGemini } from "./cost-ledger";
import { callGemini } from "./gemini-models";

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
  /** Planner's per-beat AI media verdict (Patch 2 producer). Undefined → the
   * resolver in visual-source falls back to keyword heuristic, then global mode. */
  aiMedia?: "image" | "video";
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

interface GeminiQuery {
  index: number;
  visual_query?: string;
  youtube_query?: string;
  ai_prompt?: string;
  ai_media?: string;
  query_type?: string;
  footage_kind?: string;
}

export interface PlannedVisual {
  /** Short concrete stock-search query (3–9 words). */
  query: string;
  /** Short title-like YouTube search query (#1), 2–6 high-signal keywords. Undefined when absent/invalid. */
  youtubeQuery?: string;
  /** Rich 30–60 word generation prompt for AI beats (nano-banana / Veo). */
  aiPrompt?: string;
  /** Planner's per-beat AI media verdict. Undefined when absent/invalid. */
  aiMedia?: "image" | "video";
  /** Planner's per-beat source-routing class (Patch 1: diagnostics only — NOT
   * yet consumed by any routing logic). Undefined when absent/invalid. */
  queryType?: "entity" | "generic" | "abstract";
  /** Planner's per-beat footage-intent (Patch 2.4a). Undefined when absent/invalid. */
  footageKind?: "archival" | "contemporary" | "conceptual";
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
function buildPlanPrompt(
  chunk: { index: number; text: string }[],
  guidance: string | undefined,
  scriptContext: string | undefined,
  carryOver: string
): string {
  const numbered = chunk.map((b) => `[${b.index}] ${b.text}`).join("\n");
  return (
    `${(guidance && guidance.trim()) || DEFAULT_VISUAL_GUIDANCE}\n\n` +
    (scriptContext ? `Overall video context (use it to keep visuals coherent): "${scriptContext}"\n\n` : "") +
    (carryOver ? `Context from previous chunk:\nLast concrete subject: ${carryOver}\n\n` : "") +
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
    `Good: "Tide detergent bottle". Good: "Arm & Hammer washing soda yellow box".\n` +
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
    `even if the sentence is metaphorical (translate metaphors into a literal real-world object/scene). NO on-screen text.\n` +
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
    `Return STRICTLY a JSON array, one object per line IN ORDER: {"index": <int>, "visual_query": "<string>", "youtube_query": "<string>", "ai_prompt": "<string>", "ai_media": "<image|video>", "query_type": "<entity|generic|abstract>", "footage_kind": "<archival|contemporary|conceptual>"}. No markdown.`
  );
}

/**
 * One Gemini planning request for a single chunk. Delegates all model
 * selection / retry / failover to the shared {@link callGemini} helper (each
 * live model tried once, 45s timeout, transient → back off + fail over,
 * permanent 404/4xx → skip). Returns the parsed rows, or null if every live
 * model failed — the caller then leaves those beats to the keyword fallback.
 */
async function requestPlanChunk(prompt: string, runId: string, apiKey: string, model: string): Promise<GeminiQuery[] | null> {
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 20000, thinkingConfig: { thinkingBudget: 0 } },
  });
  try {
    const { json: j, model: usedModel } = await callGemini({
      apiKey,
      model,
      body,
      timeoutMs: 45_000, // a hung Gemini request once stalled planning for minutes
      onFailure: ({ attempt, maxAttempts, model: m, nextModel, reason, kind }) => {
        log(runId, "warn",
          `Gemini attempt ${attempt}/${maxAttempts} — model ${m}: ${reason.slice(0, 80)}. ${kind === "permanent" ? "Permanent error, skipping model." : "Transient error."}` +
          (nextModel ? ` ${kind === "permanent" ? "Trying" : "Retrying with"} ${nextModel}.` : ""),
          { stage: "plan" });
      },
    });
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    // Cost Monitoring — planner is a Gemini text call; meter real token usage.
    recordGemini(runId, "geminiText", j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0, usedModel);
    return JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text) as GeminiQuery[];
  } catch (e) {
    log(runId, "warn", `Gemini planner unavailable (${(e as Error).message.slice(0, 120)}) — falling back to keyword planner for those beats`, { stage: "plan" });
    return null;
  }
}

/** Ask Gemini for a concrete visual search query (+ AI prompt) per beat. Best-effort. */
async function planVisualQueries(
  beats: { index: number; text: string }[],
  runId: string,
  guidance?: string,
  scriptContext?: string
): Promise<Map<number, PlannedVisual>> {
  const out = new Map<number, PlannedVisual>();
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) {
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
    const prompt = buildPlanPrompt(chunk, guidance, scriptContext, carryOver);
    const arr = await requestPlanChunk(prompt, runId, apiKey, model);
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
          out.set(q.index, { query: q.visual_query.trim(), youtubeQuery, aiPrompt: q.ai_prompt?.trim() || undefined, aiMedia, queryType, footageKind });
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
  }
): Promise<Beat[]> {
  const minSec = Math.max(1.5, Number(getSetting("BEAT_MIN_SEC") || "3"));
  const maxSec = Math.max(minSec + 1, Number(getSetting("BEAT_MAX_SEC") || "10"));
  const base = buildBeats(words, opts.secondsPerVisual, minSec, maxSec);
  if (base.length === 0) return [];

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
  // Full-screen avatar beats need no visual; broll + split beats do.
  const visualBeats = base.filter((b) => !(avatarSet.has(b.index) && fullSet.has(b.index)));
  const queries = await planVisualQueries(
    visualBeats.map((b) => ({ index: b.index, text: b.text })),
    opts.runId,
    opts.visualPrompt,
    scriptContext
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
    return { ...b, layout, visualQuery, youtubeQuery: planned?.youtubeQuery, aiPrompt: planned?.aiPrompt, aiMedia: planned?.aiMedia, queryType: planned?.queryType, source: "ai", domain, footageKind: planned?.footageKind ?? coarseFootageKind(domain, `${visualQuery} ${b.text}`) };
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
  return beats;
}

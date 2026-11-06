import { getSetting } from "../settings";
import { log } from "../logger";
import { recordGemini } from "./cost-ledger";
import { callGemini, type GeminiGenerateContentResponse } from "./gemini-models";
import { noteGeminiQuota } from "./gemini-quota";
import { isGraphicTemplateKey, validateGraphicData, type GraphicTemplateKey } from "./graphic-templates";
import type { Beat } from "./studio-plan";

/**
 * Graphic beats — the planner pass (docs/SPEC-motion-graphics.md 3.4).
 *
 * Runs AFTER the ordinary plan is complete, and only when the run asked for graphics, so a
 * run without them never reaches this file and plans byte-identically. It asks Gemini which
 * beats should become a full-screen motion graphic, with which template and which data, then
 * applies that deterministically:
 *
 *  - every pick is validated by the template's zod schema; an invalid one is DROPPED (the
 *    beat stays ordinary b-roll — fail-open, like the rest of the planner);
 *  - a pick may absorb the following beats (`through`) up to GRAPHIC_MAX_SEC — or
 *    GRAPHIC_LIST_MAX_SEC for the templates that build up a list — always on beat
 *    boundaries, which are sentence-aware already;
 *  - the same template never runs twice in a row;
 *  - graphic screen time is capped at percent + 10 points.
 *
 * A graphic beat KEEPS the b-roll fields of its first beat (visualQuery, aiPrompt, source…).
 * That is the fallback: when its render fails the pipeline flips it back to "broll" and it
 * goes down the ordinary visual path with the same words, no second planner call.
 */

export interface GraphicSpec {
  template: GraphicTemplateKey;
  data: Record<string, unknown>;
  theme?: string;
}

export interface GraphicPick {
  index: number;
  through: number;
  template: GraphicTemplateKey;
  data: Record<string, unknown>;
}

/** Templates that build a list over time and may hold the screen longer (spec 3.4). */
export const LIST_TEMPLATES: ReadonlySet<GraphicTemplateKey> = new Set(["spec_callouts", "checklist_card", "timeline", "polaroids", "versus"]);

const CHUNK = 40;

/** Per-template guidance for the planner — field shapes mirror graphic-templates.ts. */
const CATALOG = `
product_hero — a named product being introduced. {"image":"product:<exact product name>","title":"<=6 words","overline":"year or category, optional","subtitle":"short italic line, optional","reveal":true|false,"revealCue":"word","chip":"short note, optional","stamp":"optional red stamp text","bg":"dark"|"parchment"}
spec_callouts — the narration lists ATTRIBUTES of one named product. {"image":"product:<name>","name":"<=4 words","price":"optional","sub":"optional","specs":[{"label":"<=5 words","sub":"optional","anchor":{"x":0..1,"y":0..1},"cueWord":"word said when it appears"}] (1-5),"stamp":"optional","bg":"dark"}
kinetic_quote — a short, self-contained punchline. {"text":"<=12 words, copied","highlight":["1-3 key words from text"],"style":"outline-fill"|"typewriter","label":"optional 2-3 word mono label","bg":"parchment"|"dark"}
impact_bars — a punchline in 2-4 short lines; "X became Y" uses strike on the first line. {"lines":[{"text":"<=4 words","gold":true|false,"strike":true|false,"plain":true|false,"cueWord":"optional"}],"label":"optional","bg":"dark"}
counter — a striking number, amount or quantity. {"value":<integer>,"prefix":"$ optional","suffix":"unit, optional","caption":"short line","overline":"optional","kicker":"optional","image":"product:<name> optional","bg":"dark"|"parchment"}
timeline — dates/years in sequence. {"title":"optional mono label","events":[{"year":<integer>,"label":"<=4 words","sub":"optional"}] (2-6),"focus":<index of the year being talked about>,"bg":"dark"}
versus — an explicit comparison of two things. {"title":"A vs B","left":{"name":"","sub":"","image":"product:<name> optional","bullets":["<=6 words"],"bad":false},"right":{...},"winner":"left"|"right" optional,"ribbon":"optional","ribbonCue":"word","bg":"dark"}
checklist_card — a list of changes, a warranty, a verdict. {"title":"<=4 words","subtitle":"optional","overline":"optional","items":[{"text":"<=5 words","note":"optional","state":"check"|"cross"|"empty","cueWord":"word"}] (1-6),"stamp":"optional","image":"product:<name> optional"}
polaroids — people/objects of a personal story. {"label":"optional","photos":[{"image":"product:<object name>","caption":"<=5 words","cueWord":"word"}] (1-5),"bg":"wood-light"|"wood-dark"}`;

export function buildGraphicPrompt(
  chunk: { index: number; text: string; durSec: number }[],
  percent: number,
  maxSec: number,
  listMaxSec: number,
  prevTemplate: string,
): string {
  const lines = chunk.map((b) => `[${b.index}] (${b.durSec.toFixed(1)}s) ${b.text}`).join("\n");
  return `You are the graphics editor of a documentary YouTube video in the style of "Whatever Happened to Maglite?" (Arden EDC). About ${percent}% of SCREEN TIME should be full-screen custom motion graphics; the rest is filmed b-roll.

Below are the narration beats (index, duration, text). Pick the beats that should become a graphic, choose a template, and fill its data.

RULES
- A short, self-contained punchline ("Something that good gets copied.") → kinetic_quote or impact_bars.
- A striking number, amount or year → counter or timeline.
- A NAMED product being introduced → product_hero. If the narration lists its attributes → spec_callouts.
- An explicit comparison of two things → versus.
- A list of changes, a warranty or a verdict → checklist_card.
- People/objects of a personal story ("a guy I know… a Buck 110 and a Mini Mag") → polaroids.
- Physical action, places, memories, a person doing something → leave it as b-roll (do NOT list that beat).
- Never the same template in two consecutive graphics. The previous chunk ended with: ${prevTemplate || "none"}.
- On-screen text is short and COPIED from the narration: titles <= 6 words, punchlines <= 12 words. Never invent facts, numbers or names.
- Images: only "product:<exact name of a real physical product or object>" — never a person, place or abstract idea. Leave optional images out when unsure.
- "cueWord" must be one word that literally appears in that beat's narration.
- A graphic may continue over the next beats on the same subject: set "through" to the last beat index it covers (same as "index" for one beat). Max ${maxSec}s total; spec_callouts, checklist_card, timeline, polaroids and versus may go to ${listMaxSec}s.

TEMPLATES (data shapes)
${CATALOG}

Return ONLY a JSON array, possibly empty: [{"index":<beat>,"through":<beat>,"template":"<name>","data":{...}}]

BEATS
${lines}`;
}

/** Parse the model's array; anything that is not a well-formed pick is skipped. */
export function parseGraphicPicks(text: string): GraphicPick[] | null {
  let raw: unknown;
  try {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: GraphicPick[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const index = Number(o.index);
    const through = o.through == null ? index : Number(o.through);
    if (!Number.isInteger(index) || !Number.isInteger(through) || through < index) continue;
    if (!isGraphicTemplateKey(o.template) || !o.data || typeof o.data !== "object") continue;
    out.push({ index, through, template: o.template, data: o.data as Record<string, unknown> });
  }
  return out;
}

type Logger = (level: "info" | "warn" | "debug", msg: string) => void;

/**
 * Deterministic half: validate, clamp merges, forbid repeats, cap the share, then rebuild
 * the beat list (merged + reindexed). Pure — exported for tests.
 */
export function applyGraphicPicks(
  beats: Beat[],
  picks: GraphicPick[],
  opts: { percent: number; maxSec: number; listMaxSec: number; theme?: string },
  logf: Logger = () => {},
): Beat[] {
  const total = beats.length ? beats[beats.length - 1].endMs - beats[0].startMs : 0;
  const kept: GraphicPick[] = [];
  let lastEnd = -1;
  for (const p of [...picks].sort((a, b) => a.index - b.index)) {
    if (p.index <= lastEnd || p.index < 0 || p.index >= beats.length) continue;
    if (beats[p.index].layout === "avatar" || beats[p.index].layout === "split") continue;
    const v = validateGraphicData(p.template, p.data);
    if (!v.ok) {
      logf("debug", `Beat ${p.index}: graphic ${p.template} rejected by its schema (${v.error.slice(0, 160)}) — stays b-roll`);
      continue;
    }
    // Clamp the merge to the duration limit and to beats that are free to merge.
    const limitMs = (LIST_TEMPLATES.has(p.template) ? opts.listMaxSec : opts.maxSec) * 1000;
    let through = p.index;
    for (let j = p.index + 1; j <= Math.min(p.through, beats.length - 1); j++) {
      if (beats[j].layout === "avatar" || beats[j].layout === "split") break;
      if (beats[j].endMs - beats[p.index].startMs > limitMs) break;
      through = j;
    }
    const prev = kept[kept.length - 1];
    if (prev && prev.through === p.index - 1 && prev.template === p.template) {
      logf("debug", `Beat ${p.index}: ${p.template} would repeat the previous graphic — stays b-roll`);
      continue;
    }
    kept.push({ ...p, through, data: v.data });
    lastEnd = through;
  }

  // Cap: graphic time may exceed the target by 10 points at most. Drop from the densest
  // stretch first (a pick touching another graphic), shortest first.
  const capMs = (Math.min(100, opts.percent + 10) / 100) * total;
  const dur = (p: GraphicPick) => beats[p.through].endMs - beats[p.index].startMs;
  let used = kept.reduce((a, p) => a + dur(p), 0);
  while (kept.length && used > capMs) {
    const touching = (i: number) =>
      (i > 0 && kept[i - 1].through === kept[i].index - 1) || (i + 1 < kept.length && kept[i + 1].index === kept[i].through + 1);
    let victim = -1;
    for (let i = 0; i < kept.length; i++) {
      if (!touching(i)) continue;
      if (victim < 0 || dur(kept[i]) < dur(kept[victim])) victim = i;
    }
    if (victim < 0) for (let i = 0; i < kept.length; i++) if (victim < 0 || dur(kept[i]) < dur(kept[victim])) victim = i;
    used -= dur(kept[victim]);
    kept.splice(victim, 1);
  }

  const byStart = new Map(kept.map((p) => [p.index, p]));
  const out: Beat[] = [];
  for (let i = 0; i < beats.length; i++) {
    const p = byStart.get(i);
    if (!p) {
      out.push({ ...beats[i] });
      continue;
    }
    const first = beats[i];
    const graphic: GraphicSpec = { template: p.template, data: p.data, ...(opts.theme ? { theme: opts.theme } : {}) };
    const merged: Beat = {
      ...first,
      endMs: beats[p.through].endMs,
      text: beats.slice(i, p.through + 1).map((b) => b.text).join(" "),
      layout: "graphic",
      graphic,
    };
    // A graphic replaces the screen: no lower-third card on top of it.
    delete merged.overlay; delete merged.overlayStartMs; delete merged.overlayEndMs;
    delete merged.supporting; delete merged.supportingStartMs; delete merged.supportingEndMs;
    out.push(merged);
    i = p.through;
  }
  out.forEach((b, i) => { b.index = i; });
  return out;
}

function responseText(json: GeminiGenerateContentResponse): string {
  return (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => (p as { thought?: boolean }).thought !== true)
    .map((p) => p.text ?? "")
    .join("");
}

/** Model half: one Gemini call per chunk of beats. Returns [] when there is no key/answer. */
async function requestGraphicPicks(beats: Beat[], runId: string, percent: number, maxSec: number, listMaxSec: number): Promise<GraphicPick[]> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) {
    log(runId, "warn", "Graphic beats requested but GOOGLE_API_KEY is not set — the video will have no graphics", { stage: "plan" });
    return [];
  }
  const model = getSetting("SCENE_SPLIT_MODEL");
  const all: GraphicPick[] = [];
  let prevTemplate = "";
  for (let start = 0; start < beats.length; start += CHUNK) {
    const chunk = beats.slice(start, start + CHUNK)
      .filter((b) => b.layout !== "avatar" && b.layout !== "split")
      .map((b) => ({ index: b.index, text: b.text, durSec: (b.endMs - b.startMs) / 1000 }));
    if (!chunk.length) continue;
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildGraphicPrompt(chunk, percent, maxSec, listMaxSec, prevTemplate) }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 20000, thinkingConfig: { thinkingBudget: 0 } },
    });
    try {
      const { json } = await callGemini({
        apiKey, model, body, timeoutMs: 60_000,
        validate: (j, usedModel) => {
          // metered on every billed attempt, as in requestPlanChunk
          recordGemini(runId, "geminiText", j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0, usedModel);
          if (!parseGraphicPicks(responseText(j))) throw new Error("unparseable graphic plan JSON");
        },
        onFailure: ({ attempt, maxAttempts, model: m, reason }) =>
          log(runId, "warn", `Graphic planner attempt ${attempt}/${maxAttempts} — model ${m}: ${reason.slice(0, 80)}`, { stage: "plan" }),
      });
      const picks = (parseGraphicPicks(responseText(json)) ?? []).filter((p) => p.index >= start && p.index < start + CHUNK);
      all.push(...picks);
      const last = [...picks].sort((a, b) => a.through - b.through).pop();
      prevTemplate = last && last.through >= start + CHUNK - 2 ? last.template : "";
    } catch (e) {
      const msg = (e as Error).message;
      noteGeminiQuota(runId, msg);
      log(runId, "warn", `Graphic planner unavailable for beats ${start}–${start + chunk.length - 1} (${msg.slice(0, 120)}) — they stay b-roll`, { stage: "plan" });
    }
  }
  return all;
}

export function graphicLimits(): { maxSec: number; listMaxSec: number } {
  const maxSec = Math.max(4, Number(getSetting("GRAPHIC_MAX_SEC") || "20") || 20);
  const listMaxSec = Math.max(maxSec, Number(getSetting("GRAPHIC_LIST_MAX_SEC") || "45") || 45);
  return { maxSec, listMaxSec };
}

/** The whole pass: ask, apply, report. Never throws — a failure leaves the plan as it was. */
export async function planGraphicBeats(beats: Beat[], runId: string, opts: { percent: number; theme?: string }): Promise<Beat[]> {
  try {
    const { maxSec, listMaxSec } = graphicLimits();
    const picks = await requestGraphicPicks(beats, runId, opts.percent, maxSec, listMaxSec);
    const out = applyGraphicPicks(beats, picks, { percent: opts.percent, maxSec, listMaxSec, theme: opts.theme },
      (level, msg) => log(runId, level, msg, { stage: "plan" }));
    const total = out.length ? out[out.length - 1].endMs - out[0].startMs : 0;
    const g = out.filter((b) => b.layout === "graphic");
    const gMs = g.reduce((a, b) => a + (b.endMs - b.startMs), 0);
    const byT = new Map<string, number>();
    for (const b of g) byT.set(b.graphic!.template, (byT.get(b.graphic!.template) ?? 0) + 1);
    log(runId, "success",
      `Graphic beats: ${g.length} of ${out.length} beats · ${total ? Math.round((gMs / total) * 100) : 0}% of screen time (target ${opts.percent}%) · ` +
      (g.length ? [...byT].map(([t, n]) => `${t}=${n}`).join(" ") : "none") +
      ` · ${picks.length} proposed, ${picks.length - g.length} dropped`,
      { stage: "plan" });
    return out;
  } catch (e) {
    log(runId, "warn", `Graphic planning skipped (${(e as Error).message.slice(0, 120)}) — plan unchanged`, { stage: "plan" });
    return beats;
  }
}

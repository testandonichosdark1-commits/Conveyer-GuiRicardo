import fs from "node:fs";
import { z } from "zod";
import type { Beat } from "./studio-plan";

/**
 * Scene Plan v1 — a versioned, validated PROJECTION of the planned beats.
 *
 * OBSERVATIONAL ONLY. The studio pipeline writes it next to beats.json right after
 * tiling, and nothing reads it: beats.json stays the single source of truth for
 * rendering and Resume. It exists so the scene-based architecture can be introduced
 * behind it later without first changing what the current pipeline consumes.
 *
 * Rules this module keeps:
 *  - Every field is COPIED from a Beat or derived from Beat fields by arithmetic
 *    (`id`, `durationMs`). Nothing is invented — a field the beat does not carry is
 *    absent from its scene, never defaulted.
 *  - It never mutates its input. Overlay objects are copied, so a later in-place edit
 *    of a beat (the pipeline rewrites `layout` to "broll" when an avatar beat fails)
 *    can never reach a plan already built, and vice versa.
 *  - It is pure apart from `writeScenePlanV1`, and imports no DB / settings / logger,
 *    so it is testable without the app's runtime.
 *  - The file is NOT `scenes.json`: the legacy pipeline (and run-upload.ts's
 *    rebuildSceneAssetsFromDisk) already read that name with a different shape.
 *
 * Fields for future stages (media intent, motion prompt, renderer…) are deliberately
 * not declared yet: with no producer they would be permanently empty, and their
 * meaning should be fixed by the stage that introduces them, as optional additions.
 */

export const SCENE_PLAN_V1_FILENAME = "scene-plan.v1.json";

const overlaySchema = z
  .object({
    type: z.enum(["date", "title", "person", "fact", "quote", "section"]),
    title: z.string().min(1),
    subtitle: z.string().optional(),
  })
  .strict();

const ms = z.number().finite().nonnegative();

export const sceneV1Schema = z
  .object({
    /** Stable scene id, derived from the beat index ("scene_0007" ↔ broll/beat_0007.mp4). */
    id: z.string().regex(/^scene_\d{4,}$/),
    /** The beat index this scene was projected from. */
    index: z.number().int().nonnegative(),
    startMs: ms,
    endMs: ms,
    /** endMs − startMs. Beats carry no duration of their own. */
    durationMs: ms,
    /** Narration spoken during this scene. */
    text: z.string(),
    layout: z.enum(["avatar", "split", "broll", "graphic"]),
    source: z.enum(["real", "ai"]),
    visualQuery: z.string(),
    youtubeQuery: z.string().optional(),
    aiPrompt: z.string().optional(),
    productLabel: z.string().optional(),
    aiMedia: z.enum(["image", "video"]).optional(),
    aiMediaPinned: z.boolean().optional(),
    queryType: z.enum(["entity", "generic", "abstract"]).optional(),
    footageKind: z.enum(["archival", "contemporary", "conceptual"]).optional(),
    domain: z.enum(["history", "finance", "ai", "startup", "business", "generic"]).optional(),
    topicKey: z.string().optional(),
    overlay: overlaySchema.optional(),
    overlayStartMs: ms.optional(),
    overlayEndMs: ms.optional(),
    supporting: overlaySchema.optional(),
    supportingStartMs: ms.optional(),
    supportingEndMs: ms.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.endMs < s.startMs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endMs < startMs", path: ["endMs"] });
    if (Math.abs(s.durationMs - (s.endMs - s.startMs)) > 1e-6) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "durationMs must equal endMs - startMs", path: ["durationMs"] });
    }
    if (s.id !== sceneId(s.index)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "id does not match index", path: ["id"] });
  });

export const scenePlanV1Schema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    /** ISO timestamp supplied by the caller (kept out of the pure conversion). */
    generatedAt: z.string().datetime(),
    /** Narration length the scenes were tiled against. */
    totalDurationMs: ms,
    scenes: z.array(sceneV1Schema).min(1),
  })
  .strict()
  .superRefine((p, ctx) => {
    const seen = new Set<number>();
    p.scenes.forEach((s, i) => {
      if (seen.has(s.index)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate scene index ${s.index}`, path: ["scenes", i, "index"] });
      seen.add(s.index);
      if (i > 0 && s.startMs < p.scenes[i - 1].startMs) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scenes are not in timeline order", path: ["scenes", i, "startMs"] });
      }
    });
  });

export type SceneV1 = z.infer<typeof sceneV1Schema>;
export type ScenePlanV1 = z.infer<typeof scenePlanV1Schema>;

export function sceneId(index: number): string {
  return `scene_${String(index).padStart(4, "0")}`;
}

/** Project one planned (tiled) beat onto a Scene v1. Pure; never mutates `beat`. */
export function beatToScene(beat: Beat): SceneV1 {
  const scene: SceneV1 = {
    id: sceneId(beat.index),
    index: beat.index,
    startMs: beat.startMs,
    endMs: beat.endMs,
    durationMs: beat.endMs - beat.startMs,
    text: beat.text,
    layout: beat.layout,
    source: beat.source,
    visualQuery: beat.visualQuery,
  };
  // Optional fields: copied only when the beat actually has them.
  if (beat.youtubeQuery !== undefined) scene.youtubeQuery = beat.youtubeQuery;
  if (beat.aiPrompt !== undefined) scene.aiPrompt = beat.aiPrompt;
  if (beat.productLabel !== undefined) scene.productLabel = beat.productLabel;
  if (beat.aiMedia !== undefined) scene.aiMedia = beat.aiMedia;
  if (beat.aiMediaPinned !== undefined) scene.aiMediaPinned = beat.aiMediaPinned;
  if (beat.queryType !== undefined) scene.queryType = beat.queryType;
  if (beat.footageKind !== undefined) scene.footageKind = beat.footageKind;
  if (beat.domain !== undefined) scene.domain = beat.domain;
  if (beat.topicKey !== undefined) scene.topicKey = beat.topicKey;
  if (beat.overlay !== undefined) scene.overlay = { ...beat.overlay };
  if (beat.overlayStartMs !== undefined) scene.overlayStartMs = beat.overlayStartMs;
  if (beat.overlayEndMs !== undefined) scene.overlayEndMs = beat.overlayEndMs;
  if (beat.supporting !== undefined) scene.supporting = { ...beat.supporting };
  if (beat.supportingStartMs !== undefined) scene.supportingStartMs = beat.supportingStartMs;
  if (beat.supportingEndMs !== undefined) scene.supportingEndMs = beat.supportingEndMs;
  return scene;
}

/**
 * Build (and validate) the whole plan. Throws a ZodError if the beats do not form a
 * structurally valid plan — the caller decides what a failure means (the pipeline
 * only logs it).
 */
export function beatsToScenePlan(
  beats: readonly Beat[],
  meta: { runId: string; totalDurationMs: number; generatedAt: string }
): ScenePlanV1 {
  return scenePlanV1Schema.parse({
    version: 1,
    runId: meta.runId,
    generatedAt: meta.generatedAt,
    totalDurationMs: meta.totalDurationMs,
    scenes: beats.map(beatToScene),
  });
}

/**
 * Build, validate and write the plan to `outPath`. Written to a temp file first and
 * renamed, so a crash mid-write never leaves a truncated plan behind. Throws on any
 * failure; the pipeline wraps the call so the run is never affected.
 */
export function writeScenePlanV1(
  outPath: string,
  beats: readonly Beat[],
  meta: { runId: string; totalDurationMs: number; generatedAt?: string }
): ScenePlanV1 {
  const plan = beatsToScenePlan(beats, { ...meta, generatedAt: meta.generatedAt ?? new Date().toISOString() });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2), "utf-8");
  fs.renameSync(tmp, outPath);
  return plan;
}

import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { splitScript, type Scene } from "./services/scene-split";
import { synthesizeScene, type TtsResult } from "./services/tts";
import { animateScene } from "./services/img2vid";
import {
  assembleVideo,
  assembleSingleShot,
  probeDurationSafe,
  type AssembleInput,
  type SingleShotInput,
} from "./services/video-assemble";
import { synthesizeAndAlign, alignToExistingAudio } from "./services/tts-align";
import { acquireStockClipForScene, pexelsPreflight, type Orientation } from "./services/stock-footage";
import { getKeyCount } from "./services/labs69";
import { syncRunToDrive, channelFolderName } from "./services/run-upload";
import { downloadReusedClip } from "./services/reuse";
import { findSimilarClips } from "./services/library";
import { checkCancelled, clearCancelled, CancelledError } from "./cancellation";

const getReuseMapStmt = db.prepare("SELECT reuse_map_json FROM runs WHERE id = ?");
const getPresetSnapshotStmt = db.prepare(
  "SELECT preset_content, preset_animation_motion, preset_voice_id, preset_name FROM runs WHERE id = ?"
);
const getRunRowStmt = db.prepare("SELECT id, script FROM runs WHERE id = ?");
const getRunConfigStmt = db.prepare("SELECT config_json FROM runs WHERE id = ?");

const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);

/** A scene's generated assets, ready for assembly. */
type SceneResult = AssembleInput | null;

/** scene index → padded asset file paths. */
function audioPathFor(audioDir: string, index: number): string {
  return path.join(audioDir, `scene_${String(index).padStart(3, "0")}.mp3`);
}
function videoPathFor(animDir: string, index: number): string {
  return path.join(animDir, `scene_${String(index).padStart(3, "0")}.mp4`);
}

/**
 * Visual source mix: which scene indices pull a real Pexels stock clip instead
 * of AI generation. Spread EVENLY across the timeline and deterministic (the
 * same scenes stay stock on a resume) so stock and AI interleave rather than
 * clump. 0% → none (full AI). 100% → all stock.
 */
function pickStockScenes(scenes: Scene[], ratioPercent: number): Set<number> {
  const ratio = Math.max(0, Math.min(100, ratioPercent));
  if (ratio <= 0) return new Set();
  if (ratio >= 100) return new Set(scenes.map((s) => s.index));
  const target = Math.max(1, Math.round((scenes.length * ratio) / 100));
  const step = scenes.length / target;
  const picks = new Set<number>();
  for (let i = 0; picks.size < target && i < scenes.length; i++) {
    picks.add(scenes[Math.floor(i * step)].index);
  }
  return picks;
}

/** Downloads a Pexels stock clip for one scene to its standard mp4 path; returns the path. */
async function fetchStockClip(
  runId: string,
  scene: Scene,
  animDir: string,
  usedIds: Set<number>
): Promise<string> {
  const outPath = videoPathFor(animDir, scene.index);
  await acquireStockClipForScene(scene, outPath, {
    runId,
    orientation: (getSetting("STOCK_FOOTAGE_ORIENTATION") || "landscape") as Orientation,
    maxHeight: Math.max(360, Number(getSetting("STOCK_FOOTAGE_MAX_HEIGHT") || "1080")),
    minDuration: Math.max(0, Number(getSetting("STOCK_FOOTAGE_MIN_DURATION") || "4")),
    usedIds,
  });
  return outPath;
}
/** True only if the file exists AND is non-empty (guards against broken/0-byte files). */
function fileReady(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** Read the per-channel overrides snapshotted onto the run row. */
function readPresetSnapshot(runId: string): {
  scenePrompt: string | undefined;
  motionOverride: string | null;
  voiceOverride: string | null;
  presetName: string | null;
} {
  const row = getPresetSnapshotStmt.get(runId) as
    | {
        preset_content: string | null;
        preset_animation_motion: string | null;
        preset_voice_id: string | null;
        preset_name: string | null;
      }
    | undefined;
  return {
    scenePrompt: row?.preset_content ?? undefined,
    motionOverride: row?.preset_animation_motion ?? null,
    voiceOverride: row?.preset_voice_id ?? null,
    presetName: row?.preset_name ?? null,
  };
}

/** Read the reuse map (scene index → Drive file id) the user picked on New Run. */
function readReuseMap(runId: string): Record<string, string> {
  const row = getReuseMapStmt.get(runId) as { reuse_map_json: string | null } | undefined;
  return row?.reuse_map_json ? (JSON.parse(row.reuse_map_json) as Record<string, string>) : {};
}

/**
 * Whether this run should auto-search the library for reusable clips.
 * Per-run choice from the New Run page (config_json.autoReuse); falls back to
 * the global AUTO_REUSE_ENABLED setting for runs created without it.
 */
function isAutoReuseRun(runId: string): boolean {
  const row = getRunConfigStmt.get(runId) as { config_json: string | null } | undefined;
  if (row?.config_json) {
    try {
      const cfg = JSON.parse(row.config_json) as { autoReuse?: unknown };
      if (typeof cfg.autoReuse === "boolean") return cfg.autoReuse;
    } catch {}
  }
  return getSetting("AUTO_REUSE_ENABLED") === "1";
}

/**
 * When AUTO_REUSE_ENABLED is on, the pipeline searches the Drive library
 * itself and folds high-confidence matches into the reuse map — no Preview
 * step, no manual approval clicking. Mutates `reuseMap` in place.
 * Best-effort: a search failure just logs and the run proceeds with full
 * generation. Scenes the user already picked manually are left untouched.
 */
/**
 * Hard cap on fresh generations per run. If more than MAX_FRESH_CLIPS_PER_RUN
 * scenes are still unmatched after normal auto-reuse, force additional library
 * reuse at a very low threshold until the run is under the cap.
 *
 * Strategy: rank all unmatched scenes by best-available library match (score
 * down to 1), then force-reuse the top `overflow` to bring fresh count under cap.
 * Scenes that have ZERO library match still get fresh generation — the cap
 * cannot create matches that don't exist.
 *
 * Setting `MAX_FRESH_CLIPS_PER_RUN = 0` (default) disables the cap.
 */
async function applyHardCapFreshClips(
  runId: string,
  scenes: Scene[],
  reuseMap: Record<string, string>,
  channel: string
): Promise<void> {
  const maxFresh = Math.max(0, Number(getSetting("MAX_FRESH_CLIPS_PER_RUN") || "0"));
  if (maxFresh <= 0) return; // disabled

  const freshCount = scenes.length - Object.keys(reuseMap).length;
  if (freshCount <= maxFresh) {
    log(
      runId,
      "info",
      `Fresh-clips cap (${maxFresh}) — current fresh count ${freshCount} is under cap, no extra reuse forced`,
      { stage: "reuse" }
    );
    return;
  }

  const overflow = freshCount - maxFresh;
  log(
    runId,
    "info",
    `Fresh-clips cap (${maxFresh}) exceeded by ${overflow} — forcing additional library reuse at low threshold`,
    { stage: "reuse" }
  );

  // Re-search library for unmatched scenes at the lowest possible threshold
  const unmatched = scenes.filter((s) => !reuseMap[String(s.index)]);
  let looseMatches: { new_scene_index: number; drive_file_id: string; score: number }[] = [];
  try {
    looseMatches = await findSimilarClips(unmatched, { minScore: 1, channel });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(
      runId,
      "warn",
      `Hard cap library re-search failed — continuing without forced reuse: ${msg.slice(0, 150)}`,
      { stage: "reuse" }
    );
    return;
  }

  // Keep best match per scene
  const bestByScene = new Map<number, { id: string; score: number }>();
  for (const m of looseMatches) {
    const cur = bestByScene.get(m.new_scene_index);
    if (!cur || m.score > cur.score) {
      bestByScene.set(m.new_scene_index, { id: m.drive_file_id, score: m.score });
    }
  }

  // Rank scenes by their best-available match score DESC and take top `overflow`
  const ranked = Array.from(bestByScene.entries()).sort(
    (a, b) => b[1].score - a[1].score
  );
  const forcedSlice = ranked.slice(0, overflow);

  for (const [sceneIdx, best] of forcedSlice) {
    reuseMap[String(sceneIdx)] = best.id;
  }

  const avgForcedScore =
    forcedSlice.length > 0
      ? Math.round(
          forcedSlice.reduce((sum, r) => sum + r[1].score, 0) / forcedSlice.length
        )
      : 0;
  const stillFresh = scenes.length - Object.keys(reuseMap).length;
  log(
    runId,
    "success",
    `Hard cap forced ${forcedSlice.length} additional reuses (avg score ${avgForcedScore}). Final fresh count: ${stillFresh}${stillFresh > maxFresh ? ` (still over cap — library does not have matches for ${stillFresh - maxFresh} scenes)` : ""}`,
    { stage: "reuse" }
  );
}

/**
 * In-run reuse: after library reuse (applyHardCapFreshClips) we may still be
 * over the fresh-clips cap, especially for new channels with empty libraries.
 *
 * Strategy: pick MAX_FRESH_CLIPS_PER_RUN scenes evenly spread across the
 * unmatched pool as DONORS (these will generate fresh). Every other unmatched
 * scene becomes DEFERRED and is marked with `INRUN:<donorIdx>` in reuseMap —
 * after the donor's clip is on disk, the deferred scene just file-copies it.
 *
 * Result: cost is bounded by MAX_FRESH_CLIPS_PER_RUN regardless of library
 * size; visual coherence comes from timeline locality (nearest-by-index donor).
 */
function applyHardCapInRunReuse(
  runId: string,
  scenes: Scene[],
  reuseMap: Record<string, string>
): void {
  const maxFresh = Math.max(0, Number(getSetting("MAX_FRESH_CLIPS_PER_RUN") || "0"));
  if (maxFresh <= 0) return;

  const unmatched = scenes.filter((s) => !reuseMap[String(s.index)]);
  if (unmatched.length <= maxFresh) return;

  // Pick donors evenly spread across the unmatched timeline.
  const step = unmatched.length / maxFresh;
  const donors: Scene[] = [];
  for (let i = 0; i < maxFresh; i++) {
    donors.push(unmatched[Math.floor(i * step)]);
  }
  const donorSet = new Set(donors.map((d) => d.index));
  const deferred = unmatched.filter((s) => !donorSet.has(s.index));

  // Assign each deferred scene to its nearest donor by index (topic locality).
  for (const def of deferred) {
    let best = donors[0];
    let bestDist = Math.abs(donors[0].index - def.index);
    for (const d of donors) {
      const dist = Math.abs(d.index - def.index);
      if (dist < bestDist) {
        best = d;
        bestDist = dist;
      }
    }
    reuseMap[String(def.index)] = `INRUN:${best.index}`;
  }

  log(
    runId,
    "success",
    `In-run reuse: ${donors.length} donors will generate fresh, ${deferred.length} deferred scenes will copy from nearest donor (cap ${maxFresh})`,
    { stage: "reuse" }
  );
}

async function applyAutoReuse(
  runId: string,
  scenes: Scene[],
  reuseMap: Record<string, string>,
  channel: string
): Promise<void> {
  const threshold = Math.max(
    0,
    Math.min(100, Number(getSetting("AUTO_REUSE_THRESHOLD") || "80"))
  );
  try {
    log(
      runId,
      "info",
      `Auto-reuse on — searching the "${channel}" library for clips matching at >=${threshold}%`,
      { stage: "reuse" }
    );
    // Auto-reuse stays within the run's own channel so a channel never pulls
    // off-brand clips from a different channel.
    const matches = await findSimilarClips(scenes, { minScore: threshold, channel });
    const bestByScene = new Map<number, { id: string; score: number }>();
    for (const m of matches) {
      const cur = bestByScene.get(m.new_scene_index);
      if (!cur || m.score > cur.score) {
        bestByScene.set(m.new_scene_index, { id: m.drive_file_id, score: m.score });
      }
    }
    let picked = 0;
    for (const [sceneIdx, best] of bestByScene) {
      if (best.score >= threshold && !reuseMap[String(sceneIdx)]) {
        reuseMap[String(sceneIdx)] = best.id;
        picked++;
      }
    }
    log(
      runId,
      "success",
      `Auto-reuse: ${picked}/${scenes.length} scene${picked === 1 ? "" : "s"} matched the library — Grok generation skipped for them (~${picked} video credit${picked === 1 ? "" : "s"} saved)`,
      { stage: "reuse" }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Auto-reuse search failed — continuing with full generation: ${msg.slice(0, 150)}`, {
      stage: "reuse",
    });
  }
}

/** Per-key × key-count concurrency limiters for TTS and video. */
function makeLimiters() {
  const keyCount = Math.max(1, getKeyCount());
  const ttsPerKey = Math.max(1, Number(getSetting("TTS_CONCURRENCY") || "3"));
  const animPerKey = Math.max(1, Number(getSetting("ANIMATION_CONCURRENCY") || "3"));
  return {
    keyCount,
    ttsPerKey,
    animPerKey,
    limitTts: pLimit(ttsPerKey * keyCount),
    limitAnim: pLimit(animPerKey * keyCount),
  };
}

/**
 * Logs the failure tally and throws if the failure rate is over the
 * user-configured threshold. Shared by runPipeline and resumeRun.
 */
function enforceFailureThreshold(runId: string, totalScenes: number, succeeded: number): void {
  const failedCount = totalScenes - succeeded;
  if (failedCount <= 0) return;
  const failedPct = (failedCount / totalScenes) * 100;
  const threshold = Math.max(
    0,
    Math.min(100, Number(getSetting("FAILURE_THRESHOLD_PERCENT") || "25"))
  );
  const over = failedPct > threshold;
  log(
    runId,
    over ? "error" : "warn",
    `${failedCount}/${totalScenes} scenes failed (${failedPct.toFixed(0)}%) · abort threshold ${threshold}%`,
    { stage: "pipeline" }
  );
  if (over) {
    throw new Error(
      `Too many scenes failed: ${failedCount}/${totalScenes} (${failedPct.toFixed(0)}% over the ${threshold}% threshold). The partial assets are kept — use Resume on the run page to regenerate only the missing scenes.`
    );
  }
}

/** Final assembly + Drive sync + mark the run done. Shared by both flows. */
async function finishRun(
  runId: string,
  sceneAssets: AssembleInput[],
  runDir: string
): Promise<void> {
  checkCancelled(runId);
  const finalPath = await assembleVideo(runId, sceneAssets, runDir);

  // Drive sync is best-effort — a failed upload must not roll back a
  // successful generation.
  try {
    await syncRunToDrive(runId, sceneAssets, runDir, finalPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Drive sync failed (local files preserved): ${msg}`, { stage: "gdrive" });
  }

  updateRun.run("done", finalPath, runId);
  log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });
}

/**
 * finishRun's twin for single-shot mode. Final video is built differently
 * (silent-concat + global audio mux), but post-assembly steps — Drive sync,
 * DB status, success log — are identical to the per-scene flow.
 */
async function finishRunSingleShot(
  runId: string,
  inputs: SingleShotInput[],
  globalAudioPath: string,
  runDir: string
): Promise<void> {
  checkCancelled(runId);
  const finalPath = await assembleSingleShot(runId, inputs, globalAudioPath, runDir);

  // Build AssembleInput[] for Drive sync so the library manifest gets per-scene
  // text / visual_prompt / audio_duration_sec exactly like a per-scene run.
  // All scenes share the same global audio file path; audio.durationSec is
  // the scene's Whisper-aligned slice duration.
  const sceneAssets: AssembleInput[] = inputs.map((i) => ({
    scene: i.scene,
    imagePath: i.videoPath,
    videoPath: i.videoPath,
    audio: {
      filePath: globalAudioPath,
      durationSec: Math.max(0.1, (i.endMs - i.startMs) / 1000),
    },
  }));

  try {
    await syncRunToDrive(runId, sceneAssets, runDir, finalPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Drive sync failed (local files preserved): ${msg}`, { stage: "gdrive" });
  }

  updateRun.run("done", finalPath, runId);
  log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });
}

/** Translate a thrown error into the right run status + log. Shared catch. */
function handlePipelineError(runId: string, e: unknown): void {
  if (e instanceof CancelledError) {
    log(runId, "warn", "Pipeline cancelled by user", { stage: "pipeline" });
    // status 'cancelled' was already set by the cancel endpoint
  } else {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "error", `Pipeline crashed: ${msg}`, { stage: "pipeline" });
    updateRun.run("error", null, runId);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Full run
// ───────────────────────────────────────────────────────────────────────────

export async function runPipeline(runId: string, script: string) {
  const runDir = getRunDir(runId);
  const audioDir = path.join(runDir, "audio");
  const animDir = path.join(runDir, "animations");
  // No imgDir — Conveyer Grok is video-only, scenes go straight to Grok img2vid.
  for (const d of [runDir, audioDir, animDir]) fs.mkdirSync(d, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);
    log(runId, "info", `Pipeline started · folder: ${path.basename(runDir)}`, { stage: "pipeline" });

    // 1. Split script into scenes — channel profile snapshot drives the prompt,
    //    voice and motion overrides.
    const { scenePrompt, motionOverride, voiceOverride, presetName } = readPresetSnapshot(runId);
    const scenes = await splitScript(runId, script, scenePrompt);
    checkCancelled(runId);
    fs.writeFileSync(path.join(runDir, "scenes.json"), JSON.stringify(scenes, null, 2), "utf-8");

    // Visual source mix: which scenes pull a real Pexels clip vs AI generation.
    // Empty when STOCK_RATIO_PERCENT=0 (full AI — original behaviour).
    const stockScenes = pickStockScenes(scenes, Number(getSetting("STOCK_RATIO_PERCENT") || "0"));
    const stockUsedIds = new Set<number>();
    if (stockScenes.size > 0) {
      // Fail fast on a bad/missing Pexels key BEFORE any TTS is spent.
      await pexelsPreflight(runId);
      log(
        runId,
        "info",
        `Visual mix: ${stockScenes.size}/${scenes.length} scenes from Pexels stock · ${scenes.length - stockScenes.size} AI-generated`,
        { stage: "pipeline" }
      );
    }

    // 1a. SINGLE-SHOT TTS MODE — when enabled, one continuous voiceover is
    // synthesised for the WHOLE script, Whisper word-aligns the boundaries
    // back to scenes, and visuals are rendered silent then muxed under the
    // global audio. Bypasses per-scene TTS, reuse logic and per-scene audio
    // crossfades entirely. Fixes the choppy boundary feel that broadcast-
    // quality voices (MiniMax, ElevenLabs v3) produce when stitched per-scene.
    const ttsMode = (getSetting("TTS_MODE") || "per-scene").toLowerCase();
    if (ttsMode === "single-shot") {
      const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
      if (animProvider === "off") {
        throw new Error(
          "Conveyer Grok is video-only: ANIMATION_PROVIDER cannot be 'off'. Set it to '69labs' in /settings."
        );
      }
      log(
        runId,
        "info",
        `TTS mode: single-shot — one continuous voiceover + Whisper word-alignment to scene boundaries`,
        { stage: "pipeline" }
      );

      const globalAudio = await synthesizeAndAlign(runId, scenes, audioDir, { voiceOverride });
      checkCancelled(runId);

      const { keyCount, animPerKey, limitAnim } = makeLimiters();
      log(
        runId,
        "info",
        `Generating ${scenes.length} silent video clips (${animProvider}, ${animPerKey}×${keyCount} parallel)`,
        { stage: "pipeline" }
      );

      const settled = await Promise.all(
        scenes.map(async (scene): Promise<SingleShotInput | null> => {
          try {
            checkCancelled(runId);
            const videoPath = await limitAnim(() =>
              stockScenes.has(scene.index)
                ? fetchStockClip(runId, scene, animDir, stockUsedIds)
                : animateScene(runId, scene, null, animDir, { motionOverride })
            );
            if (!videoPath) throw new Error(`Scene #${scene.index} produced no video clip`);
            const range = globalAudio.ranges.find((r) => r.sceneIdx === scene.index);
            return {
              scene,
              videoPath,
              startMs: range?.startMs ?? 0,
              endMs: range?.endMs ?? 0,
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 200)}`, {
              stage: "pipeline",
            });
            return null;
          }
        })
      );

      const inputs = settled.filter((x): x is SingleShotInput => x !== null);
      enforceFailureThreshold(runId, scenes.length, inputs.length);
      if (inputs.length === 0) throw new Error("No scenes succeeded");
      inputs.sort((a, b) => a.scene.index - b.scene.index);

      await finishRunSingleShot(runId, inputs, globalAudio.filePath, runDir);
      return;
    }

    const reuseMap = readReuseMap(runId);

    // Auto-reuse — when the run is in Auto mode, the pipeline searches the
    // library itself and folds matches into the reuse map (no Preview step).
    if (isAutoReuseRun(runId)) {
      await applyAutoReuse(runId, scenes, reuseMap, channelFolderName(presetName));
      checkCancelled(runId);
      // After normal auto-reuse, enforce the hard cap (no-op if disabled)
      await applyHardCapFreshClips(runId, scenes, reuseMap, channelFolderName(presetName));
      checkCancelled(runId);
      applyHardCapInRunReuse(runId, scenes, reuseMap);
      checkCancelled(runId);
    }

    const reuseCount = Object.keys(reuseMap).length;
    if (reuseCount > 0) {
      log(
        runId,
        "info",
        `${reuseCount} scene${reuseCount === 1 ? "" : "s"} will reuse an existing clip — those skip Grok generation`,
        { stage: "reuse", data: { reuseMap } }
      );
    }

    // 2. Guard: Conveyer Grok is video-only, the animation provider must be set.
    const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
    if (animProvider === "off") {
      throw new Error(
        "Conveyer Grok is video-only: ANIMATION_PROVIDER cannot be 'off'. Set it to '69labs' in /settings."
      );
    }

    // 3. Per scene: TTS + Grok text-to-video, interleaved, concurrency-limited.
    const { keyCount, ttsPerKey, animPerKey, limitTts, limitAnim } = makeLimiters();
    log(
      runId,
      "info",
      `Generating ${scenes.length} scenes (video-only). Keys: ${keyCount} · Concurrency per key×keys: TTS=${ttsPerKey}×${keyCount}, video=${animPerKey}×${keyCount}. Provider: ${animProvider}`,
      { stage: "pipeline" }
    );

    // Two-phase: donors+library reuses first, then in-run copies once donors exist.
    const donorScenes = scenes.filter((s) => {
      if (stockScenes.has(s.index)) return true; // stock scenes always run through the donor loop
      const m = reuseMap[String(s.index)];
      return !m || !m.startsWith("INRUN:");
    });
    const inrunScenes = scenes.filter((s) => {
      if (stockScenes.has(s.index)) return false; // never in-run-copy a stock scene
      const m = reuseMap[String(s.index)];
      return m && m.startsWith("INRUN:");
    });

    const donorResults: SceneResult[] = await Promise.all(
      donorScenes.map(async (scene): Promise<SceneResult> => {
        try {
          checkCancelled(runId);
          const reuseFileId = reuseMap[String(scene.index)];
          const [audio, videoPath] = await Promise.all([
            limitTts(() => synthesizeScene(runId, scene, audioDir, { voiceOverride })),
            stockScenes.has(scene.index)
              ? limitAnim(() => fetchStockClip(runId, scene, animDir, stockUsedIds))
              : reuseFileId
                ? downloadReusedClip(runId, scene, reuseFileId, animDir)
                : limitAnim(() => animateScene(runId, scene, null, animDir, { motionOverride })),
          ]);
          if (!videoPath) throw new Error(`Scene #${scene.index} produced no video clip`);
          return { scene, imagePath: videoPath, videoPath, audio };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 200)}`, { stage: "pipeline" });
          return null;
        }
      })
    );

    const inrunResults: SceneResult[] = await Promise.all(
      inrunScenes.map(async (scene): Promise<SceneResult> => {
        try {
          checkCancelled(runId);
          const marker = reuseMap[String(scene.index)];
          const donorIdx = Number(marker.slice("INRUN:".length));
          const audio = await limitTts(() => synthesizeScene(runId, scene, audioDir, { voiceOverride }));
          const donorPath = videoPathFor(animDir, donorIdx);
          const myPath = videoPathFor(animDir, scene.index);
          if (!fs.existsSync(donorPath)) {
            throw new Error(`donor scene ${donorIdx} clip missing — cannot in-run reuse`);
          }
          fs.copyFileSync(donorPath, myPath);
          return { scene, imagePath: myPath, videoPath: myPath, audio };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "error", `Scene #${scene.index} (in-run reuse) failed: ${msg.slice(0, 200)}`, { stage: "pipeline" });
          return null;
        }
      })
    );

    const settled: SceneResult[] = [...donorResults, ...inrunResults].sort(
      (a, b) => (a?.scene.index ?? 0) - (b?.scene.index ?? 0)
    );

    const sceneAssets = settled.filter((x): x is AssembleInput => x !== null);
    enforceFailureThreshold(runId, scenes.length, sceneAssets.length);
    if (sceneAssets.length === 0) throw new Error("No scenes succeeded");

    await finishRun(runId, sceneAssets, runDir);
  } catch (e) {
    handlePipelineError(runId, e);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Resume — regenerate only the missing scenes of a failed/partial run
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resumes a run that failed or was cancelled partway through. Reads the saved
 * scenes.json, keeps every scene whose audio + video are already on disk, and
 * regenerates ONLY the missing ones — then re-assembles and re-uploads.
 *
 * This is what makes runs failure-proof: a provider glitch / rate-cap night
 * no longer throws away clips already paid for.
 */
export async function resumeRun(runId: string) {
  const runDir = getRunDir(runId);
  const audioDir = path.join(runDir, "audio");
  const animDir = path.join(runDir, "animations");
  for (const d of [runDir, audioDir, animDir]) fs.mkdirSync(d, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);
    log(runId, "info", "Resume started — keeping finished scenes, regenerating the rest", {
      stage: "pipeline",
    });

    // The saved scene plan is required — without it there's nothing to resume.
    const scenesPath = path.join(runDir, "scenes.json");
    if (!fileReady(scenesPath)) {
      throw new Error(
        "scenes.json not found for this run — there's no saved scene plan to resume from. Start a fresh run instead."
      );
    }
    const scenes = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as Scene[];
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error("scenes.json is empty or invalid — start a fresh run instead.");
    }
    checkCancelled(runId);

    const { motionOverride, voiceOverride, presetName } = readPresetSnapshot(runId);

    // Visual source mix — recomputed identically to the original run
    // (deterministic spread by index), so the same scenes stay stock on resume.
    const stockScenes = pickStockScenes(scenes, Number(getSetting("STOCK_RATIO_PERCENT") || "0"));
    const stockUsedIds = new Set<number>();

    // SINGLE-SHOT RESUME — detect via existence of audio/full.mp3. The whole
    // voiceover has already been synthesised on the previous attempt; we
    // re-align with Whisper (cheap, ~1s + a few cents) and only regenerate
    // missing scene videos. Routing here keeps Resume out of the legacy
    // per-scene xfade assembler, which OOMs on huge runs (Bull Network hit
    // ffmpeg SIGKILL on a 436-scene Resume with the legacy path).
    const globalAudioPath = path.join(audioDir, "full.mp3");
    if (fileReady(globalAudioPath)) {
      log(
        runId,
        "info",
        "Resume: single-shot audio on disk — re-aligning + rebuilding visuals only",
        { stage: "pipeline" }
      );
      const audioDur = await probeDurationSafe(globalAudioPath);
      const globalAudio = await alignToExistingAudio(runId, scenes, globalAudioPath, audioDur);
      checkCancelled(runId);

      const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
      if (animProvider === "off") {
        throw new Error(
          "Conveyer Grok is video-only: ANIMATION_PROVIDER cannot be 'off'. Set it to '69labs' in /settings."
        );
      }
      const { limitAnim } = makeLimiters();
      const missingCount = scenes.filter((s) => !fileReady(videoPathFor(animDir, s.index))).length;
      log(
        runId,
        "info",
        `Single-shot resume: ${scenes.length - missingCount}/${scenes.length} scene videos on disk · regenerating ${missingCount}`,
        { stage: "pipeline" }
      );

      const settled = await Promise.all(
        scenes.map(async (scene): Promise<SingleShotInput | null> => {
          try {
            checkCancelled(runId);
            const vPath = videoPathFor(animDir, scene.index);
            let videoPath: string | null = vPath;
            if (!fileReady(vPath)) {
              videoPath = await limitAnim(() =>
                stockScenes.has(scene.index)
                  ? fetchStockClip(runId, scene, animDir, stockUsedIds)
                  : animateScene(runId, scene, null, animDir, { motionOverride })
              );
            }
            if (!videoPath) throw new Error(`Scene #${scene.index} produced no video clip`);
            const range = globalAudio.ranges.find((r) => r.sceneIdx === scene.index);
            return {
              scene,
              videoPath,
              startMs: range?.startMs ?? 0,
              endMs: range?.endMs ?? 0,
            };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 200)}`, {
              stage: "pipeline",
            });
            return null;
          }
        })
      );

      const inputs = settled.filter((x): x is SingleShotInput => x !== null);
      enforceFailureThreshold(runId, scenes.length, inputs.length);
      if (inputs.length === 0) throw new Error("No scenes succeeded");
      inputs.sort((a, b) => a.scene.index - b.scene.index);

      await finishRunSingleShot(runId, inputs, globalAudio.filePath, runDir);
      return;
    }

    const reuseMap = readReuseMap(runId);

    // Apply auto-reuse to scenes still missing on disk so Resume doesn't blindly
    // regenerate everything fresh. Build a synthetic "scenes-to-fill" list and
    // run the same reuse logic the initial pipeline uses.
    if (isAutoReuseRun(runId)) {
      const missingScenes = scenes.filter(
        (s) => !fileReady(videoPathFor(animDir, s.index))
      );
      const alreadyMapped = new Set(Object.keys(reuseMap));
      const needReuseCheck = missingScenes.filter((s) => !alreadyMapped.has(String(s.index)));
      if (needReuseCheck.length > 0) {
        log(
          runId,
          "info",
          `Resume + auto-reuse: ${needReuseCheck.length} missing scenes will be checked against library before regeneration`,
          { stage: "reuse" }
        );
        await applyAutoReuse(runId, needReuseCheck, reuseMap, channelFolderName(presetName));
        checkCancelled(runId);
        await applyHardCapFreshClips(runId, needReuseCheck, reuseMap, channelFolderName(presetName));
        checkCancelled(runId);
        applyHardCapInRunReuse(runId, needReuseCheck, reuseMap);
        checkCancelled(runId);
      }
    }

    const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
    if (animProvider === "off") {
      throw new Error(
        "Conveyer Grok is video-only: ANIMATION_PROVIDER cannot be 'off'. Set it to '69labs' in /settings."
      );
    }

    const alreadyComplete = scenes.filter(
      (s) => fileReady(audioPathFor(audioDir, s.index)) && fileReady(videoPathFor(animDir, s.index))
    ).length;
    log(
      runId,
      "info",
      `${alreadyComplete}/${scenes.length} scenes already complete on disk — regenerating the remaining ${scenes.length - alreadyComplete}`,
      { stage: "pipeline" }
    );

    const { limitTts, limitAnim } = makeLimiters();

    // Two-phase: donor/library scenes first, then in-run reuse copies once donors exist.
    const isInrun = (s: Scene) => {
      const m = reuseMap[String(s.index)];
      return !!m && m.startsWith("INRUN:");
    };
    const donorScenes = scenes.filter((s) => stockScenes.has(s.index) || !isInrun(s));
    const inrunScenes = scenes.filter((s) => !stockScenes.has(s.index) && isInrun(s));

    const processScene = async (scene: Scene): Promise<SceneResult> => {
        try {
          checkCancelled(runId);
          const aPath = audioPathFor(audioDir, scene.index);
          const vPath = videoPathFor(animDir, scene.index);

          // Audio: reuse the file on disk, else regenerate via HeyGen.
          let audio: TtsResult;
          if (fileReady(aPath)) {
            audio = { filePath: aPath, durationSec: await probeDurationSafe(aPath) };
          } else {
            audio = await limitTts(() => synthesizeScene(runId, scene, audioDir, { voiceOverride }));
          }

          // Video: reuse the clip on disk, else regenerate via Grok (or reuse
          // map → download from Drive / in-run donor copy).
          let videoPath: string;
          if (fileReady(vPath)) {
            videoPath = vPath;
          } else {
            const reuseFileId = reuseMap[String(scene.index)];
            let generated: string | null;
            if (stockScenes.has(scene.index)) {
              generated = await limitAnim(() => fetchStockClip(runId, scene, animDir, stockUsedIds));
            } else if (reuseFileId?.startsWith("INRUN:")) {
              const donorIdx = Number(reuseFileId.slice("INRUN:".length));
              const donorPath = videoPathFor(animDir, donorIdx);
              if (!fs.existsSync(donorPath)) {
                throw new Error(`donor scene ${donorIdx} clip missing — cannot in-run reuse`);
              }
              fs.copyFileSync(donorPath, vPath);
              generated = vPath;
            } else if (reuseFileId) {
              generated = await downloadReusedClip(runId, scene, reuseFileId, animDir);
            } else {
              generated = await limitAnim(() => animateScene(runId, scene, null, animDir, { motionOverride }));
            }
            if (!generated) throw new Error(`Scene #${scene.index} produced no video clip`);
            videoPath = generated;
          }

          return { scene, imagePath: videoPath, videoPath, audio };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 200)}`, { stage: "pipeline" });
          return null;
        }
    };

    const donorSettled = await Promise.all(donorScenes.map(processScene));
    const inrunSettled = await Promise.all(inrunScenes.map(processScene));
    const settled: SceneResult[] = [...donorSettled, ...inrunSettled].sort(
      (a, b) => (a?.scene.index ?? 0) - (b?.scene.index ?? 0)
    );

    const sceneAssets = settled.filter((x): x is AssembleInput => x !== null);
    enforceFailureThreshold(runId, scenes.length, sceneAssets.length);
    if (sceneAssets.length === 0) throw new Error("No scenes succeeded");

    await finishRun(runId, sceneAssets, runDir);
  } catch (e) {
    handlePipelineError(runId, e);
  }
}

/** Whether a run can be resumed — needs a row + a saved scenes.json on disk. */
export function canResumeRun(runId: string): boolean {
  const row = getRunRowStmt.get(runId) as { id: string } | undefined;
  if (!row) return false;
  return fileReady(path.join(getRunDir(runId), "scenes.json"));
}

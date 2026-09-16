import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { checkCancelled, clearCancelled, CancelledError } from "./cancellation";
import { transcribeMedia } from "./services/transcribe";
import { planAvatarBeats } from "./services/avatar-plan";
import { acquireStockClipForScene, type Orientation } from "./services/stock-footage";
import { animateScene } from "./services/img2vid";
import { assembleAvatarVideo, type RenderBeat } from "./services/avatar-assemble";
import type { Scene } from "./services/scene-split";

const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);

/**
 * AVATAR MODE pipeline.
 *
 * Input: a finished talking-head MP4 (e.g. HeyGen). We transcribe it, plan a
 * layout per segment (avatar full / split / B-roll full), fetch a matched
 * B-roll clip for each visual beat (AI-generated or Pexels stock, per
 * STOCK_RATIO_PERCENT), then composite everything over the avatar's own audio.
 *
 * Separate from runPipeline (faceless, script-based) — different input and
 * different assembly — but it reuses the same Whisper, visual-source and
 * 69labs/Pexels engines.
 */
export async function runAvatarPipeline(runId: string, avatarVideoPath: string) {
  const runDir = getRunDir(runId);
  const brollDir = path.join(runDir, "broll");
  fs.mkdirSync(brollDir, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);
    log(runId, "info", `Avatar pipeline started · ${path.basename(avatarVideoPath)}`, { stage: "pipeline" });

    if (!fs.existsSync(avatarVideoPath)) {
      throw new Error(`Uploaded avatar video not found on disk: ${avatarVideoPath}`);
    }

    // 1. Transcribe the uploaded avatar video.
    const { segments, durationSec } = await transcribeMedia(avatarVideoPath, runId);
    checkCancelled(runId);
    if (segments.length === 0) {
      throw new Error("Transcription produced no segments — is there clear speech in the uploaded video?");
    }

    // 2. Plan the layout (avatar / split / broll) + source (AI vs stock) per segment.
    const stockRatio = Math.max(0, Math.min(100, Number(getSetting("STOCK_RATIO_PERCENT") || "50")));
    const beats = await planAvatarBeats(segments, { stockRatioPercent: stockRatio, runId });
    fs.writeFileSync(path.join(runDir, "beats.json"), JSON.stringify(beats, null, 2), "utf-8");
    checkCancelled(runId);

    // 3. Fetch B-roll for every non-avatar beat (concurrency-limited).
    const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
    const conc = Math.max(1, Number(getSetting("ANIMATION_CONCURRENCY") || "3"));
    const limit = pLimit(conc);
    const usedIds = new Set<number>();
    const visualCount = beats.filter((b) => b.layout !== "avatar").length;
    log(
      runId,
      "info",
      `Fetching ${visualCount} B-roll clips for ${segments.length} beats (${durationSec.toFixed(1)}s · provider ${animProvider})`,
      { stage: "pipeline" }
    );

    const renderBeats: RenderBeat[] = await Promise.all(
      beats.map(async (beat, i): Promise<RenderBeat> => {
        if (beat.layout === "avatar") return { ...beat, brollPath: null };
        const pseudoScene: Scene = {
          index: i,
          text: beat.text,
          visual_prompt: beat.visualQuery || beat.text,
          duration_hint_sec: Math.max(2, Math.round((beat.endMs - beat.startMs) / 1000)),
        };
        try {
          checkCancelled(runId);
          if (beat.source === "stock") {
            const outPath = path.join(brollDir, `broll_${String(i).padStart(4, "0")}.mp4`);
            await limit(() =>
              acquireStockClipForScene(pseudoScene, outPath, {
                runId,
                orientation: (getSetting("STOCK_FOOTAGE_ORIENTATION") || "landscape") as Orientation,
                maxHeight: Math.max(360, Number(getSetting("STOCK_FOOTAGE_MAX_HEIGHT") || "1080")),
                minDuration: Math.max(0, Number(getSetting("STOCK_FOOTAGE_MIN_DURATION") || "4")),
                usedIds,
              })
            );
            return { ...beat, brollPath: outPath };
          }
          // AI-generated B-roll via Grok / Veo / gemini-omni.
          const generated = await limit(() =>
            animateScene(runId, pseudoScene, null, brollDir, { motionOverride: null })
          );
          return { ...beat, brollPath: generated ?? null, layout: generated ? beat.layout : "avatar" };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "warn", `Beat ${i} B-roll failed (${msg.slice(0, 120)}) — using avatar full-screen for it`, {
            stage: "animate",
          });
          return { ...beat, layout: "avatar", brollPath: null };
        }
      })
    );
    checkCancelled(runId);

    // 4. Composite over the avatar's own audio.
    const finalPath = await assembleAvatarVideo(runId, avatarVideoPath, renderBeats, runDir);
    updateRun.run("done", finalPath, runId);
    log(runId, "success", "Avatar pipeline complete", { stage: "pipeline", data: { finalPath } });
  } catch (e) {
    if (e instanceof CancelledError) {
      log(runId, "warn", "Pipeline cancelled by user", { stage: "pipeline" });
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Avatar pipeline crashed: ${msg}`, { stage: "pipeline" });
      updateRun.run("error", null, runId);
    }
  }
}

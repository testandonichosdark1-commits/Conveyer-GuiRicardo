import path from "node:path";
import { downloadFile } from "./gdrive";
import { log } from "../logger";
import type { Scene } from "./scene-split";

/**
 * Downloads a previously generated clip from Drive into the run's animations
 * folder, named the same way animateScene would have named it. Pipeline then
 * picks it up as if it had been generated locally.
 *
 * Returns the local file path. Throws on download failure — the pipeline
 * catches and treats the scene as failed (same as a Grok failure), so we don't
 * silently produce a "missing video" downstream.
 */
export async function downloadReusedClip(
  runId: string,
  scene: Scene,
  driveFileId: string,
  animDir: string
): Promise<string> {
  const padded = String(scene.index).padStart(3, "0");
  const destPath = path.join(animDir, `scene_${padded}.mp4`);

  log(
    runId,
    "info",
    `Scene #${scene.index}: reusing existing clip from Drive (skip Grok generation)`,
    { stage: "reuse", data: { driveFileId } }
  );

  await downloadFile(driveFileId, destPath);

  log(
    runId,
    "info",
    `Scene #${scene.index}: clip downloaded from Drive`,
    { stage: "reuse" }
  );

  return destPath;
}

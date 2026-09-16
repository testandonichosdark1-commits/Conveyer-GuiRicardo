import fs from "node:fs";
import path from "node:path";
import db from "../db";
import { log } from "../logger";
import { getSetting } from "../settings";
import {
  ensureTopLevelFolders,
  findOrCreateFolder,
  getDriveClient,
  uploadFile,
  uploadString,
} from "./gdrive";
import type { Scene } from "./scene-split";
import type { TtsResult } from "./tts";

/** Shape of a scene asset coming out of the pipeline. Mirrors AssembleInput. */
export interface SceneAsset {
  scene: Scene;
  imagePath: string;
  videoPath?: string | null;
  audio: TtsResult;
}

interface ClipsManifestEntry {
  index: number;
  file: string;
  drive_file_id: string;
  scene_text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  audio_duration_sec: number | null;
  video_duration_sec: number | null;
}

interface ClipsManifest {
  schema_version: 1;
  run_id: string;
  run_title: string | null;
  folder_name: string;
  /** Channel profile name this run used, or "_No Channel". Drives per-channel library filtering. */
  channel: string;
  created_at: string;
  scene_count: number;
  settings_snapshot: {
    animation_provider: string;
    animation_model: string;
    image_resolution: string;
    video_resolution: string;
    video_fps: string;
  };
  clips: ClipsManifestEntry[];
}

const getRunRow = db.prepare(
  "SELECT title, folder_name, preset_name FROM runs WHERE id = ?"
);

/** Channel folder name for a run — the channel profile name, or a shared bucket. */
export function channelFolderName(presetName: string | null | undefined): string {
  const n = (presetName ?? "").trim();
  return n.length > 0 ? n : "_No Channel";
}

const updateDriveRefs = db.prepare(
  "UPDATE runs SET drive_clips_folder_id = ?, drive_final_video_id = ?, drive_synced_at = datetime('now') WHERE id = ?"
);

/**
 * Upload a finished run to Google Drive, then delete local raw clip files.
 *
 * Layout in Drive:
 *   {clipsLibraryFolderId}/{runFolderName}/
 *     scene_001.mp4              ← raw Veo clip, no voiceover
 *     scene_002.mp4
 *     ...
 *     clips.json                 ← machine-readable manifest (AI search reads this)
 *     description.md             ← human-readable summary
 *   {finalVideosFolderId}/{runFolderName}.mp4
 *
 * After upload, local raw clips in {runDir}/animations/ are deleted. The final
 * video at {runDir}/final.mp4 is kept locally (single playable backup).
 *
 * Returns true when an upload actually happened; false when sync is disabled or
 * Drive isn't connected (in which case we leave everything locally untouched).
 *
 * Best-effort: if any individual upload fails, we abort the cleanup so the user
 * still has the raw clips on disk and can retry. Throws on critical errors so
 * the caller can log them.
 */
export async function syncRunToDrive(
  runId: string,
  sceneAssets: SceneAsset[],
  runDir: string,
  finalPath: string,
  options: { force?: boolean } = {}
): Promise<boolean> {
  // `force` lets the /api/runs/[id]/drive POST trigger a manual re-sync even
  // when the auto-sync toggle is off — manual action is always honored.
  const syncEnabled = options.force || getSetting("GDRIVE_SYNC_ENABLED") === "1";
  if (!syncEnabled) return false;

  const drive = getDriveClient();
  if (!drive) {
    log(
      runId,
      "warn",
      "Drive sync enabled but not connected — skipping upload. Reconnect in /settings.",
      { stage: "gdrive" }
    );
    return false;
  }

  const runRow = getRunRow.get(runId) as
    | { title: string | null; folder_name: string | null; preset_name: string | null }
    | undefined;
  const folderName = runRow?.folder_name ?? path.basename(runDir);
  const title = runRow?.title ?? null;
  const channel = channelFolderName(runRow?.preset_name);

  log(runId, "info", `Drive sync starting · channel: ${channel} · folder: ${folderName}`, {
    stage: "gdrive",
  });

  const { finalVideosId, clipsLibraryId } = await ensureTopLevelFolders();

  // Per-channel sub-folder inside Clips Library, then the per-run folder inside
  // it: Clips Library / {channel} / {run}. Keeps every channel's clips isolated
  // so library search stays on-brand instead of mixing 16 channels together.
  const channelFolderId = await findOrCreateFolder(channel, clipsLibraryId);
  const runFolderId = await findOrCreateFolder(folderName, channelFolderId);

  // 1. Upload raw clips (animations/scene_*.mp4 — Veo output before voiceover)
  const uploadedClips: ClipsManifestEntry[] = [];
  for (const asset of sceneAssets) {
    if (!asset.videoPath || !fs.existsSync(asset.videoPath)) {
      log(
        runId,
        "warn",
        `Scene #${asset.scene.index}: no raw video to upload, skipped`,
        { stage: "gdrive" }
      );
      continue;
    }
    const fileName = `scene_${String(asset.scene.index).padStart(3, "0")}.mp4`;
    try {
      const fileId = await uploadFile(asset.videoPath, runFolderId, { name: fileName });
      uploadedClips.push({
        index: asset.scene.index,
        file: fileName,
        drive_file_id: fileId,
        scene_text: asset.scene.text,
        visual_prompt: asset.scene.visual_prompt,
        duration_hint_sec: asset.scene.duration_hint_sec,
        audio_duration_sec: asset.audio?.durationSec ?? null,
        video_duration_sec: null, // Veo clips are ~6s, exact value not measured here
      });
      log(runId, "info", `Uploaded ${fileName} → Drive`, { stage: "gdrive" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Failed to upload ${fileName}: ${msg}`, { stage: "gdrive" });
      throw e; // abort — don't delete locals if upload is broken
    }
  }

  // 2. Build + upload manifest files. These are what the future AI search reads.
  const manifest: ClipsManifest = {
    schema_version: 1,
    run_id: runId,
    run_title: title,
    folder_name: folderName,
    channel,
    created_at: new Date().toISOString(),
    scene_count: sceneAssets.length,
    settings_snapshot: {
      animation_provider: getSetting("ANIMATION_PROVIDER"),
      animation_model: getSetting("ANIMATION_MODEL"),
      image_resolution: getSetting("IMAGE_RESOLUTION"),
      video_resolution: getSetting("VIDEO_RESOLUTION"),
      video_fps: getSetting("VIDEO_FPS"),
    },
    clips: uploadedClips,
  };

  await uploadString(
    JSON.stringify(manifest, null, 2),
    runFolderId,
    "clips.json",
    "application/json"
  );
  await uploadString(buildDescriptionMarkdown(manifest), runFolderId, "description.md", "text/markdown");
  log(runId, "info", `Uploaded clips.json + description.md`, { stage: "gdrive" });

  // 3. Upload final video to the Final Videos folder
  const finalDriveName = `${folderName}.mp4`;
  const finalVideoId = await uploadFile(finalPath, finalVideosId, { name: finalDriveName });
  log(runId, "info", `Uploaded final video → Drive/Final Videos/${finalDriveName}`, {
    stage: "gdrive",
  });

  // Persist the Drive references so the run page can show status + open-links
  // without making another Drive API call.
  updateDriveRefs.run(runFolderId, finalVideoId, runId);

  // 4. Clean up local raw clips — they live in Drive now. Final video and
  //    audio files stay locally.
  cleanupLocalRawClips(runId, runDir);

  log(runId, "success", `Drive sync complete · ${uploadedClips.length} clips + final video`, {
    stage: "gdrive",
  });
  return true;
}

/**
 * Reconstruct SceneAsset[] from files left on disk. Used by re-sync to upload
 * a run that has finished but never made it to Drive (or got partially uploaded
 * and we want to retry).
 *
 * Reads scenes.json (always written by the pipeline) and pairs each scene with
 * its raw video clip + audio file by filename convention.
 */
export function rebuildSceneAssetsFromDisk(runDir: string): SceneAsset[] {
  const scenesPath = path.join(runDir, "scenes.json");
  if (!fs.existsSync(scenesPath)) return [];
  const scenes = JSON.parse(fs.readFileSync(scenesPath, "utf-8")) as Scene[];

  const animDir = path.join(runDir, "animations");
  const audioDir = path.join(runDir, "audio");

  const result: SceneAsset[] = [];
  for (const scene of scenes) {
    const padded = String(scene.index).padStart(3, "0");
    // Match common filename patterns from the pipeline: scene_001.mp4, scene-001.mp4.
    const videoCandidates = [
      path.join(animDir, `scene_${padded}.mp4`),
      path.join(animDir, `scene-${padded}.mp4`),
      path.join(animDir, `${padded}.mp4`),
    ];
    const audioCandidates = [
      path.join(audioDir, `scene_${padded}.mp3`),
      path.join(audioDir, `scene-${padded}.mp3`),
      path.join(audioDir, `${padded}.mp3`),
    ];
    const videoPath = videoCandidates.find((p) => fs.existsSync(p)) ?? null;
    const audioPath = audioCandidates.find((p) => fs.existsSync(p));
    if (!audioPath) continue; // no audio = can't reconstruct
    // We don't know exact audio duration without ffprobe; pipeline normally
    // measures it. For re-sync this only affects manifest metadata, so we
    // record 0 and the user can re-run the original pipeline for exact values.
    result.push({
      scene,
      imagePath: videoPath ?? audioPath,
      videoPath,
      audio: { filePath: audioPath, durationSec: 0 },
    });
  }
  return result;
}

/**
 * Removes the raw Veo clips folder ({runDir}/animations) plus intermediate
 * voiced clips ({runDir}/clips) after a successful upload. Keeps final.mp4
 * and audio/ locally.
 */
function cleanupLocalRawClips(runId: string, runDir: string): void {
  const targets = [path.join(runDir, "animations"), path.join(runDir, "clips")];
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(runId, "info", `Cleaned local: ${path.basename(dir)}/`, { stage: "gdrive" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Could not delete ${dir}: ${msg}`, { stage: "gdrive" });
    }
  }
}

/** Builds the human-readable description.md companion to clips.json. */
function buildDescriptionMarkdown(m: ClipsManifest): string {
  const lines: string[] = [];
  lines.push(`# Run: ${m.run_title ?? m.folder_name}`);
  lines.push("");
  lines.push(`- **Run ID:** \`${m.run_id}\``);
  lines.push(`- **Folder:** \`${m.folder_name}\``);
  lines.push(`- **Created:** ${m.created_at}`);
  lines.push(`- **Scenes:** ${m.scene_count} (uploaded: ${m.clips.length})`);
  lines.push(
    `- **Model:** ${m.settings_snapshot.animation_provider}/${m.settings_snapshot.animation_model} · ${m.settings_snapshot.video_resolution} @ ${m.settings_snapshot.video_fps}fps`
  );
  lines.push("");
  lines.push(
    "Raw scene clips below are **without voiceover** — suitable for reuse in future runs."
  );
  lines.push(
    "Field `visual_prompt` is what was fed into the video model. Field `scene_text` is the narration line that played over this clip in the original run."
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const c of m.clips) {
    lines.push(`## Scene ${c.index}`);
    lines.push("");
    lines.push(`- **File:** \`${c.file}\``);
    lines.push(`- **Drive file ID:** \`${c.drive_file_id}\``);
    if (c.audio_duration_sec != null) {
      lines.push(`- **Original audio length:** ${c.audio_duration_sec.toFixed(2)}s`);
    }
    lines.push("");
    lines.push(`**Visual prompt:**`);
    lines.push("");
    lines.push("```");
    lines.push(c.visual_prompt);
    lines.push("```");
    lines.push("");
    lines.push(`**Scene narration text:**`);
    lines.push("");
    lines.push(c.scene_text);
    lines.push("");
  }

  return lines.join("\n");
}

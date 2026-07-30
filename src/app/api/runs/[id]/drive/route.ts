import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { log } from "@/lib/logger";
import { getRunDir } from "@/lib/run-paths";
import { getConnectionStatus } from "@/lib/services/gdrive";
import { rebuildSceneAssetsFromDisk, syncRunToDrive } from "@/lib/services/run-upload";

interface DriveStatus {
  syncEnabled: boolean;          // is Drive auto-sync turned on at all
  connected: boolean;            // is Drive currently usable
  synced: boolean;               // has this run been uploaded at least once
  syncedAt?: string;             // ISO timestamp of the last upload
  clipsFolderId?: string;
  finalVideoId?: string;
  clipsFolderLink?: string;
  finalVideoLink?: string;
  canRetry: boolean;             // raw clips still on disk → full re-sync possible
  rawClipsRemainCount: number;   // info hint for the UI
}

const getRun = db.prepare(
  "SELECT id, folder_name, drive_clips_folder_id, drive_final_video_id, drive_synced_at FROM runs WHERE id = ?"
);

function buildLinks(clipsFolderId?: string | null, finalVideoId?: string | null) {
  return {
    clipsFolderLink: clipsFolderId
      ? `https://drive.google.com/drive/folders/${clipsFolderId}`
      : undefined,
    finalVideoLink: finalVideoId
      ? `https://drive.google.com/file/d/${finalVideoId}/view`
      : undefined,
  };
}

/** Status of the current run's relationship with Drive. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;

  const row = getRun.get(id) as
    | {
        id: string;
        folder_name: string | null;
        drive_clips_folder_id: string | null;
        drive_final_video_id: string | null;
        drive_synced_at: string | null;
      }
    | undefined;

  if (!row) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const gdrive = await getConnectionStatus();
  const runDir = getRunDir(id);
  const animDir = path.join(runDir, "animations");
  const rawClipsRemainCount = fs.existsSync(animDir)
    ? fs.readdirSync(animDir).filter((f) => f.endsWith(".mp4")).length
    : 0;

  const status: DriveStatus = {
    syncEnabled: gdrive.syncEnabled,
    connected: gdrive.connected,
    synced: !!row.drive_clips_folder_id || !!row.drive_final_video_id,
    syncedAt: row.drive_synced_at ?? undefined,
    clipsFolderId: row.drive_clips_folder_id ?? undefined,
    finalVideoId: row.drive_final_video_id ?? undefined,
    ...buildLinks(row.drive_clips_folder_id, row.drive_final_video_id),
    canRetry: rawClipsRemainCount > 0 && fs.existsSync(path.join(runDir, "final.mp4")),
    rawClipsRemainCount,
  };

  return NextResponse.json(status);
}

/**
 * Force a (re-)upload to Drive. Useful when:
 *  - run finished while Drive sync was off and the user later turned it on
 *  - a previous upload partially failed
 *  - the user wants to push an updated final.mp4
 *
 * Best-effort: uploads whatever still exists on disk; doesn't re-create raw
 * clips that have been cleaned up. The run row is updated with new IDs even
 * for a partial upload.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;

  const row = getRun.get(id) as { id: string; folder_name: string | null } | undefined;
  if (!row) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const gdrive = await getConnectionStatus();
  if (!gdrive.connected) {
    return NextResponse.json(
      { error: "Google Drive is not connected. Open /settings and connect first." },
      { status: 400 }
    );
  }

  const runDir = getRunDir(id);
  const finalPath = path.join(runDir, "final.mp4");
  if (!fs.existsSync(finalPath)) {
    return NextResponse.json(
      { error: "Final video not found on disk — cannot sync." },
      { status: 400 }
    );
  }

  const sceneAssets = rebuildSceneAssetsFromDisk(runDir);
  log(id, "info", `Manual Drive re-sync requested (${sceneAssets.length} scenes on disk)`, {
    stage: "gdrive",
  });

  try {
    const ok = await syncRunToDrive(id, sceneAssets, runDir, finalPath, { force: true });
    if (!ok) {
      return NextResponse.json(
        { error: "Sync skipped — connection unavailable mid-flight." },
        { status: 500 }
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Return fresh status
  const updated = getRun.get(id) as {
    drive_clips_folder_id: string | null;
    drive_final_video_id: string | null;
    drive_synced_at: string | null;
  };
  return NextResponse.json({
    ok: true,
    syncedAt: updated.drive_synced_at,
    ...buildLinks(updated.drive_clips_folder_id, updated.drive_final_video_id),
  });
}

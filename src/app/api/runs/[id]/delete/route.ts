import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { getRunDir, getRunsRoot, DATA_DIR } from "@/lib/run-paths";

// This route removes files from disk, so pin the Node runtime.
export const runtime = "nodejs";

const getRunLite = db.prepare("SELECT id, status, folder_name FROM runs WHERE id = ?");
const deleteLogs = db.prepare("DELETE FROM run_logs WHERE run_id = ?");
const markDeleted = db.prepare("UPDATE runs SET deleted_at = datetime('now') WHERE id = ?");

/**
 * Delete a job from the Jobs page. This is a SOFT delete: we wipe the run's
 * on-disk folder (final.mp4, broll/, avatar/, audio/, beats/, temp) to free disk
 * and remove its run_logs, but KEEP the runs row (stamped deleted_at), run_costs,
 * and output_path so the Costs page stays byte-for-byte accurate. The row is then
 * hidden from every listing (deleted_at IS NULL filter) and its detail URL 404s.
 * Google Drive copies are left untouched. Refuses while the run is still
 * processing.
 *
 * A dedicated action endpoint (POST .../delete), not HTTP DELETE, because the run
 * resource is intentionally preserved — matching the sibling verbs (/cancel,
 * /reassemble, /recover-from-drive).
 */
export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const row = getRunLite.get(id) as
    | { id: string; status: string; folder_name: string | null }
    | undefined;
  if (!row) return NextResponse.json({ error: "run not found" }, { status: 404 });

  // Don't delete files out from under an active render.
  if (row.status === "running" || row.status === "pending") {
    return NextResponse.json(
      { error: "run is still processing — cancel it first" },
      { status: 409 }
    );
  }

  // Path-safety: only ever remove a run's own subfolder, never the runs root or
  // the data/runs symlink.
  const runsRoot = path.resolve(getRunsRoot());
  const dir = path.resolve(getRunDir(id));
  if (!row.folder_name || dir === runsRoot || !dir.startsWith(runsRoot + path.sep)) {
    return NextResponse.json({ error: "unsafe run path" }, { status: 400 });
  }

  // Wipe the run folder. force:true → idempotent if already gone.
  fs.rmSync(dir, { recursive: true, force: true });

  // Best-effort: also remove any YT-footage debug frames (keyed by id prefix).
  try {
    fs.rmSync(path.join(DATA_DIR, "debug_frames", `run_${id.slice(0, 8)}`), {
      recursive: true,
      force: true,
    });
  } catch {
    // non-critical
  }

  deleteLogs.run(id);
  markDeleted.run(id);
  // No run-log write here — the logs were just deleted. Server trace only.
  // eslint-disable-next-line no-console
  console.info(`[runs] deleted job ${id}`);
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import db from "@/lib/db";
import { getLogsSince } from "@/lib/logger";
import { ensureInit } from "@/lib/init";
import { canResumeRun } from "@/lib/pipeline";
import { canResumeStudioRun, getRunMode } from "@/lib/studio-pipeline";
import { isRunActive } from "@/lib/run-lifecycle";

const getRun = db.prepare("SELECT * FROM runs WHERE id = ?");

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const run = getRun.get(id) as { deleted_at?: string | null } | undefined;
  // A soft-deleted job is unreachable: its files + logs are gone and the row
  // survives only for cost accounting, so the detail URL 404s like a real delete.
  if (!run || run.deleted_at) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Incremental logs: the poller passes ?sinceId=<last id it has> so we return
  // only newer rows (append, no full re-download). Absent/invalid → 0 → full
  // history (first load / after a browser refresh). This is the SAME contract for
  // a fresh run, a refresh, and a resume — there is no separate resume log path.
  const sinceId = Number(new URL(req.url).searchParams.get("sinceId") ?? "0") || 0;

  // Real backend resumability (studio vs legacy asks the right pipeline whether
  // its on-disk state can be resumed) — NOT inferred from scene-asset layout,
  // which studio runs never produce. False while the pipeline is already active
  // so the UI never offers Resume on a live run. The UI combines this with the
  // run status (interrupted | error | cancelled) to decide when to show Resume.
  const canResume =
    !isRunActive(id) &&
    (getRunMode(id) === "studio" ? canResumeStudioRun(id) : canResumeRun(id));

  return NextResponse.json({ run, logs: getLogsSince(id, sinceId), canResume });
}

import { NextResponse } from "next/server";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { markCancelled } from "@/lib/cancellation";
import { log } from "@/lib/logger";

const getRun = db.prepare("SELECT id, status FROM runs WHERE id = ?");
const updateStatus = db.prepare(
  "UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?"
);

export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const row = getRun.get(id) as { id: string; status: string } | undefined;
  if (!row) return NextResponse.json({ error: "run not found" }, { status: 404 });

  if (row.status === "running" || row.status === "pending") {
    markCancelled(id);
    updateStatus.run("cancelled", id);
    log(id, "warn", "Cancelled by user", { stage: "pipeline" });
  }
  return NextResponse.json({ ok: true, previousStatus: row.status });
}

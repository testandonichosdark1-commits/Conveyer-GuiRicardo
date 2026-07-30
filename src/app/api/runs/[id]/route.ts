import { NextResponse } from "next/server";
import db from "@/lib/db";
import { getLogs } from "@/lib/logger";
import { ensureInit } from "@/lib/init";

const getRun = db.prepare("SELECT * FROM runs WHERE id = ?");

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const run = getRun.get(id) as { deleted_at?: string | null } | undefined;
  // A soft-deleted job is unreachable: its files + logs are gone and the row
  // survives only for cost accounting, so the detail URL 404s like a real delete.
  if (!run || run.deleted_at) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ run, logs: getLogs(id) });
}

import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getRunDir, dirSizeBytes } from "@/lib/run-paths";

// Walks the run folder on disk — Node runtime.
export const runtime = "nodejs";

/**
 * Size in bytes of a single run's on-disk folder. Fetched only when the Jobs
 * delete dialog opens (one folder — cheap), so we can show "frees about X GB"
 * without computing per-row sizes on every list poll. Missing/deleted folder → 0.
 */
export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  return NextResponse.json({ bytes: dirSizeBytes(getRunDir(id)) });
}

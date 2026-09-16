import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { listLibraryRuns } from "@/lib/services/library";

/**
 * Returns every run in the user's Drive Clips Library with a summary of each.
 * Empty list when Drive is not connected or the library is empty.
 */
export async function GET() {
  ensureInit();
  try {
    const runs = await listLibraryRuns();
    return NextResponse.json({ runs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { comfyuiHealthy } from "@/lib/services/comfyui-client";

/** Read-only health check for the local ComfyUI instance (AI_PROVIDER=local, video
 *  backend). Mirrors /api/flow-browser's GET — never spends anything, never launches
 *  anything (unlike the Flow route's POST, there is no local process for this app to
 *  start; ComfyUI is expected to already be running). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureInit();
  return NextResponse.json(await comfyuiHealthy());
}

import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getAvatar } from "@/lib/avatars";
import { getLogs } from "@/lib/logger";
import { avatarLogId } from "@/lib/services/heygen-avatar";

export const runtime = "nodejs";

/** Diagnostics for one avatar's HeyGen ingest (reuses the run-log store). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const avatar = getAvatar(Number(id));
  if (!avatar) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ status: avatar.status, error: avatar.error, logs: getLogs(avatarLogId(avatar.id)) });
}

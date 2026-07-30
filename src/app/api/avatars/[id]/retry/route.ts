import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getAvatar, updateAvatar } from "@/lib/avatars";
import { getSetting } from "@/lib/settings";
import { ingestAvatar } from "@/lib/services/heygen-avatar";

export const runtime = "nodejs";

/** Re-run HeyGen ingest for an avatar that errored or got stuck. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const avatar = getAvatar(Number(id));
  if (!avatar) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!getSetting("HEYGEN_API_KEY")) {
    return NextResponse.json({ error: "Add your HeyGen API key in Settings first." }, { status: 400 });
  }
  updateAvatar(avatar.id, { status: "pending", error: null });
  ingestAvatar(avatar.id).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("avatar retry crash", e);
  });
  return NextResponse.json(getAvatar(avatar.id));
}

import { NextResponse } from "next/server";
import fs from "node:fs";
import { ensureInit } from "@/lib/init";
import { getAvatar, deleteAvatar } from "@/lib/avatars";
import { heygenDelete } from "@/lib/services/heygen-client";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const avatar = getAvatar(Number(id));
  if (!avatar) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(avatar);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const avatar = getAvatar(Number(id));
  if (!avatar) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Free the HeyGen slot too — plans cap photo avatars at a few, and a slot
  // held by a deleted avatar blocks creating new ones ("exceeded your limit").
  // Best-effort: a HeyGen hiccup must not prevent the local delete.
  if (avatar.engine === "talking_photo" && avatar.heygen_id) {
    try {
      await heygenDelete(`/v2/talking_photo/${encodeURIComponent(avatar.heygen_id)}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("HeyGen talking_photo cleanup failed:", (e as Error).message);
    }
  }
  // Best-effort cleanup of the local reference image.
  if (avatar.ref_image_path && fs.existsSync(avatar.ref_image_path)) {
    try {
      fs.unlinkSync(avatar.ref_image_path);
    } catch {}
  }
  deleteAvatar(avatar.id);
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getAvatar } from "@/lib/avatars";

export const runtime = "nodejs";

/** Serves an avatar's local reference image for the library thumbnail. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const avatar = getAvatar(Number(id));
  // Local reference image (uploaded / text-generated avatars).
  if (avatar?.ref_image_path && fs.existsSync(avatar.ref_image_path)) {
    const buf = fs.readFileSync(avatar.ref_image_path);
    const ext = path.extname(avatar.ref_image_path).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": type, "Cache-Control": "no-store" },
    });
  }
  // No local file (e.g. an imported HeyGen avatar) — redirect to its HeyGen preview image.
  if (avatar?.preview_url) {
    return NextResponse.redirect(avatar.preview_url, 302);
  }
  return NextResponse.json({ error: "No image" }, { status: 404 });
}

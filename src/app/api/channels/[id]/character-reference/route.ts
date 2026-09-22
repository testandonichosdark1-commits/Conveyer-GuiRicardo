import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { DATA_DIR } from "@/lib/run-paths";
import { getChannel, setChannelCharacterReference } from "@/lib/channels";

export const runtime = "nodejs";

/**
 * Per-channel character reference — same contract as
 * /api/settings/character-reference, scoped to ONE channel instead of the global
 * AI_CHARACTER_REFERENCE_PATH. A channel with its own portrait here overrides the
 * global one for every run created on it (see channels.ts channelSettingOverrides()
 * and studio-pipeline.ts activateChannelOverrides()); a channel with none falls back
 * to the global setting exactly as before this feature existed.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

function refDir(channelId: number): string {
  const dir = path.join(DATA_DIR, "channels", String(channelId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extFor(file: File): string {
  const type = (file.type || "").toLowerCase();
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  return ".jpg";
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function removeOldReferences(dir: string, keep?: string): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("character-reference.")) continue;
    const full = path.join(dir, name);
    if (keep && path.resolve(full) === path.resolve(keep)) continue;
    try { fs.unlinkSync(full); } catch {}
  }
}

/** Serves this channel's persisted portrait to the Channels page preview. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const channel = getChannel(Number(id));
  const filePath = channel?.character_reference_path?.trim();
  if (!channel || !filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "No character reference image configured for this channel." }, { status: 404 });
  }
  try {
    const buf = fs.readFileSync(filePath);
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": mimeFor(filePath), "Cache-Control": "no-store, max-age=0" },
    });
  } catch (e) {
    return NextResponse.json({ error: `Failed to read character reference: ${(e as Error).message}` }, { status: 500 });
  }
}

/** Upload/replace this channel's portrait. The file stays local. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const cid = Number(id);
  if (!getChannel(cid)) return NextResponse.json({ error: "Channel not found." }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with an image." }, { status: 400 });
  }
  const value = form.get("image");
  if (!(value instanceof File) || value.size <= 0) {
    return NextResponse.json({ error: "Choose a JPEG, PNG, or WebP image." }, { status: 400 });
  }
  if (value.size > MAX_BYTES) {
    return NextResponse.json({ error: "Reference image must be 10 MB or smaller." }, { status: 400 });
  }
  const type = (value.type || "").toLowerCase();
  if (type && !ALLOWED.has(type)) {
    return NextResponse.json({ error: "Reference image must be JPEG, PNG, or WebP." }, { status: 400 });
  }

  const dir = refDir(cid);
  const dest = path.join(dir, `character-reference${extFor(value)}`);
  try {
    const buf = Buffer.from(await value.arrayBuffer());
    fs.writeFileSync(dest, buf);
    removeOldReferences(dir, dest);
    setChannelCharacterReference(cid, dest);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: `Failed to save reference image: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const cid = Number(id);
  const channel = getChannel(cid);
  if (channel?.character_reference_path) {
    try { fs.unlinkSync(channel.character_reference_path); } catch {}
  }
  removeOldReferences(refDir(cid));
  setChannelCharacterReference(cid, null);
  return NextResponse.json({ ok: true });
}

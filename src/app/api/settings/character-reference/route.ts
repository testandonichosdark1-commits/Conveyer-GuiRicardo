import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { DATA_DIR } from "@/lib/run-paths";
import { getSetting, setSetting } from "@/lib/settings";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

function refDir(): string {
  const dir = path.join(DATA_DIR, "settings");
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

function currentPath(): string {
  return (getSetting("AI_CHARACTER_REFERENCE_PATH") || "").trim();
}

function removeOldReferences(keep?: string): void {
  const dir = refDir();
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("ai-character-reference.")) continue;
    const full = path.join(dir, name);
    if (keep && path.resolve(full) === path.resolve(keep)) continue;
    try { fs.unlinkSync(full); } catch {}
  }
}

/** Serves the locally persisted character portrait to the Settings preview. */
export async function GET() {
  ensureInit();
  const filePath = currentPath();
  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "No character reference image configured." }, { status: 404 });
  }
  try {
    const buf = fs.readFileSync(filePath);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": mimeFor(filePath),
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `Failed to read character reference: ${(e as Error).message}` }, { status: 500 });
  }
}

/** Upload/replace the default character portrait. The file stays local; kie.ai gets
 * a temporary copy only when a matching AI beat actually needs image-to-image. */
export async function POST(req: Request) {
  ensureInit();
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

  const dest = path.join(refDir(), `ai-character-reference${extFor(value)}`);
  try {
    const buf = Buffer.from(await value.arrayBuffer());
    fs.writeFileSync(dest, buf);
    removeOldReferences(dest);
    setSetting("AI_CHARACTER_REFERENCE_PATH", dest);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: `Failed to save reference image: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function DELETE() {
  ensureInit();
  const filePath = currentPath();
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }
  removeOldReferences();
  setSetting("AI_CHARACTER_REFERENCE_PATH", "");
  return NextResponse.json({ ok: true });
}

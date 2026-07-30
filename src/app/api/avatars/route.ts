import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/run-paths";
import { ensureInit } from "@/lib/init";
import { listAvatars, createAvatar, getAvatar, updateAvatar, type AvatarEngine } from "@/lib/avatars";
import { ingestAvatar, verifyHeygenAvatar } from "@/lib/services/heygen-avatar";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";

function avatarsDir(): string {
  const dir = path.join(DATA_DIR, "avatars");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extFor(file: File): string {
  const t = (file.type || "").toLowerCase();
  if (t.includes("png")) return ".png";
  if (t.includes("webp")) return ".webp";
  const fromName = path.extname(file.name || "").toLowerCase();
  if (fromName === ".png" || fromName === ".webp" || fromName === ".jpg" || fromName === ".jpeg") {
    return fromName === ".jpeg" ? ".jpg" : fromName;
  }
  return ".jpg";
}

export async function GET() {
  ensureInit();
  return NextResponse.json(listAvatars());
}

export async function POST(req: Request) {
  ensureInit();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with an image." }, { status: 400 });
  }

  const name = String(form.get("name") || "").trim();
  if (!name) return NextResponse.json({ error: "Avatar name is required." }, { status: 400 });

  // Pre-flight: HeyGen is required for any avatar. Without this check a missing
  // key produced a silent failure deep in the background ingest, which read to
  // the user as "the button does nothing / it's stuck". Fail loud and early.
  if (!getSetting("HEYGEN_API_KEY")) {
    return NextResponse.json(
      { error: "Add your HeyGen API key in Settings before creating an avatar (Settings → HeyGen — API key)." },
      { status: 400 }
    );
  }

  // Import path: register an EXISTING HeyGen avatar by its id (one the operator made
  // directly on HeyGen) — no upload, no ingest, no training. Store the id + engine and
  // mark it ready so the pipeline can use it immediately. importType "talking_photo"
  // → talking_photo_id (talking_photo engine); anything else → avatar_id (rendered via
  // character.type "avatar", our photo_avatar_group path).
  const importHeygenId = String(form.get("heygenId") || "").trim();
  if (importHeygenId) {
    const pickedEngine: AvatarEngine =
      String(form.get("importType") || "avatar") === "talking_photo" ? "talking_photo" : "photo_avatar_group";
    // Verify the id against the HeyGen account so "Ready" means "real + checked",
    // and auto-correct the type from what HeyGen actually reports. Only reject when
    // HeyGen returns a real list that DOESN'T contain the id (a genuine typo/fake);
    // a network hiccup falls through and registers it unverified.
    const check = await verifyHeygenAvatar(importHeygenId);
    if (check.authError) {
      return NextResponse.json(
        { error: "Couldn't verify the avatar — HeyGen rejected your API key (401 Unauthorized). Fix your HeyGen API key in Settings, then import again." },
        { status: 400 }
      );
    }
    if (check.checked && check.engine === null) {
      return NextResponse.json(
        { error: `HeyGen has no avatar or talking-photo with the id "${importHeygenId}" on your account. Copy the id exactly from HeyGen (it's a long code) and try again.` },
        { status: 400 }
      );
    }
    const importEngine: AvatarEngine = check.engine ?? pickedEngine;
    const chIdRaw = String(form.get("channelId") || "").trim();
    let importedId: number;
    try {
      importedId = createAvatar({
        name,
        description: String(form.get("description") || "").trim() || null,
        engine: importEngine,
        use_avatar_iv: String(form.get("useAvatarIv") || "") === "1",
        channel_id: chIdRaw ? Number(chIdRaw) : null,
        status: "ready",
      });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 409 });
    }
    // For a trained-group id, verify resolves it to a renderable look avatar_id — store
    // that (the group id itself isn't a usable video handle); plain ids store as-is.
    updateAvatar(importedId, { heygen_id: check.resolvedId ?? importHeygenId, preview_url: check.previewUrl ?? null, status: "ready", error: null });
    return NextResponse.json(getAvatar(importedId));
  }

  // A text-description avatar also needs kie.ai to generate the reference photo.
  const wantsGenerated = !(form.get("image") instanceof File && (form.get("image") as File).size > 0);
  if (wantsGenerated && String(form.get("description") || "").trim() && !getSetting("KIE_API_KEY")) {
    return NextResponse.json(
      { error: "A text-description avatar needs a kie.ai API key (to generate the photo). Add it in Settings, or upload a reference photo instead." },
      { status: 400 }
    );
  }

  const imageVal = form.get("image");
  const hasImage = imageVal instanceof File && imageVal.size > 0;
  const description = String(form.get("description") || "").trim() || null;

  // Per the mockup: create from a reference IMAGE **or** a text DESCRIPTION
  // (the description is turned into an image via kie.ai nano-banana during ingest).
  if (!hasImage && !description) {
    return NextResponse.json(
      { error: "Provide a reference image or a text description." },
      { status: 400 }
    );
  }

  const engineRaw = String(form.get("engine") || "talking_photo");
  const engine: AvatarEngine = engineRaw === "photo_avatar_group" ? "photo_avatar_group" : "talking_photo";
  const motionPrompt = String(form.get("motionPrompt") || "").trim() || null;
  const useAvatarIv = String(form.get("useAvatarIv") || "") === "1";
  const channelIdRaw = String(form.get("channelId") || "").trim();
  const channelId = channelIdRaw ? Number(channelIdRaw) : null;

  let id: number;
  try {
    id = createAvatar({
      name,
      description,
      engine,
      motion_prompt: motionPrompt,
      use_avatar_iv: useAvatarIv,
      channel_id: channelId,
      status: "pending",
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }

  // Persist a local copy of an uploaded reference image (UI thumbnail + HeyGen
  // source). For text-only avatars, ingestAvatar generates the image instead.
  if (hasImage) {
    const image = imageVal as File;
    const ext = extFor(image);
    const imgPath = path.join(avatarsDir(), `${id}${ext}`);
    try {
      const buf = Buffer.from(await image.arrayBuffer());
      fs.writeFileSync(imgPath, buf);
      updateAvatar(id, { ref_image_path: imgPath });
    } catch (e) {
      updateAvatar(id, { status: "error", error: `Failed to save reference image: ${(e as Error).message}` });
      return NextResponse.json({ error: "Failed to save reference image." }, { status: 500 });
    }
  }

  // Ingest into HeyGen in the background; the UI polls /api/avatars/[id] for status.
  ingestAvatar(id).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("avatar ingest crash", e);
  });

  return NextResponse.json(getAvatar(id));
}

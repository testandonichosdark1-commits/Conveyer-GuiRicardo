import { NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { listVoiceProfiles, createClonedProfile, createPresetProfile } from "@/lib/services/voicebox-client";

export const runtime = "nodejs";

/** GET /api/voices/voicebox — raw voice profile list (Voicebox's own store, not
 *  this app's DB). Consumed as-is by /voices and VoiceSelect; the Settings-page
 *  VoicePicker (settings quick-pick) reshapes it client-side. Empty array (not
 *  an error) when VOICEBOX_DIR isn't set yet, so /voices renders cleanly. */
export async function GET() {
  ensureInit();
  if (!getSetting("VOICEBOX_DIR")) return NextResponse.json([]);
  try {
    return NextResponse.json(await listVoiceProfiles());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

const CLONING_ENGINES = new Set(["chatterbox", "chatterbox_turbo", "luxtts"]);

/** POST /api/voices/voicebox — create a preset or cloned voice profile (multipart/form-data). */
export async function POST(req: Request) {
  ensureInit();
  if (!getSetting("VOICEBOX_DIR")) {
    return NextResponse.json(
      { error: "Set VOICEBOX_DIR (path to your Voicebox checkout) in /settings and run `npm run setup:voicebox` first." },
      { status: 400 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const name = String(form.get("name") || "").trim();
  if (!name) return NextResponse.json({ error: "Voice name is required." }, { status: 400 });
  const engine = String(form.get("engine") || "kokoro").trim();

  try {
    if (CLONING_ENGINES.has(engine)) {
      const sampleVal = form.get("sample");
      const referenceText = String(form.get("referenceText") || "").trim();
      if (!(sampleVal instanceof File) || sampleVal.size === 0) {
        return NextResponse.json({ error: "Upload a 10-30s reference audio sample to clone a voice." }, { status: 400 });
      }
      if (!referenceText) {
        return NextResponse.json({ error: "Provide the reference text (what the sample says)." }, { status: 400 });
      }
      const tmpPath = path.join(os.tmpdir(), `voice-sample-${Date.now()}-${sampleVal.name || "sample.wav"}`);
      fs.writeFileSync(tmpPath, Buffer.from(await sampleVal.arrayBuffer()));
      try {
        const id = await createClonedProfile(name, engine, tmpPath, referenceText);
        return NextResponse.json({ id });
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    } else {
      const voiceId = String(form.get("presetVoiceId") || "").trim();
      if (!voiceId) return NextResponse.json({ error: "Pick a preset voice." }, { status: 400 });
      const id = await createPresetProfile(name, engine, voiceId);
      return NextResponse.json({ id });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

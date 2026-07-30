import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { listVoiceProfiles, createPresetProfile } from "@/lib/services/voicebox-client";
import { KOKORO_STARTER_VOICES } from "@/lib/services/voicebox-starter-voices";

export const runtime = "nodejs";

/** POST /api/voices/voicebox/seed — one-click "starter pack": creates the 10
 *  female + 10 male Kokoro preset profiles that aren't already present (matched
 *  by preset_voice_id, so re-clicking after a partial failure only fills gaps). */
export async function POST() {
  ensureInit();
  if (!getSetting("VOICEBOX_DIR")) {
    return NextResponse.json(
      { error: "Set VOICEBOX_DIR (path to your Voicebox checkout) in /settings and run `npm run setup:voicebox` first." },
      { status: 400 }
    );
  }

  let existing: Awaited<ReturnType<typeof listVoiceProfiles>>;
  try {
    existing = await listVoiceProfiles();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
  const already = new Set(existing.filter((p) => p.preset_engine === "kokoro").map((p) => p.preset_voice_id));

  let created = 0;
  const errors: string[] = [];
  for (const v of KOKORO_STARTER_VOICES) {
    if (already.has(v.voiceId)) continue;
    try {
      await createPresetProfile(`${v.name} (${v.gender === "female" ? "F" : "M"})`, "kokoro", v.voiceId);
      created++;
    } catch (e) {
      errors.push(`${v.name}: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({ created, skipped: KOKORO_STARTER_VOICES.length - created - errors.length, errors });
}

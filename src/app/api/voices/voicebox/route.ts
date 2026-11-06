import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { listVoiceboxProfiles, voiceboxBaseUrl } from "@/lib/services/voicebox";

export const runtime = "nodejs";

/**
 * List the operator's Voicebox voice profiles for the "Load voices" picker.
 *
 * Voicebox keeps an internal "Imported Audio" profile (`voice_type: "import"`) that only
 * exists to hold clips dropped into its story timeline — it has no voice to clone, so it
 * is left out of the list.
 */
export async function GET() {
  ensureInit();
  const base = voiceboxBaseUrl();
  try {
    const profiles = await listVoiceboxProfiles(base);
    const voices = profiles
      .filter((p) => p.id && p.voice_type !== "import")
      .map((p) => ({
        voice_id: p.id,
        name: `${p.name || p.id}${p.language ? ` · ${p.language}` : ""}${p.voice_type ? ` · ${p.voice_type}` : ""}`,
      }));
    return NextResponse.json({ voices });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

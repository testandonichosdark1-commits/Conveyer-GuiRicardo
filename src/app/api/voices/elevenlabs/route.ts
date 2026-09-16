import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { voiceListingError } from "@/lib/voice-catalogue-detail";

export const runtime = "nodejs";

/** List ElevenLabs voices for the "Charger les voix" picker. */
export async function GET() {
  ensureInit();
  const key = getSetting("ELEVENLABS_API_KEY");
  if (!key) return NextResponse.json({ error: "ELEVENLABS_API_KEY not set" }, { status: 400 });
  try {
    const r = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
      headers: { "xi-api-key": key },
    });
    // Keep ElevenLabs' own words. A 401 here is most often a key that works fine for
    // narration but was issued without the `voices_read` scope, and only they can say so —
    // reported as a bare "ElevenLabs 401" it reads as a dead key.
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return NextResponse.json({ error: voiceListingError("ElevenLabs", r.status, body) }, { status: 502 });
    }
    const j = (await r.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] };
    const voices = (j.voices ?? []).map((v) => ({
      voice_id: v.voice_id,
      name: v.name + (v.labels?.gender ? ` (${v.labels.gender})` : ""),
    }));
    return NextResponse.json({ voices });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

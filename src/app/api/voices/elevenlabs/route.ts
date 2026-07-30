import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";

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
    if (!r.ok) return NextResponse.json({ error: `ElevenLabs ${r.status}` }, { status: 502 });
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

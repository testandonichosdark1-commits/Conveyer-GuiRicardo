import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";

/** List HeyGen voices for the "Charger les voix" picker. */
export async function GET() {
  ensureInit();
  const key = getSetting("HEYGEN_API_KEY");
  if (!key) return NextResponse.json({ error: "HEYGEN_API_KEY not set" }, { status: 400 });
  try {
    const r = await fetch("https://api.heygen.com/v2/voices", {
      headers: { "X-Api-Key": key, Accept: "application/json" },
    });
    if (!r.ok) return NextResponse.json({ error: `HeyGen ${r.status}` }, { status: 502 });
    const j = (await r.json()) as {
      data?: { voices?: { voice_id: string; name?: string; language?: string; gender?: string }[] };
    };
    const voices = (j.data?.voices ?? []).slice(0, 400).map((v) => ({
      voice_id: v.voice_id,
      name: `${v.name ?? v.voice_id}${v.language ? ` · ${v.language}` : ""}${v.gender ? ` · ${v.gender}` : ""}`,
    }));
    return NextResponse.json({ voices });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

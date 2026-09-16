import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { listAllAi33Voices, AI33_DEFAULT_BASE } from "@/lib/services/ai33-voices";

export const runtime = "nodejs";

/**
 * List ai33.pro voices for the "Load voices" picker.
 *
 * Unlike /api/voices/ai84 this route takes NO engine parameter, and that difference is the
 * whole design: an ai33 voice id is `"<engine>:<id>"`, so a picked voice already names its
 * engine and nothing further has to be selected, stored or kept in sync. AI84 needs the
 * parameter only because its engine lives in a separate setting that can disagree with the
 * voice — the exact state this provider cannot express.
 */
export async function GET() {
  ensureInit();
  const key = getSetting("AI33_API_KEY");
  if (!key) return NextResponse.json({ error: "AI33_API_KEY not set" }, { status: 400 });
  const base = (getSetting("AI33_BASE_URL") || AI33_DEFAULT_BASE).replace(/\/+$/, "");
  try {
    return NextResponse.json({ voices: await listAllAi33Voices(key, base) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

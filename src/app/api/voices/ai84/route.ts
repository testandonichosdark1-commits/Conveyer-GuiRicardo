import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { listMinimaxVoices, listElevenVoices, listAllAi84Voices } from "@/lib/services/ai84-voices";

export const runtime = "nodejs";

/**
 * List AI84 voices for the "Load voices" picker.
 *
 * AI84 fronts TWO engines with separate voice libraries, and the picker must show only
 * what the currently-selected MODEL can accept: a MiniMax voice chosen while an
 * `eleven_*` model is set produces exactly the `VOICE_NOT_FOUND_LOCAL` this work exists
 * to prevent. Hence `?backend=elevenlabs|minimax`.
 *
 * The default is `elevenlabs`, which makes a request with no query byte-identical to what
 * this route returned before the MiniMax engine was supported.
 *
 * `?backend=all` returns BOTH engines in one list, each voice tagged with the engine it
 * belongs to. That is what the video-creation page uses: the operator picks a voice and
 * the run's model is derived from its engine, so nobody has to know the word "engine".
 *
 * The engine is chosen by the CALLER (see `ai84Backend` in providers.ts) — this route
 * deliberately does not know the model catalog, so there is nothing here to drift out of
 * sync with it.
 */
export async function GET(req: Request) {
  ensureInit();
  const key = getSetting("AI84_API_KEY");
  if (!key) return NextResponse.json({ error: "AI84_API_KEY not set" }, { status: 400 });
  const asked = new URL(req.url).searchParams.get("backend");
  try {
    // Anything other than the two new values behaves exactly as before, so a request with
    // no query — which is what the settings picker sends — is byte-identical to what this
    // route has always returned.
    const voices =
      asked === "all" ? await listAllAi84Voices(key)
      : asked === "minimax" ? await listMinimaxVoices(key)
      : await listElevenVoices(key);
    return NextResponse.json({ voices });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

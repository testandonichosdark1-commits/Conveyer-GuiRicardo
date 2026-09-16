/**
 * Which AI84 engine does this voice belong to?
 *
 * AI84 fronts TWO engines with SEPARATE voice libraries, and the model picks the engine —
 * so a voice sent to the wrong one fails, every time, however valid it is. Until now the
 * engine could only follow a voice the operator picked from the create page's list, which
 * carried its own `backend` tag. Every other voice — the one on a channel, the one in
 * Settings, one pasted by hand — ran on whatever the GLOBAL model said. A client with some
 * channels on ElevenLabs and some on MiniMax therefore could not use both: one global
 * setting cannot serve two engines.
 *
 * So the engine is derived from the voice instead of configured. This asks AI84 itself
 * which catalogue the id is in, rather than guessing from its shape: a MiniMax library id
 * (`English_Explanatory_Man`) is not reliably distinguishable from an ElevenLabs one, and a
 * wrong guess costs a failed, already-billed run.
 */

import { isAi84ClonedVoiceId, type Ai84Backend } from "../providers";
import { listAllAi84Voices, type PickerVoice } from "./ai84-voices";

/**
 * How long a fetched catalogue is reused.
 *
 * A cold lookup is 3–6 requests across two engines, and it happens while the operator waits
 * for a run to start, so repeating it per run is not acceptable. Ten minutes is short enough
 * that a voice cloned mid-session is picked up without a restart.
 *
 * This cache is INTERNAL to engine resolution and deliberately does not back
 * `/api/voices/ai84`: the list an operator reads with their eyes must be live, or a voice
 * they cloned a minute ago would appear to be missing.
 */
const CATALOGUE_TTL_MS = 10 * 60_000;

/** Keyed by API key, so switching accounts can't read the previous one's voices. */
const catalogue = new Map<string, { voices: Promise<PickerVoice[]>; ts: number }>();

/** Tests only — the cache is process-lifetime and would otherwise leak between cases. */
export function resetAi84EngineCache() {
  catalogue.clear();
}

/**
 * The account's voices, cached.
 *
 * The PROMISE is cached, not its result: two videos started together is the whole scenario
 * this feature exists for, and both would otherwise fetch the same 730 voices at once.
 *
 * A failure is NOT remembered — it is dropped from the cache so the next run retries. Ten
 * minutes of "we couldn't reach AI84, so this voice has no engine" would turn one network
 * blip into a stretch of runs silently using the wrong engine.
 */
function catalogueFor(apiKey: string): Promise<PickerVoice[]> {
  const hit = catalogue.get(apiKey);
  if (hit && Date.now() - hit.ts <= CATALOGUE_TTL_MS) return hit.voices;
  const entry = { voices: listAllAi84Voices(apiKey), ts: Date.now() };
  catalogue.set(apiKey, entry);
  entry.voices.catch(() => {
    if (catalogue.get(apiKey) === entry) catalogue.delete(apiKey);
  });
  return entry.voices;
}

/**
 * The engine `voiceId` lives on, or **null meaning "unknown"** — never a guess.
 *
 * null leaves the global AI84_MODEL in charge, i.e. exactly today's behaviour. That is the
 * safe outcome and every uncertain case resolves to it:
 *
 *  - the id is in neither catalogue (a private voice, a typo, a listing AI84 doesn't serve);
 *  - the id is in BOTH (the same string on two engines is two different voices —
 *    `listAllAi84Voices` deliberately does not dedup them — so picking one would be us
 *    choosing an engine on the operator's behalf, which is the bug, not the fix);
 *  - anything threw. **Fails open**: an unreachable catalogue must never stop a video being
 *    made, and the run still has the global model to fall back on.
 *
 * A cloned id short-circuits with NO network at all. `user_<n>_voice_<ts>` exists only on
 * MiniMax, so that is a local certainty rather than a lookup.
 */
export async function resolveAi84Backend(
  apiKey: string,
  voiceId: string | null | undefined
): Promise<Ai84Backend | null> {
  const id = (voiceId ?? "").trim();
  if (!id) return null;
  if (isAi84ClonedVoiceId(id)) return "minimax";
  if (!apiKey.trim()) return null;

  let voices: PickerVoice[];
  try {
    voices = await catalogueFor(apiKey);
  } catch {
    return null;
  }

  const engines = new Set<Ai84Backend>();
  for (const v of voices) {
    if (v.voice_id === id && v.backend) engines.add(v.backend);
  }
  return engines.size === 1 ? [...engines][0] : null;
}

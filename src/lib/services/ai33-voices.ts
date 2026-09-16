/**
 * Listing ai33.pro (OpenSpeaker) voices for the "Load voices" picker.
 *
 * ai33 fronts SIX engines behind one key (`clone`, `elevenlabs`, `minimax`, `fishaudio`,
 * `edge`, `vbee`) and `GET /v3/voices` serves one engine per request. The picker asks for
 * all of them and merges the answers, because an operator should never have to know the
 * word "engine" to choose a voice — the engine is already carried inside the id
 * (`"<engine>:<id>"`), so a picked voice needs no second decision.
 *
 * CLONES LEAD. An account's own cloned voices are what a creator opens this list looking
 * for; burying them under several hundred stock voices reads as "my voice is missing",
 * which is the same dead end that made AI84's listing worth fixing.
 *
 * ONE ENGINE FAILING MUST NOT BLANK THE OTHERS — losing your clones because a stock
 * library timed out is the failure this shape exists to prevent. Only when EVERY engine
 * fails is there nothing to say, and then we throw so the route can report the provider's
 * own words instead of showing an empty picker that reads as an empty account.
 *
 * UNVERIFIED CONTRACT: no ai33 key could be obtained (they are issued on donation) and
 * their API document is behind Cloudflare + a login, so the response shape is read
 * tolerantly — see the header of ai33-response.ts. Paging is deliberately capped rather
 * than driven by a `total` field whose name is unknown.
 */
import { AI33_ENGINES, parseVoiceList, type Ai33Engine, type Ai33Voice } from "./ai33-response";
import { voiceListingError } from "../voice-catalogue-detail";

/** Default host. Overridable per install — ai33.pro and openspeaker.ai are the same product. */
export const AI33_DEFAULT_BASE = "https://api.openspeaker.ai";

/**
 * Hard ceiling on pages per engine, same shape as the AI84 and Hume listings. It exists so
 * a bad or missing page count cannot turn one settings click into an unbounded fetch loop.
 */
export const MAX_VOICE_PAGES = 4;
const PAGE_SIZE = 200;

async function getJson(base: string, path: string, apiKey: string): Promise<unknown> {
  // Auth is ElevenLabs-SHAPED (`xi-api-key`), which is not the same as being ElevenLabs —
  // ai33 says itself that synthesis runs through its own bridge, so nothing ElevenLabs-
  // specific may be inferred from this header. Same warning as AI84.
  const r = await fetch(`${base}${path}`, { headers: { "xi-api-key": apiKey } });
  // Carry ai33's own words: a 401 can mean a wrong key OR a key that synthesizes fine but
  // may not list voices, and only they can tell the operator which.
  if (!r.ok) throw new Error(voiceListingError("ai33", r.status, await r.text().catch(() => "")));
  return r.json();
}

/** One engine's voices, paged to the ceiling. Stops as soon as a short page comes back. */
export async function listEngineVoices(apiKey: string, engine: Ai33Engine, base = AI33_DEFAULT_BASE): Promise<Ai33Voice[]> {
  const all: Ai33Voice[] = [];
  for (let page = 1; page <= MAX_VOICE_PAGES; page++) {
    const j = await getJson(base, `/v3/voices?provider=${encodeURIComponent(engine)}&page=${page}&page_size=${PAGE_SIZE}`, apiKey);
    const batch = parseVoiceList(j, engine);
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Every engine's voices in one labelled list — what both the settings picker and the
 * create page consume. Each entry's label names its engine, because ai33 prices engines
 * differently and an operator choosing blind can see neither the engine nor the bill.
 */
export async function listAllAi33Voices(apiKey: string, base = AI33_DEFAULT_BASE): Promise<Ai33Voice[]> {
  const settled = await Promise.allSettled(AI33_ENGINES.map((e) => listEngineVoices(apiKey, e, base)));
  const ok = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<Ai33Voice[]>[];
  if (!ok.length) {
    const first = settled[0] as PromiseRejectedResult | undefined;
    throw new Error((first?.reason as Error)?.message || "ai33 voice listing failed");
  }
  // AI33_ENGINES leads with `clone`, and Promise.allSettled preserves input order, so the
  // operator's own voices are already first — no re-sorting, nothing to keep in sync.
  return ok.flatMap((s) => s.value);
}

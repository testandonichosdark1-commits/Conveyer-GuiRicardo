/**
 * Listing AI84's voices — the MiniMax engine has two sources, and the operator needs both.
 *
 * The whole reason this exists: an account's CLONED voices (`user_<n>_voice_<ts>`) live
 * only on MiniMax, in their own endpoint, and they are the voices an operator actually
 * came looking for. A picker that showed the 695-voice shared library but not the three
 * voices they recorded themselves would read as "my voice is missing" — the same dead end
 * as the original bug.
 *
 * Endpoints verified live 2026-08-12:
 *   GET /v1/minimax/voices/cloned          → { success, data: [{ canonical_voice_id, name, … }] }
 *   GET /v1/minimax/voices?page=&page_size= → { …, data: [...], page, page_size, total }  (total 695)
 *   GET /v1/shared-voices?page_size=100     → { voices: [{ voice_id, name, … }], has_more, last_sort_id }
 *
 * The ElevenLabs side has no cloned-voice endpoint at all, and its `last_sort_id` comes
 * back null, so one request IS its list.
 */

import type { Ai84Backend } from "../providers";
import { voiceListingError } from "../voice-catalogue-detail";

const BASE = "https://api.ai84.pro";

/** What the picker consumes; `voice_id` is MiniMax's `canonical_voice_id` verbatim. */
export interface PickerVoice {
  voice_id: string;
  name: string;
  /**
   * Which engine this voice belongs to. Present only in the combined listing
   * (`?backend=all`), because that is the only caller that has to tell them apart — it
   * feeds the run's model choice. The settings picker asks for one engine at a time and
   * ignores this field.
   */
  backend?: Ai84Backend;
  /** True for the account's OWN cloned voices, so the UI can group them without name-parsing. */
  cloned?: boolean;
}

/**
 * Hard ceiling on library pages. 695 voices at 200/page is 4 requests; the cap stops a
 * bad `total` from turning a settings click into an unbounded fetch loop. Same shape as
 * the Hume listing's page cap.
 */
export const MAX_LIBRARY_PAGES = 4;
const PAGE_SIZE = 200;

interface MinimaxVoice {
  canonical_voice_id?: string;
  name?: string;
  minimax_voice?: { tag_list?: string[] };
}

/** A couple of tags (language / gender) are what let 695 similar names be told apart. */
function labelFor(v: MinimaxVoice, suffix: string): string {
  const tags = (v.minimax_voice?.tag_list ?? []).slice(0, 2).join(", ");
  const base = v.name || v.canonical_voice_id || "(unnamed)";
  return tags ? `${base} (${tags}) · ${suffix}` : `${base} · ${suffix}`;
}

/**
 * Merge the two MiniMax sources into one list.
 *
 * CLONES FIRST, and deduped so a clone that also appears in the library keeps its "your
 * clone" label rather than being buried among 695 stock voices.
 */
export function mergeMinimaxVoices(cloned: MinimaxVoice[], library: MinimaxVoice[]): PickerVoice[] {
  const out: PickerVoice[] = [];
  const seen = new Set<string>();
  for (const v of cloned) {
    const id = v.canonical_voice_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ voice_id: id, name: labelFor(v, "your clone"), backend: "minimax", cloned: true });
  }
  for (const v of library) {
    const id = v.canonical_voice_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ voice_id: id, name: labelFor(v, "library"), backend: "minimax" });
  }
  return out;
}

async function getJson(path: string, apiKey: string): Promise<unknown> {
  const r = await fetch(`${BASE}${path}`, { headers: { "xi-api-key": apiKey } });
  // Carry AI84's own words: a 401 can mean a wrong key OR a key that works for synthesis but
  // isn't allowed to list voices, and only they can tell the operator which.
  if (!r.ok) throw new Error(voiceListingError("AI84", r.status, await r.text().catch(() => "")));
  return r.json();
}

/** The account's own cloned voices. */
async function fetchCloned(apiKey: string): Promise<MinimaxVoice[]> {
  const j = (await getJson("/v1/minimax/voices/cloned", apiKey)) as { data?: MinimaxVoice[] };
  return j.data ?? [];
}

/** The shared MiniMax library, paged to a hard ceiling and stopping on `total`. */
async function fetchLibrary(apiKey: string): Promise<MinimaxVoice[]> {
  const all: MinimaxVoice[] = [];
  for (let page = 1; page <= MAX_LIBRARY_PAGES; page++) {
    const j = (await getJson(`/v1/minimax/voices?page=${page}&page_size=${PAGE_SIZE}`, apiKey)) as {
      data?: MinimaxVoice[];
      total?: number;
    };
    const batch = j.data ?? [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    if (typeof j.total === "number" && all.length >= j.total) break;
  }
  return all;
}

/**
 * Both MiniMax sources, merged. **One side failing must not blank the other** — an
 * operator whose clones load fine should not lose them because the library call timed
 * out, and vice versa. Only when both fail is there nothing to say, and then we throw so
 * the route can report it instead of showing an empty picker that looks like an empty
 * account.
 */
export async function listMinimaxVoices(apiKey: string): Promise<PickerVoice[]> {
  const [cloned, library] = await Promise.allSettled([fetchCloned(apiKey), fetchLibrary(apiKey)]);
  if (cloned.status === "rejected" && library.status === "rejected") {
    throw new Error((cloned.reason as Error)?.message || "AI84 voice listing failed");
  }
  return mergeMinimaxVoices(
    cloned.status === "fulfilled" ? cloned.value : [],
    library.status === "fulfilled" ? library.value : []
  );
}

interface ElevenVoice {
  voice_id?: string;
  name?: string;
  gender?: string;
  accent?: string;
  language?: string;
}

/**
 * The ElevenLabs engine's shared library. `/v1/shared-voices` is the ONLY voice listing
 * AI84 serves for it — every ElevenLabs-shaped path (`/v2/voices`, `/v1/voices`) 404s —
 * and `last_sort_id` returns null, so there is no cursor to page with.
 */
export async function listElevenVoices(apiKey: string): Promise<PickerVoice[]> {
  const j = (await getJson("/v1/shared-voices?page_size=100", apiKey)) as { voices?: ElevenVoice[] };
  return (j.voices ?? [])
    .filter((v) => v.voice_id)
    .map((v) => {
      const tags = [v.gender, v.accent, v.language].filter(Boolean).join(", ");
      return {
        voice_id: v.voice_id!,
        name: tags ? `${v.name} (${tags})` : v.name || v.voice_id!,
        backend: "elevenlabs" as const,
      };
    });
}

/**
 * BOTH engines in one list — what the video-creation page offers, so the operator picks a
 * voice without ever having to know the word "engine". The run's model is then derived
 * from the chosen voice's `backend`.
 *
 * Order is the point: the account's own clones first, then the MiniMax library, then the
 * ElevenLabs library. A creator opens this list looking for the voice they recorded.
 *
 * NO DEDUP BETWEEN ENGINES. The same id on two engines is two different voices, and
 * collapsing them would silently pick an engine for the operator.
 *
 * One engine failing must NOT blank the other — losing your clones because a stock library
 * timed out is the same dead end as not listing them at all. Only when both fail is there
 * nothing to say, and then we throw so the caller can report it rather than show an empty
 * list that reads as an empty account.
 */
export async function listAllAi84Voices(apiKey: string): Promise<PickerVoice[]> {
  const [minimax, eleven] = await Promise.allSettled([listMinimaxVoices(apiKey), listElevenVoices(apiKey)]);
  if (minimax.status === "rejected" && eleven.status === "rejected") {
    throw new Error((minimax.reason as Error)?.message || "AI84 voice listing failed");
  }
  return [
    ...(minimax.status === "fulfilled" ? minimax.value : []),
    ...(eleven.status === "fulfilled" ? eleven.value : []),
  ];
}

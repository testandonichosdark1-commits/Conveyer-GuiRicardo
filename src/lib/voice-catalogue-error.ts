/**
 * Why a provider's voice list didn't load.
 *
 * The `/api/voices/*` routes already answer this precisely — `ElevenLabs 401`,
 * `AI84_API_KEY not set`, `HeyGen 502` — and the UI used to throw that away and print one
 * impersonal "couldn't load the voices" for every cause. The cost is real and was paid: an
 * expired key looked identical to a broken deploy, and the owner spent an evening suspecting
 * the wrong git branch instead of reading "your key was rejected". A client hitting the same
 * screen doesn't investigate at all — they message us.
 *
 * Deliberately text-free. It returns a REASON, and the component renders the bilingual
 * wording, which is how every other message in this UI works. Keeping it pure is also what
 * makes it testable without a browser.
 */

export type VoiceCatalogueProblem =
  /** No API key is configured for the provider at all. */
  | "no_key"
  /**
   * The key is VALID but wasn't granted the scope needed to list voices. Narration keeps
   * working — telling this operator their key was "rejected" sends them to replace a key
   * that is doing its job.
   */
  | "no_permission"
  /** A key exists and the provider refused it outright — 401/403. */
  | "rejected"
  /** Anything else: the provider erred, timed out, or the request never landed. */
  | "unreachable";

export function classifyVoiceCatalogueError(message: string | null | undefined): VoiceCatalogueProblem {
  const m = (message ?? "").trim();
  if (!m) return "unreachable";
  // The routes phrase this one identically for every provider ("<KEY> not set"), which is
  // what makes matching on the words safe here.
  if (/not set/i.test(m)) return "no_key";
  // BEFORE the 401 check, because a missing scope IS reported as 401. Measured on a live
  // account: "The API key you used is missing the permission voices_read to execute this
  // operation." — same status code, opposite remedy.
  if (/missing[_ ]permissions?|missing the permission|insufficient[_ ]permissions?|scope/i.test(m))
    return "no_permission";
  // Matched as a standalone number so a 401 in the middle of a body excerpt still counts,
  // while an id or a byte count that merely contains "401" does not.
  if (/\b(401|403)\b/.test(m) || /unauthor|forbidden|invalid[_ -]?api[_ -]?key/i.test(m)) return "rejected";
  return "unreachable";
}

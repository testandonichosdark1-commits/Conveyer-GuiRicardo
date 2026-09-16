/**
 * What a finished run failed to deliver.
 *
 * `runs.degraded` holds a comma-joined list of these codes (empty/NULL = the run delivered
 * everything it promised). It is a LIST because the failures are independent: a run can lose
 * its avatar AND its text cards in the same pass, and collapsing that to one code would let
 * the badge quietly under-report. Legacy rows hold a single bare code, which parses as a
 * one-element list — no migration needed.
 *
 * Pure data + strings, deliberately free of any DB import, so the client run pages can share
 * it with the pipeline instead of each restating the wording and drifting apart.
 */
export type DegradeCode = "avatar_all" | "avatar_partial" | "overlays_missing";

/** Severity order — worst first. Drives both the badge tooltip and the banner order. */
const ORDER: DegradeCode[] = ["avatar_all", "avatar_partial", "overlays_missing"];

export const DEGRADE_TEXT: Record<DegradeCode, { short: string; heading: string; detail: string }> = {
  avatar_all: {
    short: "the final video has NO avatar footage",
    heading: "no avatar footage",
    detail:
      "The video rendered, but every avatar beat failed, so it contains no avatar — b-roll was used throughout. " +
      "The usual cause is that the avatar no longer exists on your HeyGen account. Check it on the Avatars page, then create the video again.",
  },
  avatar_partial: {
    short: "some beats fell back to b-roll",
    heading: "some beats have no avatar",
    detail:
      "The video rendered, but the avatar failed on some beats and b-roll was used instead for those. " +
      "See the log below for which ones and why.",
  },
  overlays_missing: {
    short: "text cards were requested but none were produced",
    heading: "no text cards",
    detail:
      "Text mode was on, but the plan produced no cards, so the video has none. " +
      "The usual cause is the Google Gemini key being out of quota — Gemini is what writes the card text. " +
      "Check the log for a quota error, then fix the key in Settings and create the video again.",
  },
};

/** Decode a stored value into known codes, worst first. Unknown/blank entries are dropped. */
export function parseDegraded(raw: string | null | undefined): DegradeCode[] {
  if (!raw) return [];
  const found = new Set(raw.split(",").map((s) => s.trim()));
  return ORDER.filter((c) => found.has(c));
}

/** The stored form. Returns null for a clean run so the column stays NULL as it always has. */
export function joinDegraded(codes: DegradeCode[]): string | null {
  const ordered = ORDER.filter((c) => codes.includes(c));
  return ordered.length ? ordered.join(",") : null;
}

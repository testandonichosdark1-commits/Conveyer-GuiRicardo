/**
 * AI_CHARACTER_REFERENCE_PATH value meaning "this run has NO portrait" — set by
 * channelSettingOverrides() for a channel without its own. A plain "" can't say it: an empty
 * override deliberately falls through to the global value (pinned in
 * channel-settings-override.test.ts), which is exactly how one channel's character used to
 * appear in another channel's video (2026-11-06: a survival-channel presenter composited into
 * a Nineveh excavation shot). Not a path, so it can never resolve to a file.
 *
 * Its own dependency-free module so readers don't pull in settings/db (and the many tests
 * that mock ../settings with only getSetting keep working).
 */
export const NO_CHARACTER_REFERENCE = "none";

/** The stored AI_CHARACTER_REFERENCE_PATH value → the portrait path to use, or "". */
export function resolveCharacterReference(raw: string | null | undefined): string {
  const v = (raw || "").trim();
  return v === NO_CHARACTER_REFERENCE ? "" : v;
}

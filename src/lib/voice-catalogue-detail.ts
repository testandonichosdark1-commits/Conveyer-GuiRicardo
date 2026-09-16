/**
 * Turn a failed voice-listing response into a short error string that keeps the provider's
 * OWN explanation.
 *
 * The routes used to report `ElevenLabs 401` and drop the body, which erases the difference
 * between two situations that call for opposite actions. A real one, measured on an
 * operator's install: their key narrated videos perfectly for weeks, yet the voice list
 * 401'd, because the key was issued without the `voices_read` scope. ElevenLabs says exactly
 * that — "missing the permission voices_read" — and the UI told them their key was rejected,
 * which would have sent them to replace a working key.
 *
 * Server-side and provider-agnostic: it reads whatever JSON shape came back and falls back
 * to raw text.
 */

/** How much of a provider's message to keep. Long enough to name a scope, short enough to read. */
const MAX_DETAIL = 160;

/** Pull the human-readable message out of a provider's error body, whatever it wraps it in. */
function detailFrom(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    // ElevenLabs nests it as detail.message; others use message/error/detail directly.
    const d = j.detail as { message?: string; status?: string } | string | undefined;
    const found =
      (typeof d === "object" && d?.message) ||
      (typeof d === "string" ? d : "") ||
      (typeof j.message === "string" ? j.message : "") ||
      (typeof j.error === "string" ? j.error : "");
    if (found) return String(found).slice(0, MAX_DETAIL);
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return text.slice(0, MAX_DETAIL);
}

/**
 * `"<Provider> <status>: <their words>"`, or just `"<Provider> <status>"` when they said
 * nothing useful. The status stays first so the existing classification (401/403 → refused)
 * keeps working on the same string.
 */
export function voiceListingError(providerLabel: string, status: number, body: string): string {
  const detail = detailFrom(body);
  return detail ? `${providerLabel} ${status}: ${detail}` : `${providerLabel} ${status}`;
}

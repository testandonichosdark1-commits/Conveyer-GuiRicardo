/**
 * Voicebox (github.com/jamiepine/voicebox) — a LOCAL, open-source voice-cloning studio
 * (Qwen3-TTS / Chatterbox / Kokoro / …) the operator runs on their own machine. It exposes
 * a FastAPI server, by default on http://127.0.0.1:17493, with no authentication.
 *
 * Contract read from the Voicebox backend source (backend/routes/*.py), not guessed:
 *   - `GET  /profiles`            → VoiceProfileResponse[] ({id, name, language, voice_type, …})
 *   - `GET  /profiles/{id}`       → one profile, 404 "Profile not found"
 *   - `POST /generate`            → {profile_id, text, language, …} returns IMMEDIATELY with a
 *                                   GenerationResponse whose `status` is "generating"; the
 *                                   synthesis runs on Voicebox's own queue
 *   - `GET  /history/{id}`        → the same row; `status` moves loading_model / generating →
 *                                   "completed" | "failed" (with `error`)
 *   - `GET  /audio/{id}`          → the finished file (WAV for generations)
 *
 * So it is an async create → poll → download provider, like AI84 — but free: no key, no
 * credits, nothing to meter. The engine (qwen, chatterbox, …) is the PROFILE's own default,
 * so there is deliberately no VOICEBOX_ENGINE setting: a second source of truth for which
 * engine a cloned voice uses is the AI84 defect all over again.
 */
import { getSetting } from "../settings";

export const VOICEBOX_DEFAULT_BASE = "http://127.0.0.1:17493";

/** VOICEBOX_URL, else the default local server. Trailing slashes trimmed. */
export function voiceboxBaseUrl(raw: string = getSetting("VOICEBOX_URL")): string {
  const v = (raw || "").trim().replace(/\/+$/, "");
  return v || VOICEBOX_DEFAULT_BASE;
}

export interface VoiceboxProfile {
  id: string;
  name: string;
  language?: string;
  voice_type?: string;
  default_engine?: string | null;
  preset_engine?: string | null;
}

/** Languages Voicebox's GenerationRequest accepts (its pydantic `language` pattern). */
const VOICEBOX_LANGUAGES = new Set(
  "zh en ja ko de fr ru pt es it he ar da el fi hi ms nl no pl sv sw tr".split(" ")
);

/**
 * The language to request for a profile. Voicebox defaults to "en" when the field is
 * omitted, which would make a Portuguese clone read Portuguese text with an English
 * model — so the profile's own language is sent when Voicebox would accept it.
 */
export function voiceboxLanguage(profileLanguage: string | null | undefined): string {
  const l = (profileLanguage || "").trim().toLowerCase().slice(0, 2);
  return VOICEBOX_LANGUAGES.has(l) ? l : "en";
}

export type VoiceboxJobState =
  | { state: "done" }
  | { state: "failed"; error: string }
  | { state: "pending"; status: string };

/** Reads a /history/{id} row. Anything that isn't a terminal status is still running. */
export function readVoiceboxJob(row: { status?: string | null; error?: string | null }): VoiceboxJobState {
  const status = (row.status || "").toLowerCase();
  if (status === "completed") return { state: "done" };
  if (status === "failed" || status === "cancelled") {
    return { state: "failed", error: row.error || `generation ${status}` };
  }
  return { state: "pending", status: status || "unknown" };
}

/**
 * Turns a fetch() that never connected into an operator-readable cause. Voicebox is a
 * desktop app: the overwhelmingly common failure is simply that it isn't open.
 */
export function voiceboxUnreachable(base: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    `Could not reach Voicebox at ${base} (${msg}). Open the Voicebox app (or start its server) ` +
    `on this machine, or set VOICEBOX_URL in Settings if it runs elsewhere.`
  );
}

/** FastAPI errors arrive as {detail: string | [{msg}]}. */
export function voiceboxErrorDetail(raw: string): string {
  try {
    const j = JSON.parse(raw) as { detail?: unknown };
    if (typeof j.detail === "string") return j.detail;
    if (Array.isArray(j.detail)) {
      return j.detail
        .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
        .join("; ");
    }
  } catch {}
  return raw.slice(0, 300);
}

export async function listVoiceboxProfiles(base = voiceboxBaseUrl()): Promise<VoiceboxProfile[]> {
  let r: Response;
  try {
    r = await fetch(`${base}/profiles`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(voiceboxUnreachable(base, e));
  }
  if (!r.ok) throw new Error(`Voicebox ${r.status}: ${voiceboxErrorDetail(await r.text())}`);
  const j = (await r.json()) as unknown;
  return Array.isArray(j) ? (j as VoiceboxProfile[]) : [];
}

/**
 * AI84 create-request bodies — one builder per engine, deliberately NOT unified.
 *
 * AI84 fronts ElevenLabs and MiniMax behind one key, and their create calls agree on
 * almost nothing: different paths, a differently-NAMED voice field (`voice_id` vs
 * `canonical_voice_id`), and tuning that is nested on one side and flat on the other.
 * The overlap is two keys (`text`, `output_format`).
 *
 * This is the same lesson HeyGen v2/v3 taught in heygen-video.ts: a shared builder with
 * per-engine `if`s is the construction that eventually posts `voice_settings` to MiniMax
 * and gets a rejection nobody can read. Two functions, two pinned key sets, no flags.
 *
 * Everything AFTER create is genuinely shared and lives in tts.ts: AI84 serves both kinds
 * of job through the same `GET /v2/text-to-speech/async/{jobId}` poll, so the polling,
 * deadline, transport-retry, credit metering and download are one code path.
 *
 * Every fact below verified live against api.ai84.pro (2026-08-12).
 */

/** Nested ElevenLabs tuning; only set values are sent, `speed` always is. */
export interface ElevenVoiceSettings {
  speed: number;
  style?: number;
  similarity_boost?: number;
  stability?: number;
  use_speaker_boost?: boolean;
}

export interface Ai84CreateRequest {
  /** Path appended to https://api.ai84.pro */
  path: string;
  body: Record<string, unknown>;
}

/**
 * ElevenLabs engine — `POST /v2/text-to-speech/async`, responds **201**.
 *
 * This shape is what every AI84 install has been sending since the provider was added.
 * It is pinned key-for-key by a test: changing it silently re-prices or breaks runs that
 * work today, and nothing about the MiniMax work is a reason to touch it.
 */
export function buildAi84ElevenCreate(opts: {
  text: string;
  voiceId: string;
  modelId: string;
  voiceSettings: ElevenVoiceSettings;
}): Ai84CreateRequest {
  return {
    path: "/v2/text-to-speech/async",
    body: {
      text: opts.text,
      voice_id: opts.voiceId,
      model_id: opts.modelId,
      output_format: "mp3_44100_128",
      voice_settings: opts.voiceSettings,
    },
  };
}

/**
 * MiniMax engine — `POST /v1/minimax/text-to-speech/async`, responds **200** (not 201).
 *
 * Differences that are not guesses:
 *   - the voice field is **`canonical_voice_id`**; omitting it is `400 "canonical_voice_id
 *     is required"`, and sending `voice_id` instead does NOT satisfy it;
 *   - tuning is **flat** (`speed`), not a nested `voice_settings` object;
 *   - `model_id` is OPTIONAL here (the engine falls back to its own default) — we always
 *     send it anyway, because an omitted model is a silent substitution;
 *   - an unknown voice is rejected at create with `404 VOICE_NOT_FOUND` and **no credits
 *     are charged** — the opposite of the ElevenLabs engine, where create succeeds, bills,
 *     and only then fails the job.
 *
 * `style` / `similarity_boost` / `stability` / `use_speaker_boost` are ElevenLabs concepts
 * with no MiniMax equivalent, so they are simply NOT SENT. They are deliberately not
 * mapped onto `pitch`/`volume`: inventing a correspondence would silently substitute the
 * operator's setting for a different one.
 *
 * `pitch` and `volume` are accepted by the API but we send neither — their valid ranges on
 * this proxy are unverified, and a field with an unverified range is an invitation to a
 * 400 in the middle of a paid run. The engine's own defaults are neutral.
 */
export function buildAi84MinimaxCreate(opts: {
  text: string;
  voiceId: string;
  modelId: string;
  speed: number;
}): Ai84CreateRequest {
  return {
    path: "/v1/minimax/text-to-speech/async",
    body: {
      text: opts.text,
      canonical_voice_id: opts.voiceId,
      model_id: opts.modelId,
      output_format: "mp3_44100_128",
      speed: opts.speed,
    },
  };
}

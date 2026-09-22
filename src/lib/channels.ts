import db from "./db";
import { isSecretKey, shortMask, type SettingKey } from "./settings";

/**
 * Channels ("Chaîne") — a simple per-channel defaults bundle the operator picks
 * when creating a video: visual mode, AI image style, seconds-per-visual, output
 * format, an optional default avatar, and a small, DELIBERATELY NARROW override
 * profile — Cloudflare (Account ID + Token), ai33.pro (API key + voice id),
 * character reference portrait, and the AI image style — so a channel can carry a
 * client's own Cloudflare/ai33 accounts + visual identity without touching the
 * global Settings page, which stays the app-wide default for everything else.
 *
 * `voice_provider` is not a general multi-provider selector in the UI (it WAS, but
 * that was more than this app needs — see app/channels/_components/
 * ChannelAi33VoiceField.tsx): the API routes derive it automatically as `"ai33"`
 * whenever `voice_id` is non-empty, else `null`. The column and
 * channelSettingOverrides() stay generic underneath, since nothing about them is
 * ai33-specific — only the UI/route layer narrowed to one provider.
 *
 * Distinct from the inherited `prompt_presets` (scene-split prompts) — this model
 * is intentionally simple.
 */

export type VisualMode = "ai" | "real" | "mix";

export interface Channel {
  id: number;
  name: string;
  visual_mode: VisualMode;
  ai_style: string | null;
  /** Editable guidance for the per-beat visual-query ("split") prompt. NULL = default. */
  visual_prompt: string | null;
  /** Per-channel narration voice id. Historically "whatever the global VOICEOVER_PROVIDER
   *  is" (NULL = that provider's own global voice); the UI now writes an ai33.pro voice id
   *  here specifically (see ChannelAi33VoiceField.tsx) and the API routes set
   *  `voice_provider` to match automatically. NULL = global ELEVENLABS_VOICE_ID (or
   *  whichever provider is globally selected). */
  voice_id: string | null;
  /** Per-channel voiceover speed override. NULL = global TTS_SPEED. */
  voice_speed: number | null;
  /** Which TTS provider `voice_id` is sent to — derived automatically by the API routes
   *  from whether `voice_id` is set ("ai33" when it is, NULL when it's empty), never
   *  chosen directly in the UI. NULL = global VOICEOVER_PROVIDER. Needed because voice_id
   *  alone is provider-blind — see channelSettingOverrides(). */
  voice_provider: string | null;
  /** Absolute path to this channel's own character-reference portrait (managed by
   *  /api/channels/[id]/character-reference, never by updateChannel). NULL = global
   *  AI_CHARACTER_REFERENCE_PATH. */
  character_reference_path: string | null;
  /** JSON object of SETTING_KEY -> override value, restricted to isSecretKey() keys
   *  (enforced on write in channelApiKeyOverrides / the API route). NULL/'{}' = every
   *  global key applies. Raw string — parse with channelApiKeyOverrides(). */
  api_keys_json: string | null;
  interval_sec: number;
  format: string;
  avatar_id: number | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, name, visual_mode, ai_style, visual_prompt, voice_id, voice_speed, voice_provider, " +
  "character_reference_path, api_keys_json, interval_sec, format, avatar_id, created_at, updated_at";
const listStmt = db.prepare(`SELECT ${COLS} FROM channels ORDER BY name COLLATE NOCASE ASC`);
const getStmt = db.prepare(`SELECT ${COLS} FROM channels WHERE id = ?`);
const getByNameStmt = db.prepare(`SELECT ${COLS} FROM channels WHERE name = ?`);
const insertStmt = db.prepare(
  `INSERT INTO channels (name, visual_mode, ai_style, visual_prompt, voice_id, voice_speed, voice_provider, interval_sec, format, avatar_id)
   VALUES (@name, @visual_mode, @ai_style, @visual_prompt, @voice_id, @voice_speed, @voice_provider, @interval_sec, @format, @avatar_id)`
);
const deleteStmt = db.prepare("DELETE FROM channels WHERE id = ?");
// Deliberately SEPARATE from insertStmt/updateStmt below: character_reference_path is
// managed ONLY by the character-reference API route (upload/delete), so it is
// structurally impossible for an ordinary channel-form save (which has no field for it)
// to blank it out.
const setCharacterReferenceStmt = db.prepare(
  "UPDATE channels SET character_reference_path = ?, updated_at = datetime('now') WHERE id = ?"
);

export function listChannels(): Channel[] {
  return listStmt.all() as Channel[];
}
export function getChannel(id: number): Channel | null {
  return (getStmt.get(id) as Channel | undefined) ?? null;
}
export function getChannelByName(name: string): Channel | null {
  return (getByNameStmt.get(name) as Channel | undefined) ?? null;
}

export interface ChannelInput {
  name: string;
  visual_mode?: VisualMode;
  ai_style?: string | null;
  visual_prompt?: string | null;
  voice_id?: string | null;
  voice_speed?: number | null;
  voice_provider?: string | null;
  /** Pre-merged JSON string (the API route resolves masked-vs-real values BEFORE
   *  calling create/update — see /api/channels/[id]/route.ts). */
  api_keys_json?: string | null;
  interval_sec?: number;
  format?: string;
  avatar_id?: number | null;
}

/** ai33 is the only provider the Channels UI lets an operator pin per channel — see the
 *  module doc comment. Whenever a channel's voice_id is non-empty it's an ai33.pro voice
 *  id (ChannelAi33VoiceField.tsx), so voice_provider is derived, never taken from a
 *  client-supplied value. Exported so both API routes (create + update) share one rule. */
export function deriveVoiceProvider(voiceId: string | null | undefined): string | null {
  return voiceId?.trim() ? "ai33" : null;
}

function normMode(m: string | undefined): VisualMode {
  return m === "ai" || m === "real" ? m : "mix";
}

/** Per-channel speed: a finite number is stored as-is (providers clamp to their own range); anything else → NULL (use global TTS_SPEED). */
function normSpeed(s: number | null | undefined): number | null {
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

export function createChannel(input: ChannelInput): number {
  const name = input.name.trim();
  if (!name) throw new Error("Channel name cannot be empty");
  if (getChannelByName(name)) throw new Error(`A channel named "${name}" already exists`);
  const res = insertStmt.run({
    name,
    visual_mode: normMode(input.visual_mode),
    ai_style: input.ai_style?.trim() || null,
    visual_prompt: input.visual_prompt?.trim() || null,
    voice_id: input.voice_id?.trim() || null,
    voice_speed: normSpeed(input.voice_speed),
    voice_provider: input.voice_provider?.trim() || null,
    interval_sec: Number.isFinite(input.interval_sec) ? Number(input.interval_sec) : 4.5,
    format: (input.format || "1920x1080").trim(),
    avatar_id: input.avatar_id ?? null,
  });
  const id = Number(res.lastInsertRowid);
  // api_keys_json has no default in insertStmt (a fresh channel never has overrides worth
  // writing on create — the UI only edits keys on an existing channel), so set it only
  // when the caller actually passed something.
  if (input.api_keys_json) setChannelApiKeysJson(id, input.api_keys_json);
  return id;
}

export function updateChannel(id: number, input: ChannelInput): void {
  const name = input.name.trim();
  if (!name) throw new Error("Channel name cannot be empty");
  db.prepare(
    `UPDATE channels SET name=@name, visual_mode=@visual_mode, ai_style=@ai_style, visual_prompt=@visual_prompt,
       voice_id=@voice_id, voice_speed=@voice_speed, voice_provider=@voice_provider,
       interval_sec=@interval_sec, format=@format, avatar_id=@avatar_id, updated_at=datetime('now')
     WHERE id=@id`
  ).run({
    id,
    name,
    visual_mode: normMode(input.visual_mode),
    ai_style: input.ai_style?.trim() || null,
    visual_prompt: input.visual_prompt?.trim() || null,
    voice_id: input.voice_id?.trim() || null,
    voice_speed: normSpeed(input.voice_speed),
    voice_provider: input.voice_provider?.trim() || null,
    interval_sec: Number.isFinite(input.interval_sec) ? Number(input.interval_sec) : 4.5,
    format: (input.format || "1920x1080").trim(),
    avatar_id: input.avatar_id ?? null,
  });
  // Same reasoning as createChannel: only touched when the caller actually sent it, so a
  // save from a form that doesn't carry api_keys_json (there isn't one today, but future
  // callers might not) can never silently wipe existing overrides.
  if (input.api_keys_json !== undefined) setChannelApiKeysJson(id, input.api_keys_json);
}

export function deleteChannel(id: number): void {
  deleteStmt.run(id);
}

/** A Channel row shaped for the browser: `api_keys_json` (raw plaintext) replaced by
 *  `api_keys` (masked map). Every API route that returns a Channel must send THIS, never
 *  the raw row — api_keys_json is a plaintext-credentials column. */
export function toClientChannel<T extends Channel>(channel: T): Omit<T, "api_keys_json"> & { api_keys: Record<string, string> } {
  const { api_keys_json, ...rest } = channel;
  return { ...rest, api_keys: maskedChannelApiKeys(api_keys_json) };
}

/** Set (or clear, with null/"{}"/"") this channel's character-reference portrait path. */
export function setChannelCharacterReference(id: number, filePath: string | null): void {
  setCharacterReferenceStmt.run(filePath || null, id);
}

/** Raw setter — always writes THROUGH the isSecretKey() filter, so a malformed or
 *  hand-crafted JSON body can never smuggle an override for something that isn't a
 *  credential (e.g. FFMPEG_PATH) onto a channel. */
export function setChannelApiKeysJson(id: number, json: string | null): void {
  const filtered = filterToSecretKeys(json);
  db.prepare("UPDATE channels SET api_keys_json = ?, updated_at = datetime('now') WHERE id = ?").run(
    Object.keys(filtered).length ? JSON.stringify(filtered) : null,
    id
  );
}

/**
 * A tiny, explicit exception list: settings that AREN'T secret-shaped (isSecretKey()
 * would drop them) but that a channel legitimately needs to override alongside a secret
 * they're paired with. CLOUDFLARE_ACCOUNT_ID is not itself a credential — it's the
 * "username" half of the Cloudflare pair, useless without CLOUDFLARE_API_TOKEN next to
 * it, and Cloudflare literally cannot run for a channel without both. Kept as its own
 * named set (not folded into isSecretKey()) so the actual security boundary — "never let
 * a channel override an unrelated setting like FFMPEG_PATH" — stays exactly as narrow as
 * it was, with this one exception reviewed and named rather than a loosened general rule.
 */
const CHANNEL_EXTRA_OVERRIDE_KEYS = new Set<string>(["CLOUDFLARE_ACCOUNT_ID"]);

function isChannelOverridableKey(key: string): boolean {
  return isSecretKey(key) || CHANNEL_EXTRA_OVERRIDE_KEYS.has(key);
}

/** Parse + filter a channel's api_keys_json to ONLY isChannelOverridableKey() settings,
 *  dropping anything else (defensive — belt-and-suspenders alongside the write-time
 *  filter in setChannelApiKeysJson, so a row written by an older/different code path is
 *  still safe to read). Malformed JSON reads as no overrides rather than throwing. */
export function filterToSecretKeys(json: string | null | undefined): Partial<Record<SettingKey, string>> {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Partial<Record<SettingKey, string>> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.trim()) continue;
    if (!isChannelOverridableKey(k)) continue; // silently drop — never let an unrelated key through
    out[k as SettingKey] = v;
  }
  return out;
}

/** Masked view of a channel's API-key overrides, for sending to the browser — same
 *  first4…last4 convention as getMaskedSettings(), so the two never look inconsistent
 *  side by side. Never send api_keys_json itself to a client; send this instead.
 *  CLOUDFLARE_ACCOUNT_ID (the one CHANNEL_EXTRA_OVERRIDE_KEYS entry) is not a credential
 *  — getMaskedSettings() doesn't mask it globally either — so it passes through as-is;
 *  only actual isSecretKey() values are masked. */
export function maskedChannelApiKeys(json: string | null | undefined): Record<string, string> {
  const parsed = filterToSecretKeys(json);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = isSecretKey(k) ? shortMask(v) : v;
  return out;
}

/**
 * Resolve what a channel's api_keys_json should become after an edit, given the MASKED
 * map the client sent back (`incoming`) — the same "don't save the mask over the real
 * value" defense /api/settings applies, adapted for a plain key/value map instead of
 * settings.ts's newline-separated multi-key lists:
 *   - value still contains "…"      -> unchanged, keep whatever is already stored
 *   - value is "" (cleared by hand) -> remove the override (falls back to the global key)
 *   - anything else                 -> a real, newly-typed/edited value; store it
 * Keys are ALSO filtered through isSecretKey() here (not just in setChannelApiKeysJson) so
 * the returned JSON is already safe even if a caller writes it straight to the DB.
 */
export function mergeChannelApiKeys(existingJson: string | null | undefined, incoming: Record<string, string>): string | null {
  const merged: Record<string, string> = { ...filterToSecretKeys(existingJson) };
  for (const [k, v] of Object.entries(incoming)) {
    if (!isChannelOverridableKey(k)) continue;
    const value = (v ?? "").trim();
    // The "…" mask marker only ever applies to a MASKED (secret) field — a plain field
    // like CLOUDFLARE_ACCOUNT_ID is never masked in the first place, so it has no
    // "untouched" state to preserve; a value containing "…" there is just a real value.
    if (isSecretKey(k) && value.includes("…")) continue; // untouched mask — keep merged[k]
    if (!value) {
      delete merged[k]; // explicitly cleared -> fall back to the global key
    } else {
      merged[k] = value;
    }
  }
  return Object.keys(merged).length ? JSON.stringify(merged) : null;
}

/**
 * The full settings-override map for a channel, ready for
 * `setChannelSettingOverrides()` — merges its API-key overrides with the two other
 * columns that also map onto a global SettingKey:
 *   - voice_provider  -> VOICEOVER_PROVIDER (so voice_id is no longer provider-blind)
 *   - character_reference_path -> AI_CHARACTER_REFERENCE_PATH
 * `channel: null` (no channel on this run) returns {} — every global setting applies,
 * unchanged from before this feature existed.
 */
export function channelSettingOverrides(channel: Channel | null): Record<string, string> {
  if (!channel) return {};
  const out: Record<string, string> = { ...filterToSecretKeys(channel.api_keys_json) };
  if (channel.voice_provider?.trim()) out.VOICEOVER_PROVIDER = channel.voice_provider.trim();
  if (channel.character_reference_path?.trim()) out.AI_CHARACTER_REFERENCE_PATH = channel.character_reference_path.trim();
  return out;
}

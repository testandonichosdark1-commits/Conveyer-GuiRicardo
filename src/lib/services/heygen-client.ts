import { getSetting } from "../settings";

/**
 * Shared HeyGen API client — auth + asset upload.
 *
 * HeyGen v1/v2 (supported through 2026-10-31) is what we target; it matches the
 * character/voice/video_inputs shape this app uses. See
 * docs/DESIGN.md for the full confirmed API surface.
 *
 * Auth: `X-Api-Key` header on every call.
 */

const API_BASE = "https://api.heygen.com";
const UPLOAD_BASE = "https://upload.heygen.com";

export function heygenKey(): string {
  const key = getSetting("HEYGEN_API_KEY");
  if (!key) throw new Error("HEYGEN_API_KEY is not set — paste it in /settings.");
  return key;
}

/**
 * fetch with a hard timeout. Bare fetch() has NO timeout, so a stalled HeyGen
 * upload/endpoint would hang forever — leaving an avatar stuck on "Preparing…"
 * with no error and no way to recover. AbortController turns a stall into a
 * clear, catchable error instead.
 */
async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`HeyGen request timed out after ${Math.round(ms / 1000)}s (${url.replace(API_BASE, "").replace(UPLOAD_BASE, "")}). Check your connection and HeyGen status, then retry.`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const UPLOAD_TIMEOUT_MS = 90_000;
const JSON_TIMEOUT_MS = 45_000;

export interface HeygenAsset {
  id: string;
  /** Present for image uploads; required to create a Photo Avatar Group. */
  image_key?: string;
  url?: string;
  file_type?: string;
}

/**
 * Upload a raw asset (image or audio) — `POST upload.heygen.com/v1/asset` with
 * the file as the RAW request body (NOT multipart). Returns the asset metadata:
 *  - audio → use `id` as `audio_asset_id` in video generation
 *  - image → use `image_key` to create a Photo Avatar Group
 */
export async function uploadAsset(bytes: Buffer, contentType: string): Promise<HeygenAsset> {
  const resp = await fetchTimeout(`${UPLOAD_BASE}/v1/asset`, {
    method: "POST",
    headers: { "X-Api-Key": heygenKey(), "Content-Type": contentType },
    body: new Uint8Array(bytes),
  }, UPLOAD_TIMEOUT_MS);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HeyGen asset upload ${resp.status}: ${text.slice(0, 300)}`);
  }
  let json: { code?: number; data?: HeygenAsset; msg?: string | null };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HeyGen asset upload: non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!json.data?.id && !json.data?.image_key) {
    throw new Error(`HeyGen asset upload returned no id/image_key: ${text.slice(0, 300)}`);
  }
  return json.data;
}

export interface TalkingPhoto {
  talking_photo_id: string;
  talking_photo_url?: string;
}

/**
 * Upload a photo as a Talking Photo — `POST upload.heygen.com/v1/talking_photo`
 * (raw image body). Returns a `talking_photo_id` you can use directly as a video
 * character with no training step. A freshly uploaded photo may need a short
 * moderation delay before it can generate.
 */
export async function uploadTalkingPhoto(bytes: Buffer, contentType: string): Promise<TalkingPhoto> {
  const resp = await fetchTimeout(`${UPLOAD_BASE}/v1/talking_photo`, {
    method: "POST",
    headers: { "X-Api-Key": heygenKey(), "Content-Type": contentType },
    body: new Uint8Array(bytes),
  }, UPLOAD_TIMEOUT_MS);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HeyGen talking_photo upload ${resp.status}: ${text.slice(0, 300)}`);
  }
  let json: { code?: number; data?: TalkingPhoto };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HeyGen talking_photo upload: non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!json.data?.talking_photo_id) {
    throw new Error(`HeyGen talking_photo upload returned no talking_photo_id: ${text.slice(0, 300)}`);
  }
  return json.data;
}

/** Authenticated JSON POST to the HeyGen API base. Returns parsed JSON. */
export async function heygenPost<T = unknown>(pathName: string, body: unknown): Promise<T> {
  const resp = await fetchTimeout(`${API_BASE}${pathName}`, {
    method: "POST",
    headers: {
      "X-Api-Key": heygenKey(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  }, JSON_TIMEOUT_MS);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HeyGen ${pathName} ${resp.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`HeyGen ${pathName}: non-JSON response: ${text.slice(0, 200)}`);
  }
}

/**
 * Authenticated DELETE. Used to free HeyGen resources (e.g. talking photos —
 * plans cap them at a few slots, so deleting an avatar here must release its
 * slot there). Throws on HTTP error; callers treat cleanup as best-effort.
 */
export async function heygenDelete(pathWithQuery: string): Promise<void> {
  const resp = await fetchTimeout(`${API_BASE}${pathWithQuery}`, {
    method: "DELETE",
    headers: { "X-Api-Key": heygenKey(), Accept: "application/json" },
  }, JSON_TIMEOUT_MS);
  if (!resp.ok) {
    throw new Error(`HeyGen DELETE ${pathWithQuery} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
}

/** Authenticated GET to the HeyGen API base. Returns parsed JSON. */
export async function heygenGet<T = unknown>(pathWithQuery: string): Promise<T> {
  const resp = await fetchTimeout(`${API_BASE}${pathWithQuery}`, {
    method: "GET",
    headers: { "X-Api-Key": heygenKey(), Accept: "application/json" },
  }, JSON_TIMEOUT_MS);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HeyGen ${pathWithQuery} ${resp.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`HeyGen ${pathWithQuery}: non-JSON response: ${text.slice(0, 200)}`);
  }
}

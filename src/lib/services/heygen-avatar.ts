import fs from "node:fs";
import path from "node:path";
import { getAvatar, updateAvatar, type AvatarEngine, type ApiEngine } from "../avatars";
import { DATA_DIR } from "../run-paths";
import { generateAvatarImage } from "./kie";
import { log } from "../logger";
import { APP_VERSION } from "../version";
import {
  uploadAsset,
  uploadTalkingPhoto,
  heygenPost,
  heygenGet,
  heygenDelete,
} from "./heygen-client";

/**
 * Verify that a HeyGen avatar id actually exists on the account BEFORE we register an
 * imported avatar as "ready" (so "Ready" means "real + checked"), and return the
 * detected engine plus a renderable handle.
 *
 * HeyGen ids come in three shapes across two endpoints:
 *  - a plain avatar or a Talking Photo → GET /v2/avatar/{id}/details (200 + type).
 *  - a TRAINED "Photo Avatar Group" id (what HeyGen shows for Avatar IV / trained
 *    avatars) → /v2/avatar/{id}/details 404s for these; the group only resolves via
 *    GET /v2/avatar_group/{id}/avatars. A group id isn't renderable on its own, so we
 *    resolve it to its first completed LOOK's avatar_id, returned as `resolvedId` —
 *    the handle the caller should actually store.
 *
 * Returns the detected `engine`; `checked: true` + `engine: null` when the id is
 * definitively absent from every avatar type (→ reject the import); `authError` on a
 * bad key; or `checked: false` when we couldn't verify (network hiccup) so the caller
 * registers it unverified rather than false-rejecting a valid id.
 */
export async function verifyHeygenAvatar(
  heygenId: string
): Promise<{ engine: AvatarEngine | null; checked: boolean; authError?: boolean; previewUrl?: string | null; resolvedId?: string | null }> {
  // 1) Direct lookup — resolves a plain avatar OR a talking photo (fast, definitive).
  const direct = await avatarDetails(heygenId);
  if (direct.kind === "found") return { engine: direct.engine, checked: true, previewUrl: direct.previewUrl };
  if (direct.kind === "auth") return { engine: null, checked: false, authError: true };
  if (direct.kind === "unverifiable") return { engine: null, checked: false }; // fail open — don't block a maybe-valid id

  // 2) direct.kind === "absent" (404): the id may be a trained Photo Avatar GROUP
  //    (Avatar IV / trained avatars), which the single-avatar endpoint can't see.
  //    Resolve the group to its first completed look — the actual renderable handle.
  let lookId: string | null;
  try {
    lookId = await firstCompletedLook(heygenId); // null = definitively not a group
  } catch {
    return { engine: null, checked: false }; // transient during group resolution → fail open
  }
  if (lookId) {
    const look = await avatarDetails(lookId);
    const engine: AvatarEngine = look.kind === "found" ? look.engine : "photo_avatar_group";
    const previewUrl = look.kind === "found" ? look.previewUrl : null;
    return { engine, checked: true, previewUrl, resolvedId: lookId };
  }

  // 3) Not an avatar, a talking photo, or a group → genuinely absent → reject.
  return { engine: null, checked: true };
}

/* ─────────────────── Avatar V capability (HeyGen v3) ───────────────────
 * Avatar V is an ENGINE, not an avatar type. HeyGen's own docs say it is Digital-Twin
 * only; the live API disagrees and accepts it for ordinary photo avatars, so this code
 * follows the API, not the docs.
 *
 * Availability is per-avatar and comes from ONE place: `supported_api_engines` on the
 * look. It is derived from server state we cannot see, enumerate, or predict — avatars
 * created through our own upload flow arrive WITHOUT avatar_v, and identical-looking
 * avatars disagree — so it is never inferred and never cached. The current API response
 * is the only authority.
 *
 * v3 shares the host + X-Api-Key auth of v1/v2 (see tts.ts → /v3/voices/speech), so
 * heygenGet works unchanged. Note a v3 look id IS a v2 avatar id — the same avatar seen
 * through two APIs — which is why these ids flow straight into the v2 import path.
 */

/** One HeyGen avatar offered in the Avatar V picker. Every entry already supports it. */
export interface CompatibleAvatar {
  id: string;
  name: string;
  previewUrl: string | null;
}

interface LookJson {
  id?: string;
  name?: string;
  avatar_type?: string;
  preview_image_url?: string | null;
  status?: string;
  supported_api_engines?: string[];
}

/** Avatar V is available only when the look itself lists it. */
function supportsAvatarV(look: LookJson): boolean {
  return Array.isArray(look.supported_api_engines) && look.supported_api_engines.includes("avatar_v");
}

/** `GET /v3/avatars/looks` → `{ data: [...], has_more, next_token }` (cursor at the TOP level). */
interface LooksPage {
  data?: LookJson[] | { looks?: LookJson[] } | null;
  has_more?: boolean;
  next_token?: string | null;
}

/**
 * The endpoint pages at `limit` 1–50 (default 20). We ask for the max and follow
 * `next_token` to the end: a picker that silently showed only the operator's first 20
 * avatars would read as "my avatar is missing from the list", with nothing to indicate
 * a page boundary caused it. MAX_PAGES is a runaway guard, not a product limit — if it
 * ever trips we say so rather than quietly truncate.
 */
const LOOKS_PAGE_SIZE = 50;
const LOOKS_MAX_PAGES = 20; // 1000 avatars

/** Rows on one page that support Avatar V. Filtering here is why the picker can't offer a dud. */
function avatarVCompatible(page: LooksPage): CompatibleAvatar[] {
  // The documented envelope is a bare `data: [...]` (confirmed live); tolerate a
  // {data:{looks:[…]}} shape too, and never throw on a non-array.
  const d = page.data;
  const list: LookJson[] = Array.isArray(d) ? d : Array.isArray(d?.looks) ? d.looks : [];
  return list
    .filter((l): l is LookJson & { id: string } => typeof l.id === "string" && l.id.length > 0)
    .filter(supportsAvatarV)
    .map((l) => ({
      id: l.id,
      name: l.name?.trim() || l.id,
      previewUrl: l.preview_image_url ?? null,
    }));
}

/**
 * The operator's own HeyGen avatars that support Avatar V.
 *
 * Deliberately NOT filtered by avatar_type: Avatar V is an engine, and the live API
 * grants it to ordinary photo avatars despite the docs. The only filter that reflects
 * reality is `supported_api_engines`, which the LIST response already carries — so
 * capability costs no extra call, and an incompatible avatar is never offered.
 *
 * Throws (with HeyGen's own message) so the route can surface auth/rate-limit/network
 * failures; an account with no compatible avatars is an empty list, not an error.
 */
export async function listAvatarVCompatibleAvatars(): Promise<CompatibleAvatar[]> {
  const out: CompatibleAvatar[] = [];
  let token: string | null = null;

  for (let page = 0; page < LOOKS_MAX_PAGES; page++) {
    const q = new URLSearchParams({ ownership: "private", limit: String(LOOKS_PAGE_SIZE) });
    if (token) q.set("token", token);

    const resp = await heygenGet<LooksPage>(`/v3/avatars/looks?${q.toString()}`);
    out.push(...avatarVCompatible(resp));

    if (!resp.has_more || !resp.next_token) return out;
    token = resp.next_token;
  }

  // Ran out of pages before HeyGen ran out of avatars — surface it instead of pretending
  // this is the whole list.
  throw new Error(
    `You have more than ${LOOKS_MAX_PAGES * LOOKS_PAGE_SIZE} avatars on HeyGen — too many to list here. Please contact support.`
  );
}

/**
 * Ask HeyGen, right now, whether this avatar supports Avatar V.
 *
 * The SERVER's authority for the choice — the picker only ever offers compatible
 * avatars, but the client is not trusted to be the gate. Availability is per-avatar and
 * mutable, so this is a live read every time; nothing here is cached.
 *
 * Unlike verifyHeygenAvatar this does NOT fail open. That function guards a *type hint*
 * we can safely guess wrong; this one guards an engine that 400s on every beat if the
 * answer is wrong, mid-run, after the voiceover is paid for. Asking the operator to
 * retry beats registering a choice we never confirmed.
 */
export async function checkAvatarVSupport(
  avatarId: string
): Promise<{ ok: boolean; supported?: boolean; error?: string }> {
  let look: LookJson | null | undefined;
  try {
    const resp = await heygenGet<{ data?: LookJson | null }>(
      `/v3/avatars/looks/${encodeURIComponent(avatarId)}`
    );
    look = resp.data;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b401\b|\b403\b|unauthorized|forbidden/i.test(msg)) {
      return { ok: false, error: "auth" };
    }
    if (/\b429\b|rate_limit_exceeded|rate limit/i.test(msg)) {
      // We DID reach HeyGen and the request was well-formed — they're throttling us.
      // "Couldn't reach HeyGen" would send the operator debugging their network.
      return { ok: false, error: "HeyGen is rate-limiting your account right now. Wait a moment and try again." };
    }
    if (/\b400\b|\b404\b|not found/i.test(msg)) {
      return { ok: false, error: `HeyGen has no avatar with the id "${avatarId}" on your account.` };
    }
    return { ok: false, error: `Couldn't reach HeyGen to check this avatar: ${msg.slice(0, 160)}` };
  }
  if (!look?.id) {
    return { ok: false, error: `HeyGen returned no avatar for the id "${avatarId}".` };
  }
  return { ok: true, supported: supportsAvatarV(look) };
}

type DetailsResult =
  | { kind: "found"; engine: AvatarEngine; previewUrl: string | null }
  | { kind: "absent" } // definitive 404 — try the group path, else reject
  | { kind: "auth" } // bad key — surface it
  | { kind: "unverifiable" }; // network / 5xx / empty body — fail open

/**
 * GET /v2/avatar/{id}/details — resolves plain avatars and talking photos. ~0.5s and
 * definitive (200 = exists, 404 = not). We use it instead of the full /v2/avatars list
 * (~24s on large accounts, which intermittently timed out and fell open).
 */
async function avatarDetails(id: string): Promise<DetailsResult> {
  try {
    const resp = await heygenGet<{ data?: { type?: string; preview_image_url?: string } | null }>(
      `/v2/avatar/${encodeURIComponent(id)}/details`
    );
    const d = resp.data;
    if (!d) return { kind: "unverifiable" }; // 200 but empty → don't false-reject
    const engine: AvatarEngine = d.type === "talking_photo" ? "talking_photo" : "photo_avatar_group";
    return { kind: "found", engine, previewUrl: d.preview_image_url ?? null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b401\b|\b403\b|unauthorized|forbidden/i.test(msg)) return { kind: "auth" };
    if (/\b404\b|not found/i.test(msg)) return { kind: "absent" };
    return { kind: "unverifiable" }; // network / 5xx → fail open
  }
}

/**
 * Resolve a HeyGen Photo Avatar GROUP id to its first completed look's avatar_id (a
 * renderable handle). Returns null when the id is definitively NOT a group — HeyGen
 * answers "Avatar group not found" (HTTP 400/404). Re-throws transient errors (5xx /
 * network) so the caller can fail open instead of false-rejecting a real group.
 */
async function firstCompletedLook(groupId: string): Promise<string | null> {
  let resp: { data?: { avatar_list?: { id?: string; status?: string }[] } };
  try {
    resp = await heygenGet<{ data?: { avatar_list?: { id?: string; status?: string }[] } }>(
      `/v2/avatar_group/${encodeURIComponent(groupId)}/avatars`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b400\b|\b404\b|not found/i.test(msg)) return null; // definitively not a group
    throw e; // transient — let the caller fail open
  }
  const looks = resp.data?.avatar_list ?? [];
  const ready = looks.find((l) => l.id && l.status === "completed") ?? looks.find((l) => l.id);
  return ready?.id ?? null;
}

/**
 * Avatar ingest reuses the run-log store under a synthetic run id so the UI can
 * show a "Diagnostics" panel per avatar (the user otherwise has zero visibility
 * into why an avatar is stuck). Keep this in sync with the avatars logs route.
 */
export function avatarLogId(avatarId: number): string {
  return `avatar-${avatarId}`;
}

/**
 * Avatar ingestion — turns a saved avatar row (status "pending") into a usable
 * HeyGen handle, then marks it "ready". Fire-and-forget from the avatar create
 * route; the UI polls the avatar status.
 *
 * Two engines (docs/DESIGN.md):
 *  - talking_photo (default): upload the reference photo → talking_photo_id.
 *    Fast, no training. The video step uses character.type = "talking_photo".
 *  - photo_avatar_group: upload asset → create group → train → first look's
 *    avatar_id. Slower (training is async) but yields a consistent trained look.
 */

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

export async function ingestAvatar(avatarId: number): Promise<void> {
  const avatar = getAvatar(avatarId);
  if (!avatar) throw new Error(`Avatar ${avatarId} not found`);
  const lid = avatarLogId(avatarId);

  log(lid, "info", `Avatar ingest started (v${APP_VERSION}) · engine=${avatar.engine} · source=${avatar.ref_image_path ? "uploaded photo" : "text description"}`, { stage: "avatar" });
  try {
    // No uploaded photo but a text description → generate the reference image
    // via kie.ai nano-banana, then proceed as if it had been uploaded.
    let refPath = avatar.ref_image_path;
    if (!refPath || !fs.existsSync(refPath)) {
      if (avatar.description && avatar.description.trim()) {
        log(lid, "info", "No photo — generating a reference image from the text description (nano-banana)…", { stage: "avatar" });
        const dir = path.join(DATA_DIR, "avatars");
        fs.mkdirSync(dir, { recursive: true });
        const genPath = path.join(dir, `${avatarId}.png`);
        await generateAvatarImage(avatar.description, genPath);
        updateAvatar(avatarId, { ref_image_path: genPath });
        refPath = genPath;
        log(lid, "success", "Reference image generated", { stage: "avatar" });
      } else {
        log(lid, "error", "No reference image and no description to generate one from.", { stage: "avatar" });
        updateAvatar(avatarId, {
          status: "error",
          error: "No reference image and no description to generate one from.",
        });
        return;
      }
    }

    const bytes = fs.readFileSync(refPath);
    const mime = mimeFromPath(refPath);

    if (avatar.engine === "photo_avatar_group") {
      await ingestPhotoAvatarGroup(avatarId, avatar.name, bytes, mime, lid);
    } else {
      await ingestTalkingPhoto(avatarId, bytes, mime, lid);
    }
    log(lid, "success", "Avatar is ready to use.", { stage: "avatar" });
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    if (/exceeded your limit.*photo avatars/i.test(msg)) {
      msg +=
        " — Your HeyGen plan's photo-avatar slots are full. Delete unused avatars here (this also frees the HeyGen slot) or remove old Talking Photos at app.heygen.com, then Retry.";
    } else if (/no valid image for training/i.test(msg)) {
      msg +=
        " — HeyGen couldn't use this photo to train a Photo Avatar Group. Use a clear, high-resolution, front-facing headshot (whole face visible, good lighting, plain background). Or switch the engine to Talking Photo — it works with almost any photo and is ready in seconds.";
    }
    log(lid, "error", `Avatar ingest failed: ${msg.slice(0, 400)}`, { stage: "avatar" });
    updateAvatar(avatarId, { status: "error", error: msg.slice(0, 500) });
  }
}

async function ingestTalkingPhoto(avatarId: number, bytes: Buffer, mime: string, lid: string): Promise<void> {
  // Retry path: this avatar already registered a talking photo once. Free that
  // slot first — plans cap talking photos at a few, so re-uploading without
  // releasing the old one leaks a slot per retry until creation always fails
  // with "exceeded your limit".
  const existing = getAvatar(avatarId)?.heygen_id;
  if (existing) {
    try {
      await heygenDelete(`/v2/talking_photo/${encodeURIComponent(existing)}`);
      log(lid, "info", "Released the previous HeyGen talking-photo slot", { stage: "avatar" });
    } catch {
      // best-effort — the upload below may still succeed if slots are free
    }
  }
  log(lid, "info", `Uploading the photo to HeyGen (Talking Photo, ${(bytes.length / 1024).toFixed(0)} KB)…`, { stage: "avatar" });
  const tp = await uploadTalkingPhoto(bytes, mime);
  log(lid, "info", "HeyGen accepted the photo (talking_photo_id received)", { stage: "avatar" });
  // Talking photos are usable immediately (subject to a short moderation window,
  // which the first video-generation attempt retries through). Also upload the
  // image as a normal asset so we have an image_key for Avatar IV (av4) if asked.
  let imageKey: string | null = null;
  try {
    const asset = await uploadAsset(bytes, mime);
    imageKey = asset.image_key ?? null;
  } catch {
    // image_key is optional — only needed for the Avatar IV (av4) path.
  }
  updateAvatar(avatarId, {
    heygen_id: tp.talking_photo_id,
    image_key: imageKey,
    preview_url: tp.talking_photo_url ?? null,
    status: "ready",
    error: null,
  });
}

interface CreateGroupResp {
  error?: unknown;
  data?: { id?: string; image_url?: string };
}

async function ingestPhotoAvatarGroup(
  avatarId: number,
  name: string,
  bytes: Buffer,
  mime: string,
  lid: string
): Promise<void> {
  log(lid, "info", "Uploading the photo to HeyGen (Photo Avatar Group)…", { stage: "avatar" });
  const asset = await uploadAsset(bytes, mime);
  const imageKey = asset.image_key;
  if (!imageKey) {
    throw new Error(
      "HeyGen did not return an image_key for this upload — required to create a Photo Avatar Group. Try the Talking Photo engine instead."
    );
  }

  const group = await heygenPost<CreateGroupResp>("/v2/photo_avatar/avatar_group/create", {
    name,
    image_key: imageKey,
  });
  const groupId = group.data?.id;
  if (!groupId) {
    throw new Error(`Create Photo Avatar Group returned no id: ${JSON.stringify(group).slice(0, 200)}`);
  }
  updateAvatar(avatarId, { group_id: groupId, image_key: imageKey, status: "training" });

  // Kick off training (async on HeyGen's side). A freshly-created group can briefly
  // report "No valid image for training found" while HeyGen is still processing the
  // just-uploaded photo — retry that specific transient error a few times before failing.
  log(lid, "info", "Training the avatar look on HeyGen — this can take several minutes…", { stage: "avatar" });
  await trainPhotoAvatarGroup(groupId, lid);

  // Poll the group's looks until at least one is ready (training can take minutes).
  const lookId = await pollFirstReadyLook(groupId);
  if (!lookId) {
    throw new Error("Photo Avatar Group training did not produce a usable look within 10 minutes. Try again, or use the Talking Photo engine (instant).");
  }
  log(lid, "info", "Training complete — look is ready", { stage: "avatar" });
  updateAvatar(avatarId, { heygen_id: lookId, status: "ready", error: null });
}

/**
 * Start Photo Avatar Group training, retrying the transient
 * "No valid image for training found in group" — HeyGen can still be processing
 * the just-uploaded photo for a few seconds after avatar_group/create. A hard
 * rejection (unusable photo) still surfaces once the retries are exhausted.
 */
async function trainPhotoAvatarGroup(groupId: string, lid: string): Promise<void> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await heygenPost("/v2/photo_avatar/train", { group_id: groupId });
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no valid image for training/i.test(msg) && attempt < MAX_ATTEMPTS) {
        log(lid, "info", `HeyGen is still processing the photo — retrying training shortly (${attempt}/${MAX_ATTEMPTS - 1})…`, { stage: "avatar" });
        await new Promise((r) => setTimeout(r, 7000 * attempt));
        continue;
      }
      throw e;
    }
  }
}

/**
 * Poll the group for a usable look id. HeyGen's exact training-status path is
 * version-dependent (see design notes), so we poll the group-details endpoint
 * and take the first look that has an id. Bounded to ~10 minutes.
 */
async function pollFirstReadyLook(groupId: string): Promise<string | null> {
  const DEADLINE = Date.now() + 10 * 60 * 1000;
  let delay = 8000;
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 4000, 30000);
    try {
      const looks = await heygenGet<{ data?: { avatar_list?: { id?: string }[]; looks?: { id?: string }[] } }>(
        `/v2/avatar_group/${encodeURIComponent(groupId)}/avatars`
      );
      const list = looks.data?.avatar_list ?? looks.data?.looks ?? [];
      const ready = list.find((l) => l.id);
      if (ready?.id) return ready.id;
    } catch {
      // keep polling — the endpoint may 404 until training registers the group
    }
  }
  return null;
}

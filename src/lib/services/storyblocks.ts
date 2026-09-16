import crypto from "node:crypto";
import { getSetting } from "../settings";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";

/**
 * Storyblocks — a PAID stock library (video / image / audio) behind an HMAC-signed API.
 *
 * Everything in this file was measured against the live API on 2026-07-31, not taken
 * from the docs, because two of the three behaviours that matter are undocumented.
 *
 * ── 1. AUTH IS ENTIRELY IN THE URL ──────────────────────────────────────────────
 * Three query params: APIKEY (public), EXPIRES (unix seconds, <=36h ahead) and HMAC
 * = hex SHA-256 where the DATA is the resource PATH and the KEY is `secret + EXPIRES`.
 * No headers are involved, which is what makes this provider possible at all: the
 * pipeline's downloader (visual-source.ts downloadToFile) can only send a User-Agent,
 * so a download URL has to carry its own credentials. We pre-sign it at search time.
 *
 * ── 2. THE VIDEO SEARCH LIES ON LONG QUERIES ────────────────────────────────────
 * /videos/search never answers "nothing found" for a multi-word query. When it has no
 * real match it silently returns a ~31-33 item semantic fallback pool and reports that
 * as total_results. Measured:
 *
 *   "Cummins 12 valve diesel engine bay close up" → 31  (car engine bays, no Cummins)
 *   "mud dauber wasp nest"                        → 33  (cicada killers, hornets)
 *   "man walking through snowy forest at dusk"    → 32
 *   "zzqxwv flurblenax quommis"  (gibberish)      → 31  (insects, flies)
 *
 * versus the same subjects asked in TWO words:
 *
 *   "diesel engine" → 99    "mud nest" → 49    "snowy forest" → 10000
 *   "wasp nest"     → 80    "campfire" → 6326  "engine bay"   → 327
 *
 * So the fix is the QUERY, not the source — see `toShortQuery`. The failures are not
 * about word count alone: pairs containing a RARE token still fall back ("dauber nest"
 * → 32, "mummified spiders" → 32), which is why a tripped detector retries on one word.
 *
 * ── 3. THE FALLBACK IS DETECTABLE ───────────────────────────────────────────────
 * The pool is hard-capped: ask for 50 and it still returns ~31-33, while a genuine
 * query fills the page. `looksLikeFallback` uses exactly that. Without this guard the
 * provider would feed 32 off-topic clips into every failed niche search — strictly
 * worse than returning nothing.
 *
 * ── 4. DOWNLOADS COST MONEY, SEARCHES DO NOT ────────────────────────────────────
 * Unlike every other provider here, materialising a hit is BILLED. The free test tier
 * is 5 downloads TOTAL (not per day) against 1000 searches PER DAY. So the provider
 * hands back a pre-signed download URL but the run is capped by
 * STORYBLOCKS_MAX_DOWNLOADS_PER_RUN, counted locally — the API exposes no quota
 * endpoint, no rate-limit headers and no 429, so local counting is the only way to
 * know where we stand.
 */

// ── Multi-key pool ───────────────────────────────────────────────────────────
//
// Mirrors the Pexels pool in stock-footage.ts, with two deliberate differences forced
// by the API:
//
//   * a Storyblocks credential is a PAIR (public + private), not one opaque string, so
//     the setting is parsed line-by-line as "public:private" instead of being split on
//     commas/semicolons — a public key can itself contain no colon, but splitting on
//     the FIRST colon keeps that assumption unnecessary;
//   * there are no rate-limit headers and no 429 to react to. Pexels tells us how much
//     is left; Storyblocks tells us nothing. So exhaustion is inferred from a denial and
//     the cooldown is a flat guess, not a header-derived deadline.
//
// One account issues exactly one keypair, so multiple keys means multiple accounts —
// which is why the setting is plural and the UI says so.

interface SbKeyState {
  pub: string;
  priv: string;
  /** UNIX ms — when this key becomes usable again; null = usable now. */
  exhaustedUntilMs: number | null;
  /** Downloads we have spent on this key in this process. Local-only bookkeeping. */
  downloads: number;
}

const keyPool: { keys: SbKeyState[]; cursor: number } = { keys: [], cursor: 0 };

/**
 * With no reset header to read, a denied key is parked for a flat hour. Storyblocks'
 * limits are per-endpoint and per-agreement (their words), so this is a deliberate
 * guess: long enough not to hammer a genuinely exhausted key, short enough that a
 * daily quota which rolled over is picked up again the same session.
 */
const BLIND_COOLDOWN_MS = 60 * 60 * 1000;

/** Parse STORYBLOCKS_API_KEYS afresh each call, preserving state for keys we've seen. */
export function parseKeyPairs(raw: string): { pub: string; priv: string }[] {
  return raw
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(":");
      if (i <= 0) return null;
      const pub = line.slice(0, i).trim();
      const priv = line.slice(i + 1).trim();
      return pub && priv ? { pub, priv } : null;
    })
    .filter((x): x is { pub: string; priv: string } => x !== null);
}

function refreshKeyPool(): SbKeyState[] {
  const parsed = parseKeyPairs(getSetting("STORYBLOCKS_API_KEYS") || "");
  const existing = new Map(keyPool.keys.map((k) => [k.pub, k]));
  keyPool.keys = parsed.map((p) => {
    const prev = existing.get(p.pub);
    // A pasted-over private key must take effect immediately, so the pair is rebuilt
    // and only the runtime state is carried across.
    return prev
      ? { pub: p.pub, priv: p.priv, exhaustedUntilMs: prev.exhaustedUntilMs, downloads: prev.downloads }
      : { pub: p.pub, priv: p.priv, exhaustedUntilMs: null, downloads: 0 };
  });
  if (keyPool.cursor >= keyPool.keys.length) keyPool.cursor = 0;
  return keyPool.keys;
}

/**
 * The next usable key, or null when every key is cooling. Unlike the Pexels pool this
 * never SLEEPS: Storyblocks is an optional extra source among five others, so a beat
 * should fall through to the free providers rather than stall the run waiting on a
 * paid one.
 */
function acquireKey(runId?: string): SbKeyState | null {
  const keys = refreshKeyPool();
  if (keys.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const idx = (keyPool.cursor + i) % keys.length;
    const k = keys[idx];
    if (k.exhaustedUntilMs !== null && k.exhaustedUntilMs > now) continue;
    if (k.exhaustedUntilMs !== null) {
      k.exhaustedUntilMs = null;
      if (runId) log(runId, "info", `Storyblocks key #${idx + 1} cooldown ended — using it`, { stage: "visual" });
    }
    keyPool.cursor = idx;
    return k;
  }
  return null;
}

function markKeyExhausted(state: SbKeyState, runId?: string): void {
  state.exhaustedUntilMs = Date.now() + BLIND_COOLDOWN_MS;
  keyPool.cursor = (keyPool.cursor + 1) % Math.max(1, keyPool.keys.length);
  if (runId) {
    log(runId, "warn", `Storyblocks key denied — parking it for 60 min and rotating to the next`, { stage: "visual" });
  }
}

/** Internals exposed for unit tests only. */
export const __testing = { keyPool, refreshKeyPool, acquireKey, markKeyExhausted, BLIND_COOLDOWN_MS };

// ── Signing ──────────────────────────────────────────────────────────────────

/** How far ahead a signature is valid. Their ceiling is 36h; we stay well inside it. */
const EXPIRES_WINDOW_SEC = 30 * 60;

/**
 * A fully-signed absolute URL. The signature covers ONLY the resource path — query
 * params are not signed — so a download URL built here stays valid for
 * EXPIRES_WINDOW_SEC regardless of what else is appended.
 */
export function signedUrl(
  pub: string,
  priv: string,
  resource: string,
  params: Record<string, string | number>,
  nowSec = Math.floor(Date.now() / 1000)
): string {
  const expires = nowSec + EXPIRES_WINDOW_SEC;
  const hmac = crypto.createHmac("sha256", `${priv}${expires}`).update(resource).digest("hex");
  const url = new URL(`https://api.storyblocks.com${resource}`);
  url.searchParams.set("APIKEY", pub);
  url.searchParams.set("EXPIRES", String(expires));
  url.searchParams.set("HMAC", hmac);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url.toString();
}

// ── Query shaping ────────────────────────────────────────────────────────────

/** Words that carry no search signal and reliably push a query over the fallback edge. */
const NOISE = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "and", "or", "from",
  "into", "onto", "over", "under", "inside", "outside", "through", "during", "while",
  "close", "closeup", "up", "shot", "view", "footage", "clip", "scene", "angle",
  "detailed", "showing", "shows", "seen", "being", "very", "some", "its", "his", "her",
]);

/**
 * Reduce a planner query to the 1-2 common words this API actually answers honestly.
 *
 * Keeps the LAST tokens, because English noun phrases put the head last ("dried mummified
 * spiders inside mud dauber nest" → the subject is the nest, not the drying). Drops noise
 * words, pure numbers, and ALL-CAPS/brand-shaped tokens — measured: "Cummins" returns four
 * clips of people surnamed Cummings, so a brand in the query is worse than no query.
 */
export function toShortQuery(raw: string, words = 2): string {
  const tokens = (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length > 2 && !NOISE.has(t) && !/^\d+$/.test(t));
  if (tokens.length === 0) return "";
  return tokens.slice(-Math.max(1, words)).join(" ");
}

// ── The fallback detector ────────────────────────────────────────────────────

/** Above this, a result set is genuine — the observed fallback pool never exceeded 34. */
const FALLBACK_TOTAL_CEILING = 35;
/** ...and the fallback never fills a page, however many are requested. */
const FALLBACK_RETURNED_CEILING = 34;

/**
 * True when a response is the semantic-fallback pool rather than real matches.
 *
 * Both conditions are required. The count alone is not enough: a genuinely rare-but-real
 * subject can legitimately have ~30 clips, and it will fill the page it is given. The
 * fallback cannot — it is capped no matter what results_per_page asks for. So we only
 * call it fallback when the total is small AND the page came back short of what we asked.
 */
export function looksLikeFallback(total: number, returned: number, requested: number): boolean {
  if (total <= 0) return false; // an honest zero is not a fallback
  if (total > FALLBACK_TOTAL_CEILING) return false;
  if (requested <= FALLBACK_RETURNED_CEILING) return false; // can't tell — we didn't ask for enough
  return returned <= FALLBACK_RETURNED_CEILING;
}

// ── Search ───────────────────────────────────────────────────────────────────

/** Ask for well over the fallback ceiling so `looksLikeFallback` can tell them apart. */
const RESULTS_PER_PAGE = 50;

interface SbVideoResult {
  id?: number;
  title?: string;
  thumbnail_url?: string;
  duration?: number;
  orientation?: string;
  preview_urls?: Record<string, string>;
}

/** What a caller needs to build a ProviderHit, kept free of visual-source's types. */
export interface StoryblocksItem {
  id: number;
  title: string;
  thumbnailUrl?: string;
  durationSec?: number;
  /** Pre-signed, credential-carrying, BILLED on fetch. */
  downloadUrl: string;
  sourceUrl: string;
}

function downloadsUsedThisRun(): number {
  return runDownloadCount;
}

/** Reset per run by the pipeline via `beginStoryblocksRun`. */
let runDownloadCount = 0;
let runDownloadCap = 0;

/** Called once per run so the paid-download budget can't leak across runs. */
export function beginStoryblocksRun(): void {
  runDownloadCount = 0;
  runDownloadCap = Math.max(0, Number(getSetting("STORYBLOCKS_MAX_DOWNLOADS_PER_RUN") || "0"));
}

/** Book one paid download against the run budget. False = budget spent, do not fetch. */
export function reserveDownload(runId?: string): boolean {
  // 0 = NO limit. The source is on by default, so a cap of 0 meaning "spend nothing"
  // would make it silently dead for everyone; the ceiling is an opt-in safety valve.
  if (runDownloadCap > 0 && runDownloadCount >= runDownloadCap) {
    if (runId) {
      log(runId, "info", `Storyblocks download budget for this run is spent (${runDownloadCap}) — skipping its hits`, { stage: "visual" });
    }
    return false;
  }
  runDownloadCount += 1;
  const k = keyPool.keys[keyPool.cursor];
  if (k) k.downloads += 1;
  return true;
}

export const __runBudget = { used: downloadsUsedThisRun, cap: () => runDownloadCap };

/**
 * Search Storyblocks video. Returns [] for every failure mode — no key, all keys
 * cooling, transport error, or a fallback pool — because this is an optional extra
 * source and a beat must never fail because of it.
 */
export async function storyblocksSearch(query: string, runId?: string, minDurSec?: number): Promise<StoryblocksItem[]> {
  const key = acquireKey(runId);
  if (!key) return [];
  if (runDownloadCap > 0 && runDownloadCount >= runDownloadCap) return []; // budget already spent

  // Two words first; if that trips the fallback, one word, which is always answered honestly.
  for (const words of [2, 1]) {
    const short = toShortQuery(query, words);
    if (!short) return [];
    if (runId) checkCancelled(runId);

    const params: Record<string, string | number> = {
      keywords: short,
      results_per_page: RESULTS_PER_PAGE,
      user_id: "conveyer",
      project_id: runId ? runId.slice(0, 32) : "conveyer",
    };
    const want = Math.ceil(minDurSec ?? 0);
    if (want > 0) params.min_duration = want;

    type SbSearchResponse = { total_results?: number; results?: SbVideoResult[]; errors?: unknown };
    let data: SbSearchResponse | null = null;
    try {
      const resp = await fetch(signedUrl(key.pub, key.priv, "/api/v2/videos/search", params), {
        headers: { "User-Agent": "FacelessVideoGenerator/0.1" },
      });
      // 401/403/400 on a signature is OUR bug, not exhaustion — don't park the key for it.
      if (resp.status === 429 || resp.status === 402 || resp.status >= 500) {
        markKeyExhausted(key, runId);
        return [];
      }
      if (!resp.ok) {
        if (runId) log(runId, "debug", `Storyblocks search ${resp.status} — skipping this beat`, { stage: "visual" });
        return [];
      }
      data = (await resp.json()) as SbSearchResponse;
    } catch {
      return [];
    }
    if (!data || data.errors) return [];

    const total = Number(data.total_results ?? 0);
    const results = Array.isArray(data.results) ? data.results : [];
    if (looksLikeFallback(total, results.length, RESULTS_PER_PAGE)) {
      if (runId) {
        log(runId, "debug", `Storyblocks "${short}" → ${total} results but the page came back short — semantic fallback, discarding`, { stage: "visual" });
      }
      continue; // try the shorter form
    }
    if (results.length === 0) return [];

    if (runId) log(runId, "debug", `Storyblocks "${short}" → ${total} real result(s)`, { stage: "visual" });

    const seen = new Set<number>();
    const items: StoryblocksItem[] = [];
    for (const r of results) {
      // Measured: the same id recurs within one page, which would place the same shot twice.
      if (!r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      items.push({
        id: r.id,
        title: r.title ?? "",
        thumbnailUrl: r.thumbnail_url,
        durationSec: typeof r.duration === "number" ? r.duration : undefined,
        downloadUrl: signedUrl(key.pub, key.priv, `/api/v2/videos/stock-item/download/${r.id}`, {
          user_id: params.user_id,
          project_id: params.project_id,
        }),
        sourceUrl: `https://www.storyblocks.com/video/stock/${r.id}`,
      });
    }
    return items;
  }
  return [];
}

// ── Resolving a download to an actual file ───────────────────────────────────

/**
 * The download endpoint does NOT return the clip — it returns a small JSON manifest of
 * signed CDN links, one per format and resolution. Measured on a real (billed) call:
 *
 *   {"MOV":{"_2160p":"…","_1080p":"…"},
 *    "MP4":{"_2160p":"…","_1080p":"…","_720p":"…"}}
 *
 * Each link is a pre-signed CloudFront URL with its own Expires+Signature. Handing the
 * manifest URL straight to the pipeline's downloader would save ~4 KB of JSON as an .mp4
 * — the integrity probe rejects it, so the source would simply never work. Hence this
 * resolve step.
 *
 * IMPORTANT for cost: hitting the manifest endpoint is what gets BILLED, and materialize()
 * runs only for the candidate the vision scorer already chose — so exactly one download is
 * charged per accepted beat, not one per candidate.
 */
export function pickDownloadUrl(manifest: unknown, wantHeight = 1080): string | null {
  if (!manifest || typeof manifest !== "object") return null;
  const m = manifest as Record<string, unknown>;
  // MP4 first: our compositor re-encodes to h264 anyway, and MOV entries are far larger.
  const order = ["MP4", "MOV", ...Object.keys(m)];
  const seen = new Set<string>();
  for (const fmt of order) {
    if (seen.has(fmt)) continue;
    seen.add(fmt);
    const group = m[fmt];
    if (!group || typeof group !== "object") continue;
    const byHeight = Object.entries(group as Record<string, unknown>)
      .map(([k, v]) => ({ h: Number(/_(\d+)p/.exec(k)?.[1] ?? 0), url: typeof v === "string" ? v : "" }))
      .filter((x) => x.h > 0 && /^https?:/i.test(x.url));
    if (byHeight.length === 0) continue;
    // Smallest height that still covers the frame; if none does, the largest available.
    const covering = byHeight.filter((x) => x.h >= wantHeight).sort((a, b) => a.h - b.h);
    const best = covering[0] ?? byHeight.sort((a, b) => b.h - a.h)[0];
    if (best) return best.url;
  }
  return null;
}

/**
 * Turn a signed manifest URL into a directly-fetchable clip URL. Returns null on any
 * failure, which makes the caller drop this candidate and try the next one — never a
 * throw, because a paid source must not be able to fail a beat that free sources could
 * still serve.
 */
export async function resolveStoryblocksFile(manifestUrl: string, wantHeight = 1080, runId?: string): Promise<string | null> {
  try {
    const resp = await fetch(manifestUrl, { headers: { "User-Agent": "FacelessVideoGenerator/0.1" } });
    if (!resp.ok) {
      if (runId) log(runId, "debug", `Storyblocks download manifest ${resp.status}`, { stage: "visual" });
      return null;
    }
    const url = pickDownloadUrl(await resp.json(), wantHeight);
    if (!url && runId) log(runId, "debug", "Storyblocks manifest carried no usable file link", { stage: "visual" });
    return url;
  } catch {
    return null;
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import sharp from "sharp";
import { getSetting } from "../settings";
import { pLimit } from "../plimit";
import { resolveFfmpeg } from "../ffmpeg-bin";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import { kenBurns } from "./ken-burns";
import { animateScene } from "./img2vid";
import { labs69Image } from "./image-gen";
import { generateImageUrl, generateVideoUrl, downloadKie } from "./kie";
import { PollinationsImageError, generatePollinationsImage, pollinationsImageConfigured } from "./pollinations-image";
import { MetaImageError, generateMetaImage } from "./meta-image";
import {
  CloudflareImageError,
  cloudflareImageConfigured,
  generateCloudflareImage,
  isCloudflareDailyQuotaError,
} from "./cloudflare-image";
import { generateMagnificImageUrl, generateMagnificVideoUrl, downloadMagnific, magnificConfigured } from "./magnific";
import { generateHiggsfieldImageUrl, generateHiggsfieldVideoUrl, downloadHiggsfield, higgsfieldConfigured } from "./higgsfield";
import { generateRunwareImage, downloadRunware } from "./runware";
import { FlowBrowserError, generateFlowImage } from "./flow-browser";
import { storyblocksSearch, reserveDownload as sbReserveDownload, resolveStoryblocksFile } from "./storyblocks";
import { recordStoryblocksDownload, recordGoogleCseQuery, recordGemini, recordKieImage, recordKieVeo, recordLabs69, recordLabs69Image, recordMagnificImage, recordMagnificVideo, recordHiggsfieldImage, recordHiggsfieldVideo, recordRunwareImage } from "./cost-ledger";
import { callGemini } from "./gemini-models";
import { beforeVisionCall, noteVisionFailure, noteVisionSuccess, type VisionCircuitUpdate } from "./vision-circuit";
import { noteGeminiQuota } from "./gemini-quota";
import { noteCreditExhausted } from "./credit-exhaustion";
import { noteVisionUnjudged } from "./vision-qc";
import {
  searchPexelsVideos,
  pickBestVideoFile,
  visualPromptToQuery,
  stripNegationClauses,
  type Orientation,
} from "./stock-footage";
import type { Scene } from "./scene-split";
import type { Beat } from "./studio-plan";
import { DATA_DIR } from "../run-paths";

// Provider-level circuit breaker. Profile-level credential/config failures are handled inside
// cloudflare-image.ts by deterministic operational failover (Primary → Backup 1 → ...). If the
// DAILY allocation is exhausted (3036/4006/message match), or no usable profile remains, stop
// probing Cloudflare for the rest of that run and continue with Pollinations/Meta/kie.ai.
const cloudflareDisabledRuns = new Set<string>();
const pollinationsDisabledRuns = new Set<string>();
const metaDisabledRuns = new Set<string>();

/**
 * Visual source — produces ONE mp4 per visual beat.
 *
 * For source = "real": search the configured footage providers in priority
 * order. A video hit is downloaded as-is; a still-image hit gets the Ken Burns
 * zoom into a clip. For source = "ai" (or when every real provider fails): the
 * 69labs/Grok text-to-video engine generates the clip. A beat is never empty —
 * real failures fall back to AI, AI failure throws.
 *
 * Default safe stack (licensed/CC): Pexels, Pixabay, Openverse, Wikimedia.
 * yt-dlp is an opt-in power source, OFF by default (copyright/ToS risk).
 * See docs/DESIGN.md.
 */

export interface VisualResult {
  path: string;
  kind: "video" | "image" | "ai";
  provider: string;
  /** Where this frame came from. `url` is declared because the real-footage path already
   *  passes the whole ProviderHit here — recording it was relying on an undeclared field. */
  attribution?: { author?: string | null; sourceUrl?: string; license?: string | null; url?: string };
  /** Diagnostics only (YT_DEBUG) — populated by downloadYouTube; never affects behavior. */
  ytDebug?: { id: string; title?: string; durationSec?: number; segStart: number; segEnd: number };
}

type ProviderKind = "video" | "image";

function logVisionCircuitTransition(runId: string, update: VisionCircuitUpdate | null | undefined): void {
  if (!update?.transition) return;
  if (update.transition === "open") {
    log(runId, "warn", `Gemini Vision circuit OPEN — ${update.failuresInWindow} availability failures in ${update.samplesInWindow} recent API attempts (threshold 5/10); bypassing Vision for 60s`, { stage: "visual" });
  } else if (update.transition === "reopened") {
    log(runId, "warn", `Gemini Vision circuit REOPENED — half-open probe failed; bypassing Vision for another 60s`, { stage: "visual" });
  } else if (update.transition === "closed") {
    log(runId, "info", `Gemini Vision circuit CLOSED — half-open probe succeeded; Vision calls resumed`, { stage: "visual" });
  }
}

function beginVisionCall(runId: string): ReturnType<typeof beforeVisionCall> {
  const decision = beforeVisionCall(runId);
  if (decision.transition === "half-open") {
    log(runId, "info", `Gemini Vision circuit HALF-OPEN — probing Flash-Lite with one request`, { stage: "visual" });
  }
  return decision;
}

function recordVisionAttemptFailure(runId: string, reason: string, probe: boolean): void {
  logVisionCircuitTransition(runId, noteVisionFailure(runId, reason, probe));
}

function recordVisionCallSuccess(runId: string, probe: boolean): void {
  logVisionCircuitTransition(runId, noteVisionSuccess(runId, probe));
}

export interface ProviderHit {
  kind: ProviderKind;
  /** Direct download URL (video file or image file). */
  url: string;
  /** Stable dedupe id, e.g. "pexels:123". */
  dedupeId: string;
  /** Small preview image the vision scorer actually looks at (a video's poster
   *  frame, or the image itself). Undefined → scored by title text only. */
  thumbUrl?: string;
  author?: string | null;
  sourceUrl?: string;
  license?: string | null;
  /** Which provider produced it (filled by gatherCandidates). */
  provider?: string;
}

/**
 * Topic Pool Retrieval (P1) — per-run cache so beats sharing a `topicKey` reuse ONE provider
 * fan-out per broaden attempt instead of each issuing its own. `pools` memoizes the gathered
 * candidate list (usedIds-INDEPENDENT — the used-clip filter is applied at consumption) keyed by
 * `${topicKey}|${attempt}`; storing the in-flight Promise means concurrent same-topic beats share a
 * single fetch rather than racing N. `base` pins the canonical (pre-broaden) query per topic so
 * every member broadens the SAME string and lands on the same cache entry. Created once per run in
 * studio-pipeline and threaded through acquireVisual → acquireReal; read only when TOPIC_POOL=1.
 */
export interface TopicPool {
  pools: Map<string, Promise<ProviderHit[]>>;
  base: Map<string, string>;
}
export function createTopicPool(): TopicPool {
  return { pools: new Map(), base: new Map() };
}
// A shared empty used-set for topic gathers: the cached pool must be usedIds-independent, so the
// gather is told nothing is used and the per-beat filter runs at consumption. gatherCandidates only
// READS this set (never mutates), so sharing one frozen instance is safe.
const NO_USED_FILTER: ReadonlySet<string> = new Set<string>();

function orientationSetting(): Orientation {
  const o = (getSetting("STOCK_FOOTAGE_ORIENTATION") || "landscape").toLowerCase();
  return o === "portrait" || o === "square" ? (o as Orientation) : "landscape";
}

async function downloadToFile(url: string, outPath: string, headers?: Record<string, string>): Promise<void> {
  // Retry on rate-limit / transient server errors with backoff. Wikimedia
  // (upload.wikimedia.org) 429s aggressively under the parallel beat load, which
  // used to throw away high-scoring matches; a short backoff usually clears it.
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200 * attempt));
    const resp = await fetch(url, headers ? { headers } : undefined);
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.byteLength === 0) throw new Error(`empty download: ${url.slice(0, 120)}`);
      fs.writeFileSync(outPath, buf);
      return;
    }
    lastErr = `download ${resp.status}: ${url.slice(0, 120)}`;
    if (resp.status !== 429 && resp.status < 500) break; // not transient → stop
  }
  throw new Error(lastErr);
}

const UA = "FacelessVideoGenerator/0.1 (local video tool; contact: operator)";

// ── Providers ────────────────────────────────────────────────────────────────

/**
 * `minDurSec` = the beat's duration. A clip shorter than the beat gets looped by
 * the compositor, which reads as a jarring visible repeat — so we ask Pexels for
 * clips that cover the whole beat first, and only fall back to the global
 * minimum (shorter clips) when that returns nothing.
 */
async function pexelsSearch(query: string, runId: string, minDurSec?: number): Promise<ProviderHit[]> {
  const globalMin = Math.max(0, Number(getSetting("STOCK_FOOTAGE_MIN_DURATION") || "3"));
  const wanted = Math.max(globalMin, Math.ceil(minDurSec ?? 0));
  const maxH = Math.max(360, Number(getSetting("STOCK_FOOTAGE_MAX_HEIGHT") || "1080"));

  // perPage 40 (Pexels max 80): one API call either way, but a richer first pool
  // means fewer broaden re-searches → fewer calls against the 200/hr rate limit.
  const search = (minDuration: number) =>
    searchPexelsVideos(query, { orientation: orientationSetting(), minDuration, perPage: 40, runId });

  let videos = await search(wanted);
  if (videos.length === 0 && wanted > globalMin) videos = await search(globalMin);

  const hits: ProviderHit[] = [];
  for (const v of videos) {
    const file = pickBestVideoFile(v, { maxHeight: maxH });
    if (file) {
      hits.push({
        kind: "video",
        url: file.link,
        dedupeId: `pexels:${v.id}`,
        thumbUrl: v.image, // poster frame — what the vision scorer judges
        author: v.user?.name ?? null,
        sourceUrl: v.url,
        license: "Pexels License",
      });
    }
  }
  return hits;
}

async function pixabayVideoSearch(query: string, minDurSec?: number): Promise<ProviderHit[]> {
  const key = getSetting("PIXABAY_API_KEY");
  if (!key) return [];
  const orient = orientationSetting();
  const url = new URL("https://pixabay.com/api/videos/");
  url.searchParams.set("key", key);
  url.searchParams.set("q", query.slice(0, 100));
  url.searchParams.set("video_type", "film");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", "20");
  if (orient !== "square") url.searchParams.set("orientation", orient === "portrait" ? "vertical" : "horizontal");
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`Pixabay videos ${resp.status}`);
  const data = (await resp.json()) as {
    hits?: { id: number; duration?: number; pageURL?: string; user?: string; videos?: Record<string, { url: string; width: number; height: number }> }[];
  };
  const all = (data.hits ?? [])
    .map((h): (ProviderHit & { durationSec?: number }) | null => {
      const v = h.videos?.large?.url ? h.videos.large : h.videos?.medium;
      if (!v?.url) return null;
      return { kind: "video", url: v.url, dedupeId: `pixabay:${h.id}`, author: h.user ?? null, sourceUrl: h.pageURL, license: "Pixabay License", durationSec: h.duration };
    })
    .filter((x): x is ProviderHit & { durationSec?: number } => x !== null);
  // Prefer clips that cover the whole beat (no visible looping); fall back to all.
  const want = Math.ceil(minDurSec ?? 0);
  const covering = want > 0 ? all.filter((h) => (h.durationSec ?? 0) >= want) : all;
  return covering.length > 0 ? covering : all;
}

async function pixabayImageSearch(query: string): Promise<ProviderHit[]> {
  const key = getSetting("PIXABAY_API_KEY");
  if (!key) return [];
  const url = new URL("https://pixabay.com/api/");
  url.searchParams.set("key", key);
  url.searchParams.set("q", query.slice(0, 100));
  url.searchParams.set("image_type", "photo");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", "30");
  url.searchParams.set("min_width", "1280");
  url.searchParams.set("orientation", orientationSetting() === "portrait" ? "vertical" : "horizontal");
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`Pixabay images ${resp.status}`);
  const data = (await resp.json()) as {
    hits?: { id: number; pageURL?: string; user?: string; largeImageURL?: string; fullHDURL?: string; webformatURL?: string; previewURL?: string }[];
  };
  return (data.hits ?? [])
    .map((h): ProviderHit | null => {
      const u = h.fullHDURL || h.largeImageURL;
      if (!u) return null;
      return { kind: "image", url: u, dedupeId: `pixabay-img:${h.id}`, thumbUrl: h.webformatURL || h.previewURL || u, author: h.user ?? null, sourceUrl: h.pageURL, license: "Pixabay License" };
    })
    .filter((x): x is ProviderHit => x !== null);
}

async function openverseSearch(query: string): Promise<ProviderHit[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("license", "pdm,cc0,by,by-sa");
  url.searchParams.set("license_type", "commercial,modification");
  url.searchParams.set("page_size", "20");
  const headers: Record<string, string> = { "User-Agent": UA };
  const token = getSetting("OPENVERSE_TOKEN");
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`Openverse ${resp.status}`);
  const data = (await resp.json()) as {
    results?: { id: string; url?: string; thumbnail?: string; creator?: string; foreign_landing_url?: string; license?: string; attribution?: string }[];
  };
  return (data.results ?? [])
    .filter((r) => r.url)
    .map((r): ProviderHit => ({
      kind: "image",
      url: r.url as string,
      dedupeId: `openverse:${r.id}`,
      thumbUrl: r.thumbnail || r.url,
      author: r.creator ?? null,
      sourceUrl: r.foreign_landing_url,
      license: r.license ?? null,
    }));
}

async function wikimediaSearch(query: string): Promise<ProviderHit[]> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", "20");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|size|mime|extmetadata");
  url.searchParams.set("iiurlwidth", "1920");
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`Wikimedia ${resp.status}`);
  const data = (await resp.json()) as {
    query?: { pages?: Record<string, { title?: string; imageinfo?: { url?: string; thumburl?: string; mime?: string; descriptionurl?: string; extmetadata?: Record<string, { value?: string }> }[] }> };
  };
  const pages = data.query?.pages ? Object.values(data.query.pages) : [];
  const hits: ProviderHit[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info) continue;
    const mime = info.mime ?? "";
    // Stills only here (Commons video is webm and would need transcode); prefer the 1920 thumb.
    if (!/^image\//.test(mime)) continue;
    const u = info.thumburl || info.url;
    if (!u) continue;
    hits.push({
      kind: "image",
      url: u,
      dedupeId: `wikimedia:${p.title}`,
      thumbUrl: info.thumburl || u,
      author: info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, "").slice(0, 120) ?? null,
      sourceUrl: info.descriptionurl,
      license: info.extmetadata?.LicenseShortName?.value ?? null,
    });
  }
  return hits;
}

const PROVIDERS: Record<string, (q: string, runId: string, minDurSec?: number) => Promise<ProviderHit[]>> = {
  pexels: (q, runId, minDurSec) => pexelsSearch(q, runId, minDurSec),
  pixabay: async (q, _runId, minDurSec) => [...(await safe(pixabayVideoSearch(q, minDurSec))), ...(await safe(pixabayImageSearch(q)))],
  openverse: (q) => openverseSearch(q),
  wikimedia: (q) => wikimediaSearch(q),
  archive: (q) => archiveSearch(q),
  storyblocks: (q, runId, minDurSec) => storyblocksProvider(q, runId, minDurSec),
  web: (q, runId) => googleCseSearch(q, runId),
  wigolo: (q, runId) => wigoloSearch(q, runId),
};

/**
 * Storyblocks — the only PAID source here, so it behaves differently in one way that
 * matters: materialising a hit is billed. `reserveDownload` books the hit against the
 * run's budget at SEARCH time, which is conservative (a candidate we never download
 * still consumes budget) but keeps the guarantee that a run can never exceed the cap.
 * A tighter design would reserve inside materialize; that needs a provider-aware hook
 * there, which does not exist yet.
 */
async function storyblocksProvider(q: string, runId: string, minDurSec?: number): Promise<ProviderHit[]> {
  const items = await storyblocksSearch(q, runId, minDurSec);
  const hits: ProviderHit[] = [];
  for (const it of items) {
    if (!sbReserveDownload(runId)) break; // budget spent — stop offering paid candidates
    hits.push({
      kind: "video",
      url: it.downloadUrl,
      dedupeId: `storyblocks:${it.id}`,
      thumbUrl: it.thumbnailUrl,
      author: null,
      sourceUrl: it.sourceUrl,
      license: "Storyblocks (per your API agreement)",
    });
  }
  return hits;
}

async function safe<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch {
    return [];
  }
}

/**
 * Internet Archive (archive.org) — vast CC/public-domain pool of vintage
 * commercials, industrial & educational films. Opt-in via FOOTAGE_SOURCES
 * ("archive"). Two-step API: advancedsearch for identifiers, then per-item
 * metadata to pick a reasonably small mp4 derivative.
 */
async function archiveSearch(query: string): Promise<ProviderHit[]> {
  const search = new URL("https://archive.org/advancedsearch.php");
  search.searchParams.set("q", `(${query.slice(0, 120)}) AND mediatype:(movies)`);
  search.searchParams.append("fl[]", "identifier");
  search.searchParams.append("fl[]", "title");
  search.searchParams.append("sort[]", "downloads desc");
  search.searchParams.set("rows", "8");
  search.searchParams.set("output", "json");
  const resp = await fetch(search, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`archive.org search ${resp.status}`);
  const data = (await resp.json()) as { response?: { docs?: { identifier?: string; title?: string }[] } };
  const docs = (data.response?.docs ?? []).filter((d) => d.identifier).slice(0, 3);

  const hits: ProviderHit[] = [];
  for (const d of docs) {
    try {
      const metaResp = await fetch(`https://archive.org/metadata/${encodeURIComponent(d.identifier!)}`, {
        headers: { "User-Agent": UA },
      });
      if (!metaResp.ok) continue;
      const meta = (await metaResp.json()) as {
        files?: { name?: string; size?: string; format?: string }[];
        metadata?: { licenseurl?: string; creator?: string };
      };
      // Smallest mp4 derivative under 80MB — archive masters are often huge MPEG2.
      const mp4s = (meta.files ?? [])
        .filter((f) => f.name?.toLowerCase().endsWith(".mp4") && Number(f.size || 0) > 0 && Number(f.size) < 80 * 1024 * 1024)
        .sort((a, b) => Number(a.size) - Number(b.size));
      const file = mp4s[0];
      if (!file?.name) continue;
      hits.push({
        kind: "video",
        url: `https://archive.org/download/${encodeURIComponent(d.identifier!)}/${encodeURIComponent(file.name)}`,
        dedupeId: `archive:${d.identifier}`,
        thumbUrl: `https://archive.org/services/img/${encodeURIComponent(d.identifier!)}`,
        author: meta.metadata?.creator ?? null,
        sourceUrl: `https://archive.org/details/${encodeURIComponent(d.identifier!)}`,
        license: meta.metadata?.licenseurl ?? "archive.org item license",
      });
    } catch {
      // skip this item, keep the rest
    }
  }
  return hits;
}

/**
 * Web-wide image search via Google Programmable Search (Custom Search JSON API).
 * Opt-in "web" source: needs GOOGLE_CSE_KEY + GOOGLE_CSE_CX (a search engine with
 * Image search enabled). Returns real photos from across the web — the broadest
 * still-image pool — each scored by the same vision pass. Free tier is 100
 * queries/day, then paid; returns [] when not configured.
 */
async function googleCseSearch(query: string, runId: string): Promise<ProviderHit[]> {
  const key = getSetting("GOOGLE_CSE_KEY");
  const cx = getSetting("GOOGLE_CSE_CX");
  if (!key || !cx) return [];
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query.slice(0, 120));
  url.searchParams.set("searchType", "image");
  url.searchParams.set("num", "8");
  url.searchParams.set("safe", "active");
  url.searchParams.set("imgSize", "large");
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  // Cost Monitoring — recorded on the ATTEMPT, since Google counts the query against
  // the daily allowance regardless of what it returns. Free below 100 queries/day and
  // billed above it, so the default rate is 0 and the recorded COUNT is the useful
  // number: it is what tells an operator they have left the free tier.
  recordGoogleCseQuery(runId);
  if (!resp.ok) throw new Error(`Google CSE ${resp.status}`);
  const data = (await resp.json()) as {
    items?: { link?: string; mime?: string; image?: { thumbnailLink?: string; contextLink?: string } }[];
  };
  return (data.items ?? [])
    .filter((it) => it.link && /^image\//.test(it.mime ?? "image/"))
    .map((it, i): ProviderHit => ({
      kind: "image",
      url: it.link as string,
      dedupeId: `web:${(it.link as string).slice(0, 80)}:${i}`,
      thumbUrl: it.image?.thumbnailLink || it.link,
      author: null,
      sourceUrl: it.image?.contextLink,
      license: "Web (user responsibility)",
    }));
}

/**
 * wigolo — web-wide image STILL search served by a local daemon (`wigolo serve`): no API
 * key, no per-query quota. Same role as `web`/Google CSE above (open-web pictures, same
 * "Web (user responsibility)" licence), and deliberately a separate provider rather than a
 * replacement, so the two can be compared by flipping FOOTAGE_SOURCES with no code change.
 *
 * It can never displace a stock VIDEO source: wigolo has no video surface at all (its
 * `category` enum is general|news|code|docs|papers|images), and this adapter only ever
 * emits `kind: "image"`.
 *
 * Response facts below were taken from the live daemon, not from its docs:
 *
 *  - `results[i].image_url` is the image FILE (serves 200 image/jpeg); `results[i].url` is
 *    the PAGE it was found on (commonly 403s for a non-browser client). Handing the
 *    downloader the page would feed it an HTML document. The same payload also carries an
 *    `images[]` array where the key `url` means the OPPOSITE — the file, with the page in
 *    `source_url`. We read `results[]` only; do not "unify" the two.
 *  - `sourceUrl` must stay the PAGE: hitLabel() derives the candidate's descriptive label
 *    from that slug, and the label feeds both the fallback scorer and the Gemini prompt.
 *  - `thumbnail_url` is a small CDN preview — what the vision scorer wants, so it never
 *    pulls a multi-megabyte original merely to judge relevance.
 *  - `width`/`height` come back per hit, so undersized results are dropped HERE. The stock
 *    APIs guarantee a usable size; open-web search does not.
 *  - `exclude_domains` matches the PAGE domain (and its subdomains), NOT the image CDN —
 *    verified: excluding "dreamstime.com" removes those results, excluding
 *    "thumbs.dreamstime.com" removes nothing. Stock agencies serve WATERMARKED comps, so
 *    the blocklist must be page domains or watermarks reach the finished video.
 *
 * Every failure — daemon down (ECONNREFUSED), timeout (AbortError), 4xx — leaves this
 * function by throwing, which gatherCandidates already logs and treats as an empty
 * provider. A stopped wigolo degrades the candidate pool; it never fails a run.
 */
/** One `results[]` entry. Everything is optional on purpose: the fields are validated at
 *  runtime rather than trusted, so a shape change upstream degrades to "no candidates"
 *  instead of throwing somewhere further down the beat. */
interface WigoloResult {
  /** The PAGE the image was found on — NOT the file. See the note above. */
  url?: unknown;
  /** The image FILE. */
  image_url?: unknown;
  thumbnail_url?: unknown;
  width?: unknown;
  height?: unknown;
}

/**
 * URL slugs stock libraries use to label generated imagery. Weak by construction —
 * unlabelled AI still gets through — but it is free and it never drops a real photo.
 *
 * Tested against BOTH the file URL and the page URL, because the label routinely appears on
 * only one of them. Real example from the captured fixture: the page is
 * `freepik.com/premium-ai-image/derelict-lighthouse…` while its file is
 * `img.freepik.com/premium-photo/derelict-lighthouse….jpg` — checking the file alone lets a
 * generated picture into the REAL-footage lane, which is precisely what this guard exists
 * to prevent (an AI image arriving here silently overrides the operator's real/AI split).
 */
const WIGOLO_AI_SLUG = /ai[-_]generated|ai[-_]image|midjourney|generated[-_]image/i;

async function wigoloSearch(query: string, runId: string): Promise<ProviderHit[]> {
  const base = (getSetting("WIGOLO_URL") || "").trim();
  if (!base) return []; // source configured but no daemon address → silently inert
  const exclude = (getSetting("WIGOLO_EXCLUDE_DOMAINS") || "")
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const minPx = Number(getSetting("WIGOLO_MIN_PX")) || 0;
  const token = (getSetting("WIGOLO_API_TOKEN") || "").trim();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  let data: unknown;
  try {
    const resp = await fetch(new URL("/v1/search", base), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Built here and never logged — `log()` calls below carry status and the body's
        // `error` text only, neither of which echoes the token back.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        query: query.slice(0, 120),
        category: "images",
        max_results: 12,
        ...(exclude.length ? { exclude_domains: exclude } : {}),
      }),
      signal: ctrl.signal,
    });
    // Verified against the live daemon: a rejected request is an HTTP RESPONSE carrying
    // `{ok:false, error, error_reason}` — NOT a thrown fetch error. Without this branch an
    // auth failure would parse as an empty result set and read as "the source found
    // nothing", sending anyone debugging it to look in entirely the wrong place.
    if (!resp.ok) {
      const detail = await resp
        .json()
        .then((b: { error?: string; error_reason?: string }) => b)
        .catch(() => ({}) as { error?: string; error_reason?: string });
      if (resp.status === 401 || detail.error_reason === "unauthorized") {
        throw new Error("wigolo rejected the API token (401) — check WIGOLO_API_TOKEN");
      }
      throw new Error(`wigolo ${resp.status}: ${(detail.error ?? "").slice(0, 120)}`);
    }
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  const raw = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(raw)) {
    log(runId, "debug", "wigolo returned no results array", { stage: "visual" });
    return [];
  }

  const hits: ProviderHit[] = [];
  for (const r of raw as WigoloResult[]) {
    const file = typeof r?.image_url === "string" ? r.image_url : "";
    if (!file) continue;
    const page = typeof r.url === "string" ? r.url : "";
    const w = typeof r.width === "number" ? r.width : 0;
    const h = typeof r.height === "number" ? r.height : 0;
    if (minPx && (w < minPx || h < minPx)) continue;
    if (WIGOLO_AI_SLUG.test(file) || WIGOLO_AI_SLUG.test(page)) continue;
    hits.push({
      kind: "image",
      url: file,
      // The FULL file URL, with no rank index and no truncation. The index would make one
      // picture a different id at a different position — the used-clip filter would then
      // miss it and the same photo could fill two shots — and an 80-char prefix collides
      // across CDN paths like static.example.com/system/resources/previews/… . dedupeId is
      // only ever a Set key in memory, so its length costs nothing.
      dedupeId: `wigolo:${file}`,
      thumbUrl: typeof r.thumbnail_url === "string" && r.thumbnail_url ? r.thumbnail_url : file,
      author: null,
      sourceUrl: page || undefined,
      license: "Web (user responsibility)",
    });
  }
  return hits;
}

function configuredProviders(): string[] {
  const raw = getSetting("FOOTAGE_SOURCES") || "pexels,pixabay,openverse,wikimedia";
  const list = raw
    .split(/[\n,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s in PROVIDERS || s === "youtube");
  return list.length > 0 ? list : ["pexels", "pixabay", "openverse", "wikimedia"];
}

/**
 * Phase 3 (Step 1) — inert async drop-in for spawnSync. A Promise-wrapped `spawn`
 * that reproduces spawnSync's RESULT CONTRACT so a call site can migrate by simply
 * replacing `spawnSync(file, args, opts)` with `await runAsync(file, args, opts)` and
 * keeping its existing `r.status` / `r.stdout` / `r.error` checks unchanged:
 *   - never rejects — always resolves with `{ status, signal, stdout, stderr, error }`;
 *   - returns string output when `encoding` is set, Buffer otherwise (spawnSync rule);
 *   - on timeout: kills the child (killSignal, default SIGTERM) and sets `error`
 *     (code ETIMEDOUT), matching spawnSync's timeout behavior;
 *   - on maxBuffer overflow (default 1 MiB, as spawnSync): kills + sets `error` ENOBUFS;
 *   - on spawn failure (ENOENT, …): `status: null` with `error` set.
 * The ONLY semantic gain over spawnSync is that it does not block the event loop while
 * the child runs — so concurrent beats' I/O and timers progress during a long download.
 * `downloadYouTube` is the (only) caller.
 *
 * Phase 3 (Step 3) — hardened after a CONFIRMED field hang (two frozen runs, both dead at
 * the YouTube step with no error). Three guarantees now hold, and they are load-bearing:
 *   1. it ALWAYS settles — see the "exit"/EXIT_DRAIN_MS handler below;
 *   2. it kills the process TREE, not just the direct child — see killTree();
 *   3. it distinguishes "stalled" (no output at all for `stallTimeout`) from "too slow"
 *      (`timeout`, the absolute cap), so a slow-but-progressing download is NOT killed.
 */
interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
  error?: Error;
}
interface RunOptions {
  encoding?: BufferEncoding;
  /** Absolute cap on total runtime. On expiry: kill tree + `error` code ETIMEDOUT. */
  timeout?: number;
  /**
   * Kill if NO stdout/stderr data arrives at all for this long. A working yt-dlp tree is
   * never silent for long (in the YouTube case the traffic is overwhelmingly the ffmpeg
   * grandchild's stderr — see the WARNING at the downloadYouTube call site), so total
   * silence is a solid "wedged" signal — unlike `timeout`, which cannot tell a stalled
   * socket from a slow-but-working one.
   * On expiry: kill tree + `error` code ESTALLED.
   */
  stallTimeout?: number;
  maxBuffer?: number;
  killSignal?: NodeJS.Signals;
  stdio?: "pipe" | "ignore";
  cwd?: string;
}

/**
 * The taskkill invocation, isolated so the "taskkill failed" branch of killTreeWin32() is
 * reachable from a test on any host — Windows is the platform we cannot execute here, and
 * it is precisely the client's, so the fallback must not be inspection-only.
 * Args verified for Windows: /pid <pid> /T (walk the tree) /F (force).
 */
type TaskkillResult = { error?: Error; status: number | null };
const runTaskkill = (pid: number): TaskkillResult =>
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 });

/**
 * win32 half of killTree(), split out for testability (see killTree's contract below).
 * `taskkill` is injected ONLY by the test; production always uses runTaskkill.
 *
 * Critically, spawnSync reports a failed spawn by RESULT, not by throwing — an ENOENT
 * taskkill (not on PATH) returns `{ error, status: null }` silently. Trusting a try/catch
 * here meant a failed taskkill killed NOTHING while looking like success: yt-dlp survives,
 * "exit" never fires, the promise never settles — the exact hang we are fixing, on the
 * exact platform we are fixing it for. So: inspect the result and always have a fallback.
 */
export function killTreeWin32(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  taskkill: (pid: number) => TaskkillResult = runTaskkill,
): void {
  const pid = child.pid;
  if (!pid || pid <= 0) return;
  let reaped = false;
  try {
    const r = taskkill(pid);
    reaped = !r.error && r.status === 0;
  } catch {
    // Defensive only — spawnSync is not expected to throw for a missing binary.
  }
  // Fallback when taskkill is unavailable/failed (not on PATH, access denied). child.kill()
  // cannot reach the ffmpeg grandchild, but it DOES kill yt-dlp → "exit" fires → the
  // exit-drain settles the promise → the beat fails over to stock/AI instead of wedging the
  // run forever. A leaked grandchild is a far smaller problem than a dead pipeline.
  if (!reaped) { try { child.kill(signal); } catch {} }
}

/**
 * Kill the child AND everything it spawned. The direct-child-only `child.kill()` is what
 * let the field hang happen: yt-dlp spawns an ffmpeg GRANDCHILD that inherits our stdout/
 * stderr pipes, so signalling only yt-dlp leaves ffmpeg alive holding the pipe write-ends.
 *   - win32: `taskkill /T` walks the tree, `/F` forces. Because /F is already a hard kill,
 *     the TERM→KILL escalation collapses to one effective call here; a repeat call is a
 *     harmless no-op (the pid is gone, taskkill just errors into /dev/null).
 *   - POSIX: the child is spawned `detached: true` so it leads its own process group (and
 *     ONLY its own — so kill(-pid) can never reach our own group); `kill(-pid)` signals the
 *     whole group. Falls back to the direct child on throw (e.g. ESRCH, group already reaped).
 */
function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    killTreeWin32(child, signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

/**
 * Ctrl+C insurance. `detached: true` put the child in its own process group, which is what
 * makes killTree() work — but it also means a SIGINT on the dev-server terminal no longer
 * propagates to yt-dlp/ffmpeg, so they would outlive the server as orphans (they did not
 * before `detached`). Track live children and reap the survivors on shutdown.
 */
const liveChildren = new Set<ReturnType<typeof spawn>>();
let shutdownHooked = false;
function hookShutdownOnce(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  // Registered ONCE for the process, not per spawn — a listener per spawn leaks and trips
  // MaxListenersExceededWarning. "exit" must stay synchronous: killTree's spawnSync/kill are.
  const reapAll = () => { for (const c of liveChildren) killTree(c, "SIGKILL"); liveChildren.clear(); };
  process.on("exit", reapAll);
  // Node's default SIGINT/SIGTERM behavior (exit) is suppressed once we listen, so re-exit
  // explicitly with the conventional 128+signo code — otherwise Ctrl+C would stop working.
  process.on("SIGINT", () => { reapAll(); process.exit(130); });
  process.on("SIGTERM", () => { reapAll(); process.exit(143); });
}

// Exported for src/lib/services/visual-source.runasync.test.ts only — this is internal
// plumbing, not part of the module's public surface; nothing outside imports it.
export function runAsync(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { encoding, timeout, stallTimeout, maxBuffer = 1024 * 1024, killSignal = "SIGTERM", stdio, cwd } = opts;
  const empty = (): string | Buffer => (encoding ? "" : Buffer.alloc(0));
  // DIAGNOSTIC (opt-in, YT_DIAG=1) — proves whether the child's "close" ever fires and
  // whether "exit" precedes it. Writes to stderr so it lands in the PM2 terminal log (the
  // incident's source of truth). Purely observational: it never affects settling, which
  // happens on "close"/"error" or — since the hang fix — on "exit" + EXIT_DRAIN_MS.
  const DIAG = process.env.YT_DIAG === "1";
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  return new Promise<RunResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // POSIX: `detached` makes the child a process-group leader so killTree() can signal
      // the whole group (yt-dlp + its ffmpeg grandchild) with kill(-pid). It does NOT
      // affect output capture — that only matters for stdio:"inherit", and we pipe. No
      // unref(): we still track this child and want the event loop held while it runs.
      child = spawn(file, args, {
        stdio: stdio === "ignore" ? "ignore" : "pipe",
        cwd,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({ status: null, signal: null, stdout: empty(), stderr: empty(), error: err as Error });
      return;
    }
    // Shutdown insurance for the process group `detached` just created. Registered after a
    // successful spawn only, and torn down in finish(), so a completed run leaves nothing behind.
    hookShutdownOnce();
    liveChildren.add(child);
    const pid = child.pid ?? -1;
    let exitAt = -1;
    if (DIAG) console.error(`[runAsync/diag] pid=${pid} spawn ${file.split(/[\\/]/).pop()} args=${args.slice(0, 3).join(" ")}… t=${ms()}ms`);

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;
    let timedOut = false;
    let stalled = false;
    let bufferError: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let escalating = false;

    // Phase 3 (Step 2/3) — TERM→KILL escalation, now over the whole process TREE. Send
    // killSignal (default SIGTERM) to the group once; if nothing has settled after a short
    // grace, force an uncatchable SIGKILL. Idempotent: re-entry (repeated over-buffer data
    // events) re-signals harmlessly but arms the kill timer only once.
    const KILL_GRACE_MS = 5000;
    const terminate = () => {
      killTree(child, killSignal);
      if (escalating) return;
      escalating = true;
      killTimer = setTimeout(() => {
        if (DIAG) console.error(`[runAsync/diag] pid=${pid} SIGKILL — not settled ${KILL_GRACE_MS}ms after ${killSignal}; exit=${exitAt < 0 ? "not-yet" : `${exitAt - t0}ms`}`);
        killTree(child, "SIGKILL");
      }, KILL_GRACE_MS);
    };

    const finish = (status: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      if (timer) clearTimeout(timer);
      if (stallTimer) clearTimeout(stallTimer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      const out = Buffer.concat(outChunks, outLen);
      const err = Buffer.concat(errChunks, errLen);
      // Precedence mirrors the order these can fire: an explicit error (spawn failure) wins,
      // then the absolute cap, then the stall watchdog, then over-buffer.
      const timeoutErr = timedOut ? Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) : undefined;
      const stallErr = stalled ? Object.assign(new Error("ESTALLED"), { code: "ESTALLED" }) : undefined;
      resolve({
        status,
        signal,
        stdout: encoding ? out.toString(encoding) : out,
        stderr: encoding ? err.toString(encoding) : err,
        error: error ?? timeoutErr ?? stallErr ?? bufferError,
      });
    };

    // Any byte on either pipe proves the tree is alive and working → restart the silence
    // clock. Armed only when a stallTimeout is requested, so other call sites are unaffected.
    const armStallTimer = () => {
      if (!stallTimeout || stallTimeout <= 0 || settled) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        if (DIAG) console.error(`[runAsync/diag] pid=${pid} STALLED — no output for ${stallTimeout}ms (t=${ms()}ms) → ${killSignal}`);
        terminate();
      }, stallTimeout);
    };

    child.stdout?.on("data", (d: Buffer) => {
      armStallTimer();
      outChunks.push(d);
      outLen += d.length;
      if (outLen > maxBuffer) {
        bufferError = Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ENOBUFS" });
        terminate();
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      armStallTimer();
      errChunks.push(d);
      errLen += d.length;
      if (errLen > maxBuffer) {
        bufferError = Object.assign(new Error("stderr maxBuffer length exceeded"), { code: "ENOBUFS" });
        terminate();
      }
    });
    armStallTimer();

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (DIAG) console.error(`[runAsync/diag] pid=${pid} TIMEOUT after ${ms()}ms → ${killSignal}`);
        terminate();
      }, timeout);
    }

    // THE HANG FIX. "close" (stdio EOF) is the happy path — it means we drained everything —
    // but it is NOT guaranteed to fire: a grandchild that inherited our stdout/stderr pipes
    // (yt-dlp's ffmpeg merge worker) holds the write-ends open even after yt-dlp itself dies,
    // so "exit" fires and "close" never does. That is the CONFIRMED cause of the field hang:
    // the promise never settled, so `await runAsync(...)` in downloadYouTube hung forever and
    // its ytDownloadLimiter slot leaked, wedging every other beat's YouTube download.
    // Two independent guards now close it: killTree() removes the grandchild that holds the
    // pipes, and this handler settles on "exit" regardless — once the process is gone we wait
    // only EXIT_DRAIN_MS for the tail of its output, then resolve with what we have. "close"
    // still wins the race in the normal case, so the healthy path is byte-for-byte unchanged.
    const EXIT_DRAIN_MS = 2000;
    child.on("exit", (code, signal) => {
      exitAt = Date.now();
      if (DIAG) console.error(`[runAsync/diag] pid=${pid} EXIT code=${code} signal=${signal} after ${exitAt - t0}ms (draining ≤${EXIT_DRAIN_MS}ms for "close"…)`);
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => {
        if (DIAG) console.error(`[runAsync/diag] pid=${pid} DRAIN EXPIRED — settling on "exit"; a grandchild is holding the stdio pipes open`);
        finish(code, signal);
      }, EXIT_DRAIN_MS);
    });
    child.on("error", (err) => {
      if (DIAG) console.error(`[runAsync/diag] pid=${pid} ERROR ${(err as Error).message} after ${ms()}ms`);
      finish(null, null, err);
    });
    child.on("close", (code, signal) => {
      if (DIAG) console.error(`[runAsync/diag] pid=${pid} CLOSE code=${code} signal=${signal} after ${ms()}ms (exit→close ${exitAt < 0 ? "n/a" : `${Date.now() - exitAt}ms`})`);
      finish(code, signal);
    });
  });
}

let ytDlpResolved: string | null | undefined;
// Phase 3 (Step 1) — cold-start guard. Once YouTube downloads run truly in parallel,
// the probe + one-time binary fetch below must happen ONCE, not once per concurrent
// beat. This holds the single in-flight resolution so late callers await it instead of
// racing to download to the same path; it is cleared on settle and the result is then
// memoized in `ytDlpResolved`.
let ytDlpInFlight: Promise<string | null> | undefined;
/**
 * Locate yt-dlp, auto-downloading the standalone binary on first use so the
 * non-technical operator doesn't have to install anything. Order: explicit
 * YT_DLP_PATH → cached download → on PATH → fresh download to the data dir.
 * Returns null if it can't be obtained (YouTube source then no-ops with a log).
 */
async function ensureYtDlp(runId: string): Promise<string | null> {
  if (ytDlpResolved !== undefined) return ytDlpResolved;
  // A concurrent caller is already probing/downloading — await its single resolution.
  // Placed BEFORE the filesystem checks so a late caller can't read a half-written
  // `cached` file mid-download (downloadToFile writes the whole buffer at once, but the
  // window is closed here regardless). No `await` between this check and the assignment
  // below, so two same-tick callers can't both create an in-flight promise.
  if (ytDlpInFlight) return ytDlpInFlight;

  const explicit = getSetting("YT_DLP_PATH");
  if (explicit && fs.existsSync(explicit)) return (ytDlpResolved = explicit);

  const isWin = process.platform === "win32";
  const binDir = path.join(DATA_DIR, "bin");
  const cached = path.join(binDir, isWin ? "yt-dlp.exe" : "yt-dlp");
  if (fs.existsSync(cached)) return (ytDlpResolved = cached);

  ytDlpInFlight = (async (): Promise<string | null> => {
    try {
      // Already on PATH?
      const probe = spawnSync(isWin ? "yt-dlp.exe" : "yt-dlp", ["--version"], { stdio: "ignore", timeout: 15000 });
      if (!probe.error && probe.status === 0) return (ytDlpResolved = isWin ? "yt-dlp.exe" : "yt-dlp");

      // Download the standalone binary once.
      const asset = isWin ? "yt-dlp.exe" : process.platform === "darwin" ? "yt-dlp_macos" : "yt-dlp";
      const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
      try {
        fs.mkdirSync(binDir, { recursive: true });
        log(runId, "info", "Downloading yt-dlp (one-time, for the YouTube source)…", { stage: "visual" });
        await downloadToFile(url, cached);
        if (!isWin) fs.chmodSync(cached, 0o755);
        log(runId, "success", "yt-dlp ready", { stage: "visual" });
        return (ytDlpResolved = cached);
      } catch (e) {
        log(runId, "warn", `Could not obtain yt-dlp (${(e as Error).message.slice(0, 100)}) — YouTube source disabled`, { stage: "visual" });
        return (ytDlpResolved = null);
      }
    } finally {
      ytDlpInFlight = undefined;
    }
  })();
  return ytDlpInFlight;
}

interface VideoMeta {
  durationSec?: number;
  /** Phase 1A — chapter markers for segment localization (empty when none). */
  chapters: { start: number; title: string }[];
}
/**
 * Read a YouTube video's metadata via ONE yt-dlp `--dump-json` (no download): duration
 * and chapters, for Phase 1A segment localization. Called ONLY when chapter localization
 * is enabled (YT_SEGMENT) — the license/CC check was removed (CC no longer gates), so this
 * is no longer on the default path.
 */
function fetchVideoMeta(bin: string, id: string): VideoMeta {
  const r = spawnSync(
    bin,
    ["--dump-json", "--skip-download", "--no-warnings", "--no-playlist", `https://www.youtube.com/watch?v=${id}`],
    { encoding: "utf8", timeout: 45000, maxBuffer: 32 * 1024 * 1024 }
  );
  if (r.status !== 0 || !r.stdout) return { chapters: [] };
  try {
    const j = JSON.parse(r.stdout) as {
      duration?: number;
      chapters?: { start_time?: number; title?: string }[] | null;
    };
    const chapters = (j.chapters ?? [])
      .map((c) => ({ start: Math.max(0, Math.floor(Number(c.start_time) || 0)), title: (c.title ?? "").trim() }))
      .filter((c) => c.title.length > 0);
    return { durationSec: j.duration, chapters };
  } catch {
    return { chapters: [] };
  }
}

const chapterTokenize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean);
/** Query keywords used for chapter matching (drop short tokens + stopwords). */
function chapterQueryTokens(query: string): string[] {
  return chapterTokenize(query).filter((t) => t.length > 2 && !IMG_STOPWORDS.has(t));
}
/**
 * Score EVERY chapter by query-keyword/title overlap, highest first. Pure, no network.
 * Shared by the localizer AND the YT_DEBUG diagnostic so both report identical numbers.
 */
function scoreChapters(query: string, chapters: { start: number; title: string }[]): { start: number; title: string; overlap: number }[] {
  const qTokens = chapterQueryTokens(query);
  return chapters
    .map((ch) => {
      const titleTokens = new Set(chapterTokenize(ch.title));
      let overlap = 0;
      for (const t of qTokens) if (titleTokens.has(t)) overlap++;
      return { start: ch.start, title: ch.title, overlap };
    })
    .sort((a, b) => b.overlap - a.overlap); // stable: ties keep original (chronological) order
}
/**
 * Phase 1A — chapter-based segment localization. Pick the chapter whose title best
 * overlaps the beat query's keywords and return its start offset (+2s to clear the
 * chapter's title-card cut), or null when there are no chapters / no keyword match
 * (→ caller keeps the existing blind offset). Pure, no network. Behind YT_SEGMENT.
 */
function localizeByChapters(query: string, chapters: { start: number; title: string }[]): number | null {
  if (chapters.length === 0) return null;
  const best = scoreChapters(query, chapters)[0];
  return best && best.overlap > 0 ? best.start + 2 : null;
}

// ── YouTube source-quality filters (Patch 1.8) ────────────────────────────
// Applied to the flat-playlist candidate list BEFORE download (no extra calls).
// HARD EXCLUSION — conservative clickbait/compilation/essay title markers. Does
// NOT include "documentary" (BBC/DW/PBS archival sources use it legitimately).
const YT_CLICKBAIT_TITLE =
  /\btop\s?\d+\b|\breaction\b|\bexplained\b|\bexplainer\b|\bessay\b|\btier list\b|\bdebunk\b|\bshocking\b|you won'?t believe|truth about|history of|why governments hate|what they don'?t tell you/i;
// HARD EXCLUSION (Patch 2.6) — low-quality formats that ytsearch surfaces once the CC
// results-page narrowing is gone. HIGH-PRECISION markers only (unlikely in genuine
// archival/news titles): YouTube Shorts hashtag, commentary/vlog/meme, livestream VODs.
// Deliberately NOT bare "shorts"/"live" (would hit old-film "shorts"/"Live Aid").
const YT_LOWQUALITY_TITLE =
  /#shorts\b|\bvlog\b|\bcommentary\b|\bmemes?\b|\breacts\b|\blivestream\b|live\s?stream|\bsound effects?\b|\bsfx\b/i;
// Music-topic channels: YouTube auto "Artist - Topic" + VEVO (channel-only — title
// VEVO matching dropped per review to avoid false positives).
const YT_MUSIC_CHANNEL = /\bvevo\b|-\s*topic$/i;
// SOFT PREFERENCE — archival/news markers (title OR channel); reorders, never excludes.
const YT_ARCHIVAL =
  /\barchive\b|\barchival\b|\bnewsreel\b|\bfootage\b|\boriginal\b|\bbroadcast\b|\breuters\b|associated press|ap archive|c-?span|bbc archive|nbc news|cbs news|abc news/i;
// WI-10 — b-roll source-shaping (gated by YT_BROLL_SHAPING). POSITIVE markers (title OR
// channel): clips that are visually clean by construction (no burned-in captions). Sorted
// to the front for contemporary beats.
const YT_BROLL =
  /\bb[-\s]?roll\b|\bcinematic\b|\b4k\b|\b8k\b|\baerial\b|\bdrone\b|\bhyperlapse\b|\btime[-\s]?lapse\b|\bno (commentary|music)\b|\bstock footage\b/i;
// WI-10 — NEGATIVE markers (title OR channel): news/explainer/talking-head sources that
// burn in chyrons/subtitles. DOWNRANKED to the tail (never excluded — they can still win
// if nothing cleaner scores).
const YT_NEWSY =
  /\bnews\b|\bcnbc\b|\bbloomberg\b|\bwsj\b|wall street journal|\bcnn\b|how .* works?|\binterview\b|\bpodcast\b|\bearnings\b|\breview\b/i;

/**
 * yt-dlp YouTube source — OPT-IN and OFF by default (copyright / ToS risk).
 * Only runs when YT_DLP_ENABLED = "1" AND "youtube" is in FOOTAGE_SOURCES.
 * License/CC filtering has been REMOVED: retrieval quality is the goal, license is no
 * longer a gating factor (YT_DLP_CC_ONLY is retained for backward compat but unused).
 * The operator is responsible for what they publish.
 */
type YtCandidate = { id: string; duration?: number; title?: string; channel?: string };

/**
 * WI-8 — search + rank ONCE per beat (metadata only, no download). Was the front
 * half of acquireYouTube; split out so youtubeScoredFallback's best-of-N loop no
 * longer re-runs `ytsearch` per candidate (closes F1). `usedIds` is read for dedup
 * but NOT mutated here (download claims the id). Returns the ranked candidate pool
 * (archival sources front-loaded), or [] when nothing usable.
 */
async function searchYouTube(
  runId: string,
  query: string,
  beatDurSec: number,
  usedIds: Set<string>,
  archival = false,
  queryType?: "entity" | "generic" | "abstract",
  noAugment = false
): Promise<YtCandidate[]> {
  const bin = await ensureYtDlp(runId);
  if (!bin) return [];
  const need = Math.ceil(beatDurSec) + 1;

  // Search (metadata only, no download). Patch 2.6b — robust `ytsearchN:` form; the
  // fragile CC results-page scrape is gone. No license pre-filter (CC gate removed).
  // WI-2: archival augmentation softened — dropped "newsreel" (it over-constrained niche
  // named subjects → [no-results]); "archival footage" still biases toward archival sources.
  // WI-10: contemporary beats augment with a b-roll hint (gated by YT_BROLL_SHAPING) to pull
  // caption-free cinematic footage instead of explainer/news clips. Both share the 2.6c
  // BARE-query fallback when the augmented form returns nothing (over-constrain guard).
  // Generic-only gate: the "cinematic b roll" hint helps GENERIC contemporary footage but HARMS
  // entity-heavy queries (e.g. "Parker shotgun close-up" pulled camera/filmmaking tutorials full
  // of text + talking heads). So it now fires ONLY for queryType==="generic"; entity / abstract /
  // undefined contemporary beats search the bare query. Archival branch unchanged.
  // #1: when the planner supplied a dedicated youtube_query (YT_SEPARATE_QUERY), it is ALREADY a
  // short title-optimized retrieval query → noAugment skips ALL suffix injection (no "cinematic
  // b roll" / "archival footage"), so a good query can't be re-poisoned by magnet tokens.
  const brollShaping = getSetting("YT_BROLL_SHAPING") === "1";
  const augmented = noAugment
    ? query
    : archival
      ? `${query} archival footage`
      : brollShaping && queryType === "generic"
        ? `${query} cinematic b roll`
        : query;
  const searchN = 15; // WI-10: deeper pool (was 12) — feeds the deep candidate sweep
  const tries = augmented === query ? [query] : [augmented, query]; // 2.6c bare-query fallback
  let candidates: YtCandidate[] = [];
  for (const q of tries) {
    if (q === augmented && augmented !== query) log(runId, "debug", `Beat: YouTube ${archival ? "archival" : "b-roll"}-augmented query "${q}"`, { stage: "visual" });
    const search = spawnSync(
      bin,
      [`ytsearch${searchN}:${q}`, "--dump-json", "--flat-playlist", "--no-warnings", "--playlist-end", String(searchN)],
      { encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024 }
    );
    // Patch 2.6a — classify + expose the real failure mode (was: one truncated debug line).
    const stderr = (search.stderr || "").trim();
    const stdoutEmpty = !search.stdout || !search.stdout.trim();
    if (search.status !== 0 || stdoutEmpty) {
      const cause = /sign in to confirm|not a bot|429|too many requests|HTTP Error 4\d\d/i.test(stderr)
        ? "bot/rate-limit"
        : /unable to extract|unsupported url|nothing found|could not|parse error/i.test(stderr)
          ? "extractor-failure"
          : stdoutEmpty
            ? "no-results"
            : "unknown";
      log(runId, "warn", `yt-dlp search [${cause}] q="${q}" status=${search.status} stdoutEmpty=${stdoutEmpty} stderr=${stderr.slice(0, 600)}`, { stage: "visual" });
      continue; // try the bare-query fallback (if any), else exhaust → return []
    }
    candidates = search.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { id?: string; duration?: number; title?: string; channel?: string };
        } catch {
          return null;
        }
      })
      .filter((c): c is YtCandidate => !!c?.id && !usedIds.has(`youtube:${c.id}`))
      .filter((c) => (c.duration == null ? true : c.duration >= need && c.duration <= 3600));
    if (candidates.length > 0) break; // got a usable pool — stop; else fall through to bare query
    log(runId, "debug", `Beat: YouTube search returned results but none usable after filters (q="${q}")`, { stage: "visual" });
  }
  if (candidates.length === 0) return [];

  // Source-quality filter (Patch 1.8): drop obvious clickbait/compilation/music, then
  // stable-sort by source tier. Missing title/channel → no-match (never excluded). Empty
  // result → [] → existing Stock/AI fallback.
  const isClickbait = (c: YtCandidate) =>
    YT_CLICKBAIT_TITLE.test(c.title ?? "") || YT_LOWQUALITY_TITLE.test(c.title ?? "") || YT_MUSIC_CHANNEL.test(c.channel ?? "");
  const isArchival = (c: YtCandidate) =>
    YT_ARCHIVAL.test(c.title ?? "") || YT_ARCHIVAL.test(c.channel ?? "");
  const cleaned = candidates.filter((c) => !isClickbait(c));

  // WI-10 — tiered ranking (gated by YT_BROLL_SHAPING). Single-membership by precedence
  // (else-if, no dupes), each tier stable in YouTube relevance order. b-roll/cinematic
  // sources lead for contemporary; archival leads for archival beats; news/explainer
  // sources sink to the tail (downranked, never excluded).
  if (!brollShaping) {
    // Legacy ranking (YT_BROLL_SHAPING=0): archival-to-front, nothing else reordered.
    return [...cleaned.filter(isArchival), ...cleaned.filter((c) => !isArchival(c))];
  }
  const isBroll = (c: YtCandidate) => YT_BROLL.test(c.title ?? "") || YT_BROLL.test(c.channel ?? "");
  const isNewsy = (c: YtCandidate) => YT_NEWSY.test(c.title ?? "") || YT_NEWSY.test(c.channel ?? "");
  const broll: YtCandidate[] = [], arch: YtCandidate[] = [], newsy: YtCandidate[] = [], neutral: YtCandidate[] = [];
  for (const c of cleaned) {
    if (isBroll(c)) broll.push(c);
    else if (isArchival(c)) arch.push(c);
    else if (isNewsy(c)) newsy.push(c);
    else neutral.push(c);
  }
  const lead = archival ? [...arch, ...broll] : [...broll, ...arch];
  return [...lead, ...neutral, ...newsy];
}

// Phase 3 (Step 2) — global cap on CONCURRENT yt-dlp segment downloads, shared across all
// beats of a run (and the whole process). Default 1 = serialized, i.e. byte-identical to the
// old blocking spawnSync behavior; the operator can raise it once parallel downloads prove
// stable. Separate from VISUAL_CONCURRENCY (which also governs Pexels/AI fetches) so the
// risky knob — concurrent YouTube hits from one IP — can be dialed independently. Memoized
// per process; rebuilt only if the setting value changes (safe: only changes between runs,
// never mid-flight). Clamp ceiling 8 keeps a fat-fingered value from spawning a yt-dlp swarm.
let ytDownloadLimit: ReturnType<typeof pLimit> | undefined;
let ytDownloadLimitN = -1;
function ytDownloadLimiter(): ReturnType<typeof pLimit> {
  const n = Math.max(1, Math.min(8, Number(getSetting("YT_DOWNLOAD_CONCURRENCY") || "1")));
  if (!ytDownloadLimit || ytDownloadLimitN !== n) {
    ytDownloadLimit = pLimit(n);
    ytDownloadLimitN = n;
  }
  return ytDownloadLimit;
}

/**
 * WI-8 — download a beat-length segment for ONE ranked candidate. Was the back half
 * of acquireYouTube. Claims the id in `usedIds`, picks the window (chapter-localized
 * when YT_SEGMENT, else duration-adaptive blind offset), downloads. Returns the
 * VisualResult on success, null if this candidate failed to download (caller advances
 * to the next ranked candidate). yt-dlp must already be resolved (search ran first).
 *
 * WI-9 — `startOverride` (segment-retry): when set, download exactly that window,
 * bypassing chapter-localize + the adaptive offset. The caller uses this to chase a
 * text-free segment of the SAME video after a text-veto on a relevant clip.
 */
async function downloadYouTube(
  runId: string,
  c: YtCandidate,
  query: string,
  beatDurSec: number,
  outPath: string,
  usedIds: Set<string>,
  startOverride?: number
): Promise<VisualResult | null> {
  const bin = await ensureYtDlp(runId);
  if (!bin) return null;
  const need = Math.ceil(beatDurSec) + 1;
  usedIds.add(`youtube:${c.id}`); // already present on a retry (Set dedup → harmless)

  let start: number;
  if (startOverride != null) {
    // WI-9 segment-retry: caller supplies an explicit window (no chapter/adaptive logic).
    start = startOverride;
  } else {
    // CC gate removed: no license filtering between search and download — the scorer decides.
    // fetchVideoMeta (one --dump-json) is called ONLY when chapter localization is on (YT_SEGMENT).
    const ytSegment = getSetting("YT_SEGMENT") === "1"; // Phase 1A: chapter localization
    let chapters: { start: number; title: string }[] = [];
    if (ytSegment) {
      chapters = fetchVideoMeta(bin, c.id).chapters;
    }
    // Phase 1A — localize the download window via CHAPTERS; null (no chapters / no
    // keyword match) → fall back to the existing duration-adaptive blind offset.
    const localized = ytSegment ? localizeByChapters(query, chapters) : null;
    if (localized != null) {
      start = localized;
      log(runId, "debug", `Beat: YouTube ${c.id} chapter-localized start=${start}s (from ${chapters.length} chapters)`, { stage: "visual" });
    } else {
      // Duration-adaptive segment offset: a fixed early start lands on the intro/
      // title cards of long videos (the confirmed false-negative cause). Sample
      // deeper into longer videos, clamped to never overrun the end.
      if (!c.duration || c.duration < 60) {
        start = c.duration && c.duration > 20 ? 8 : 0; // short/unknown → legacy early start
      } else if (c.duration <= 600) {
        start = Math.floor(c.duration * 0.35); // 1–10 min → ~35% in
      } else {
        start = Math.floor(c.duration * 0.5); // >10 min → ~50% in
      }
    }
    // Phase 1A validation diagnostic (YT_DEBUG only; chapters present only when ytSegment
    // fetched meta). One line per probed video to quantify chapter hit-rate, localization
    // success, and keyword-match quality (per-chapter overlaps). No behavior effect.
    if (ytSegment && getSetting("YT_DEBUG") === "1") {
      const scored = scoreChapters(query, chapters);
      const winner = scored.find((s) => s.overlap > 0);
      log(
        runId,
        "debug",
        `YT_CHAPTERS id=${c.id} nChapters=${chapters.length} | qTokens=[${chapterQueryTokens(query).join(" ")}] | ` +
          `match=${winner ? `"${winner.title.slice(0, 60)}"@${winner.start}s` : "NONE"} overlap=${winner?.overlap ?? 0} | ` +
          `start=${start}s (${localized != null ? "chapter" : "offset"}) | ` +
          `chapters=[${scored.map((s) => `"${s.title.slice(0, 40)}"~${s.overlap}@${s.start}s`).join(" | ")}]`,
        { stage: "visual" },
      );
    }
  }
  if (c.duration) start = Math.max(0, Math.min(start, c.duration - need - 1));
  // Phase 3 (Step 2) — async download (non-blocking), gated by the global YT_DOWNLOAD_CONCURRENCY
  // limiter. runAsync mirrors spawnSync's result contract, so the `dl.status` check below is
  // unchanged. The event loop stays free while yt-dlp runs, so concurrent beats' I/O and timers
  // (e.g. rerank AbortController) progress instead of starving.
  const dl = await ytDownloadLimiter()(() =>
    runAsync(
      bin,
      [
        "--download-sections", `*${start}-${start + need}`,
        "--force-keyframes-at-cuts",
        "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
        "--merge-output-format", "mp4",
        "--no-warnings", "--no-playlist",
        // ⚠ DO NOT ADD --quiet, SILENCE stderr, OR SWITCH TO stdio:"ignore" HERE. ⚠
        // The stall watchdog's correctness DEPENDS on the ffmpeg grandchild's stderr reaching
        // us. Measured on a real 30s section: yt-dlp's own stdout carries NO incremental
        // progress on this path (~7 lines, 486 B, ending in one terminal "[download] 100% of
        // 6.48MiB"); the ~12 KB of chatter that actually feeds the watchdog (`Input #0…`,
        // `frame=…`) is ffmpeg's stderr. Muffling it makes a HEALTHY download look silent and
        // ESTALLED will kill it after 90s — a false positive that looks exactly like the bug
        // this code exists to prevent.
        // --newline (line-buffered progress instead of \r-overwrites) is harmless but is
        // NEITHER required NOR sufficient, and is NOT why the fix works: --download-sections
        // + --force-keyframes-at-cuts select yt-dlp's FFMPEG downloader, and measurement shows
        // the \r-based chatter arrives as data events either way (67 vs 69 events; max silence
        // 1979ms with --newline vs 4768ms without — both far under the 90s watchdog).
        "--newline",
        // Likewise inoperative-but-harmless on today's code path: these govern yt-dlp's NATIVE
        // downloader, which --download-sections bypasses in favor of ffmpeg. Kept because they
        // cost nothing and would apply if the flags above ever change.
        "--socket-timeout", "30",
        "--retries", "3",
        "--fragment-retries", "3",
        "-o", outPath,
        `https://www.youtube.com/watch?v=${c.id}`,
      ],
      // Stall watchdog, not a blind deadline. The old flat 180s cap killed slow-but-working
      // downloads, so a throttled client could never get a YouTube clip at all. Now: 90s of
      // TOTAL silence means genuinely wedged → bail fast and fall through to Pexels/AI; but
      // as long as bytes keep arriving, allow up to 15 min for the download to complete.
      { encoding: "utf8", stallTimeout: 90_000, timeout: 900_000, maxBuffer: 16 * 1024 * 1024 }
    )
  );
  if (dl.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    log(runId, "info", `Beat: YouTube clip via yt-dlp (${c.id}, ${query})`, { stage: "visual" });
    return {
      path: outPath,
      kind: "video",
      provider: "youtube",
      attribution: {
        sourceUrl: `https://www.youtube.com/watch?v=${c.id}`,
        license: "YouTube (user responsibility)",
      },
      ytDebug: { id: c.id, title: c.title, durationSec: c.duration, segStart: start, segEnd: start + need },
    };
  }
  return null;
}

/** Human-readable title for a hit (slug from its page URL) — text the scorer reads. */
function hitLabel(h: ProviderHit): string {
  try {
    const p = new URL(h.sourceUrl || "").pathname;
    const slug = p.split("/").filter(Boolean).pop() || "";
    const words = decodeURIComponent(slug).replace(/\.[a-z0-9]+$/i, "").replace(/\d+/g, " ").replace(/[-_]+/g, " ").trim();
    if (words.length > 3) return words;
  } catch {}
  return h.dedupeId.replace(/^[a-z-]+:/, "").replace(/[-_]+/g, " ");
}

// Generic descriptors with low retrieval value. They DELIMIT the leading entity
// and are dropped FIRST when broadening. Colours, shot-type, and subject-filler.
// NOTE: intentionally excludes entity-starter words like "new"/"old" so names
// such as "New York City" are not truncated. Tunable.
const GENERIC_DESCRIPTORS = new Set(
  ("yellow orange red blue green white black brown gray grey purple pink bright dark colorful " +
   "big small large huge tiny tall short round square " +
   "crowd crowds aerial drone view shot wide closeup close angle establishing timelapse footage clip image photo picture scene background " +
   "people person man woman men women tourist tourists visitor visitors group kid kids child children " +
   "box shelf beautiful stunning cinematic realistic detailed").split(/\s+/)
);

/**
 * Broaden a query on retries WITHOUT destroying the leading named entity.
 * Capitalisation-INDEPENDENT: the protected entity is the LEADING run of
 * non-generic tokens (stops at the first generic descriptor), so it works for
 * lowercase fallback queries too. Generic descriptors are dropped first;
 * remaining meaningful (non-generic) words are trimmed per level.
 *   retry 1 → entity + up to 2 meaningful words
 *   retry 2 → entity only (or entity + 1 meaningful word when the entity is a
 *             single token, to retain product identity)
 *   retry 3 → the single most salient token (Real-footage-only mode's last-ditch
 *             broadening — the widest query we can still form). The normal
 *             3-attempt loop never passes a level above 2, so this is additive.
 */
export function broadenQuery(query: string, level: number): string {
  if (level <= 0) return query;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return query;

  const isGeneric = (t: string) => GENERIC_DESCRIPTORS.has(t.toLowerCase());

  // 1. Protected entity = leading run of non-generic tokens (no caps dependency), CAPPED.
  // The cap is load-bearing, not tidiness. Without it a query containing no generic
  // descriptor at all — most plain descriptive queries, e.g. "modern police patrol car
  // parked under" — has its ENTIRE text read as one entity, leaving nothing to drop: every
  // level returns the original string, acquireReal's triedQueries guard skips the retry as a
  // duplicate, and the three-attempt ladder silently collapses to one. Measured on 217 real
  // runs: 182 of 585 broaden attempts were discarded as identical.
  // Three words is what a real entity looks like ("Arm & Hammer", "Cummins P7100", "New York
  // City"); a six-word entity is an unbroadened sentence wearing the label.
  const MAX_ENTITY_TOKENS = 3;
  let entityEnd = 0;
  while (entityEnd < tokens.length && !isGeneric(tokens[entityEnd])) entityEnd++;
  entityEnd = Math.min(entityEnd, MAX_ENTITY_TOKENS);
  const entity = tokens.slice(0, entityEnd);

  // 2. Remaining meaningful (non-generic) words, in source order.
  const meaningful = tokens.slice(entityEnd).filter((w) => !isGeneric(w));

  // 2b. Strict-only: widest possible query — one token, entity first. When the query
  // is already a single token this returns it unchanged and acquireReal's triedQueries
  // guard skips the attempt, which is the intended no-op.
  if (level >= 3) return entity[0] ?? meaningful[0] ?? tokens[0];

  // 3. Keep entity + fewer meaningful words each retry; retry 2 is aggressive.
  const keepRest = level === 1 ? 2 : entity.length >= 2 ? 0 : 1;

  const chosen = entity.length
    ? [...entity, ...meaningful.slice(0, keepRest)]
    : meaningful.slice(0, level === 1 ? 4 : 2);

  // No leading entity and no meaningful words → last-resort position trim.
  if (chosen.length === 0) return tokens.slice(0, level === 1 ? 4 : 2).join(" ") || query;
  return chosen.join(" ");
}

const SOURCE_POOL_PER_PROVIDER = 5; // candidates pulled from each source
const SOURCE_POOL_MAX = 14;         // total candidates scored per attempt

/**
 * Gather candidates from EVERY enabled source for one search query (in
 * parallel, failure-isolated), tagged with their provider, deduped, and minus
 * anything already used. No early "first source wins" — the scorer picks the
 * global best across all sources.
 */
async function gatherCandidates(
  runId: string,
  searchQuery: string,
  beatDurSec: number,
  usedIds: ReadonlySet<string>
): Promise<ProviderHit[]> {
  const names = configuredProviders().filter((n) => n !== "youtube" && PROVIDERS[n]);
  const lists = await Promise.all(
    names.map(async (name) => {
      try {
        const hits = await PROVIDERS[name](searchQuery, runId, beatDurSec);
        return hits.slice(0, SOURCE_POOL_PER_PROVIDER).map((h) => ({ ...h, provider: name }));
      } catch (e) {
        log(runId, "debug", `${name} search failed: ${(e as Error).message.slice(0, 120)}`, { stage: "visual" });
        return [] as ProviderHit[];
      }
    })
  );
  return mergePools(lists, usedIds, SOURCE_POOL_MAX);
}

/** Every live source is guaranteed this many places before any source gets a second one. */
const SLOT_FLOOR = 1;
/**
 * How many of the pool's places one provider may claim, derived from the SAME weight table
 * that ranks candidates — so there is no second set of constants to drift out of step.
 * Halved and floored: weight 4 → 3 places, 3 → 3, 2 → 2, and everything at or below 0 → 1.
 */
function slotQuota(provider: string | undefined): number {
  const w = PREFILTER_PROVIDER_WEIGHT[provider ?? ""] ?? 0;
  return Math.min(SOURCE_POOL_PER_PROVIDER, SLOT_FLOOR + Math.max(0, Math.ceil(w / 2)));
}

/**
 * Merge each provider's (already per-provider-capped) hit list into ONE pool of at most
 * `max` candidates, skipping anything already used or already taken.
 *
 * Allocation is floor → quota → drain, strongest source first:
 *
 *  1. FLOOR — one place to every source that returned anything, so no source is ever locked
 *     out and a niche source can still surface the shot the big libraries don't carry.
 *  2. QUOTA — top each source up to slotQuota(), so the sources that actually deliver get
 *     more than a token place.
 *  3. DRAIN — any places still free go to the strongest sources with hits left.
 *
 * This replaces a plain round-robin by rank index, which handed every provider the same
 * number of places: with the shipped eight-source default that meant ranks 2-4 of EVERY
 * provider were unreachable — pexels, which supplies most chosen clips, was capped at two
 * candidates, exactly like archive, which supplies almost none. Each extra source a client
 * ticked took places away from the ones delivering, so the eighth tick made the pool worse.
 *
 * The DRAIN pass is load-bearing, not tidying: it guarantees this returns exactly as many
 * candidates as the round-robin did for EVERY input, including the common single-provider
 * pool. Reallocating places must never cost places — a smaller pool would flatter every
 * downstream metric while handing the scorer less to work with. Pinned by a property test.
 */
function mergePools(
  lists: ProviderHit[][],
  usedIds: ReadonlySet<string>,
  max: number
): ProviderHit[] {
  const seen = new Set<string>();
  const pool: ProviderHit[] = [];
  // A list's provider is read off its hits — gatherCandidates tags them before merging.
  const providerOf = (l: ProviderHit[]) => l[0]?.provider;
  // Order by WEIGHT, not by quota: quota is halved and floored, so it ties sources the
  // weights separate (pexels 4 and storyblocks 3 both quota 3) and the spare drained place
  // would go to whichever happened to be listed first. Sort is stable, so equal-weight
  // sources keep FOOTAGE_SOURCES order.
  const weightOf = (l: ProviderHit[]) => PREFILTER_PROVIDER_WEIGHT[providerOf(l) ?? ""] ?? 0;
  const ordered = lists.filter((l) => l.length).sort((a, b) => weightOf(b) - weightOf(a));

  const cursor = new Map<ProviderHit[], number>();
  const taken = new Map<ProviderHit[], number>();

  /** Next candidate from this list that is neither used nor already pooled. */
  const pull = (list: ProviderHit[]): ProviderHit | null => {
    let i = cursor.get(list) ?? 0;
    while (i < list.length) {
      const h = list[i++];
      if (!usedIds.has(h.dedupeId) && !seen.has(h.dedupeId)) {
        cursor.set(list, i);
        return h;
      }
    }
    cursor.set(list, i);
    return null;
  };
  const admit = (list: ProviderHit[], h: ProviderHit) => {
    seen.add(h.dedupeId);
    pool.push(h);
    taken.set(list, (taken.get(list) ?? 0) + 1);
  };

  for (const list of ordered) {
    if (pool.length >= max) return pool;
    const h = pull(list);
    if (h) admit(list, h);
  }
  for (const list of ordered) {
    const quota = slotQuota(providerOf(list));
    while ((taken.get(list) ?? 0) < quota && pool.length < max) {
      const h = pull(list);
      if (!h) break;
      admit(list, h);
    }
  }
  for (let progress = true; progress && pool.length < max; ) {
    progress = false;
    for (const list of ordered) {
      if (pool.length >= max) break;
      const h = pull(list);
      if (h) {
        admit(list, h);
        progress = true;
      }
    }
  }
  return pool;
}

/**
 * Fetch a candidate preview and normalize it for Gemini Vision.
 *
 * Gemini bills images in tiles. Keeping BOTH dimensions <= 384 px keeps a stock
 * thumbnail to the smallest image-token bucket while preserving enough detail for
 * subject/domain/B-roll relevance scoring. YouTube frame QC intentionally uses its
 * own higher-resolution path because it must detect small burned-in text.
 */
async function fetchThumb(url: string): Promise<{ mime: string; data: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!/^image\//.test(mime)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 4 * 1024 * 1024) return null; // skip empty/huge

    const optimized = await sharp(buf)
      .resize({ width: 384, height: 384, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();

    return { mime: "image/jpeg", data: optimized.toString("base64") };
  } catch {
    return null;
  }
}

/**
 * Score the whole candidate pool with ONE Gemini vision call and return the
 * single best hit if it clears the threshold. Gemini actually LOOKS at each
 * candidate's preview image (not just its title — that is why a clip titled
 * "yellow boxes" but showing Chinese soybean paste used to slip through) and
 * scores 0-100 for how well it fits BOTH the scene line AND the overall video
 * context. Fail-open: with no Gemini key or on error, falls back to the first
 * candidate so a run never stalls.
 */
// ── Ranking nudges (Phase 2) ──────────────────────────────────────────────
// Applied ONLY after the raw semantic threshold filter, to break ties /
// near-ties. They reorder candidates; they never change the raw Gemini score
// nor which candidates pass the threshold.
const VIDEO_BONUS = 4;
// Gemini-success acceptance bars (kind-specific): stock VIDEO is usable at a lower
// score than a still. Patch 2.0a: images accept >= 80 (was 85) to rescue the
// rubric's own "75-84 = strong supporting B-roll" band — the conservative upper
// half (80-84) — while still rejecting 75-79 borderline matches and keeping the
// image bar above AI's (AI_MATCH_THRESHOLD=75), so real footage stays the quality bar.
const VIDEO_MATCH_THRESHOLD = 75;
const IMAGE_MATCH_THRESHOLD = 80;
// Real-footage-only: pause before the single ladder retry. An all-providers-empty pool is
// usually a rate-limit spike rather than a true absence of footage, and this is the only
// cause a wait can fix. Bounded on purpose — the beat holds a pLimit slot while it waits.
const STRICT_RETRY_DELAY_MS = 30_000;
const PROVIDER_WEIGHT: Record<string, number> = {
  pexels: 4,
  // The only PAID source, video-only, professionally shot and always thumbnailed — top tier.
  // Below pexels so a free video still wins a straight tie; above pixabay because
  // storyblocksSearch books the run's download budget at SEARCH time (storyblocks.ts), so a
  // demoted storyblocks hit has already spent a slot and bought nothing with it. Ranking it
  // low is the worst of both worlds, not the cautious choice.
  storyblocks: 3,
  pixabay: 2,
  youtube: 1,
  wikimedia: -1,
  openverse: -2,
  web: -3,
  // Same tier as `web` — the same kind of source (unlicensed open-web stills). The entry is
  // REQUIRED, not cosmetic: an unlisted provider falls back to 0, which would rank wigolo
  // THIRD, above wikimedia/openverse/web/archive, purely by omission. Listing it at -3 keeps
  // every existing provider's relative order exactly as it was.
  wigolo: -3,
  archive: -4,
};
/** Ranking score = raw semantic score + provider weight + video bonus. */
function rankKey(s: { hit: ProviderHit; score: number }): number {
  return s.score + (PROVIDER_WEIGHT[s.hit.provider ?? ""] ?? 0) + (s.hit.kind === "video" ? VIDEO_BONUS : 0);
}

// ── Gemini load reduction (Phase 1) ───────────────────────────────────────
// Only the strongest few candidates reach the heavy multimodal scoring call.
const MAX_GEMINI_CANDIDATES = 6;
const PREFILTER_PROVIDER_WEIGHT: Record<string, number> = {
  pexels: 4,
  // See PROVIDER_WEIGHT. At 3 the Gemini bypass is unaffected — a pexels video (9) leads a
  // storyblocks one (8) by 1, far short of the >= 6 margin — so this changes ranking only,
  // never how many candidates skip the vision check. Pinned by visual-source.weights.test.ts.
  storyblocks: 3,
  pixabay: 2,
  youtube: 1,
  wikimedia: -1,
  openverse: -2,
  web: -3,
  // Mirrors PROVIDER_WEIGHT above — see the note there for why omission is not neutral.
  // Keeping the two tables in step also keeps poolIsWeak's verdict unchanged: a wigolo
  // still scores -3 + 0 + 1(thumb) = -2, so an all-wigolo pool stays "weak" exactly as an
  // all-web pool does today, and the route-to-AI gate behaves as it did before.
  wigolo: -3,
  archive: -4,
};
/**
 * How much the lexical match is allowed to move the pre-Gemini cut.
 *
 * The whole design decision is in this number. `lexicalMatchScore` spans roughly [-30, +120]
 * while `heuristicScore` spans [-4, +9], so passing the lexical score through undamped would
 * hand the cut entirely to whichever candidate's filename echoes the query — which open-web
 * sources win by SEO, not by being right — and trade pexels VIDEO for stills. At 0.1 the
 * lexical band becomes [-3, +12], commensurate with provenance rather than dominant:
 *
 *   pexels video, matches nothing      9 + 0.1*(-30) =  6.0
 *   archive still, matches everything -3 + 0.1*(120) =  9.0   ← survives the cut (the point)
 *   pexels video, matches one word     9 + 0.1*(33)  = 12.3   ← still beats it (also the point)
 *
 * So a candidate that matches the scene outranks one that matches nothing, but a merely
 * PARTIAL match never overturns a strong video. Pinned numerically by visual-prefilter.test.ts
 * so this cannot drift silently.
 */
const LEX_WEIGHT = 0.1;

/**
 * Cheap prefilter applied BEFORE the Gemini vision call: keep only the top
 * MAX_GEMINI_CANDIDATES so weak archive/web/no-thumbnail candidates don't burn image tokens.
 *
 * Ranked by provider/kind/thumbnail provenance PLUS a damped lexical match against the scene
 * query. Provenance alone decided this for a long time, which meant an archive still that was
 * exactly about the scene lost to an off-topic pexels clip by -4 vs +4 before anything looked
 * at either — the reason historical topics missed footage that demonstrably existed.
 *
 * Costs nothing: `lexicalMatchScore` is local string work, and the candidate count handed to
 * Gemini is unchanged. The semantic scoring + rankKey() ordering afterwards is untouched.
 */
function prefilterCandidates(pool: ProviderHit[], sceneQuery: string, runId: string, beatIndex: number): ProviderHit[] {
  if (pool.length <= MAX_GEMINI_CANDIDATES) return pool;
  const rank = (h: ProviderHit) => heuristicScore(h) + LEX_WEIGHT * lexicalMatchScore(sceneQuery, h);
  const filtered = [...pool].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_GEMINI_CANDIDATES);
  log(runId, "debug", `Beat ${beatIndex}: prefilter reduced candidate pool: ${pool.length} -> ${filtered.length}`, { stage: "visual" });
  return filtered;
}

/** Heuristic score used by both the prefilter and the Gemini-bypass shortcut. */
function heuristicScore(h: ProviderHit): number {
  return (PREFILTER_PROVIDER_WEIGHT[h.provider ?? ""] ?? 0) + (h.kind === "video" ? 4 : 0) + (h.thumbUrl ? 1 : 0);
}

/**
 * Smart Gemini bypass: if the pool's top candidate is a STRONG hit (Pexels video
 * with a thumbnail) AND it dominates every other candidate by >= 6 heuristic
 * points (or is the only candidate), accept it directly and skip the heavy vision
 * call. Returns the dominant candidate, or null if no clear winner exists.
 */
function shouldBypassGemini(pool: ProviderHit[]): ProviderHit | null {
  if (pool.length === 0) return null;
  const ranked = [...pool].sort((a, b) => heuristicScore(b) - heuristicScore(a));
  const best = ranked[0];
  if (!(best.provider === "pexels" && best.kind === "video" && best.thumbUrl)) return null;
  const second = ranked[1];
  if (second && heuristicScore(best) - heuristicScore(second) < 6) return null;
  return best;
}

/**
 * The purely LEXICAL half of the fallback score: query→candidate token overlap against the
 * candidate's available metadata (its slug-derived label + author — ProviderHit carries no
 * description/tags), an entity-phrase boost, and a zero-overlap penalty. Range ≈ [-30, +120].
 *
 * Split out from fallbackSemanticScore so the prefilter can weigh relevance WITHOUT
 * double-counting the provider weight it already applies itself. Carries no provider or kind
 * term by design — callers add their own.
 */
function lexicalMatchScore(query: string, h: ProviderHit): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean);
  const qTokens = norm(query).filter((t) => !IMG_STOPWORDS.has(t));
  if (qTokens.length === 0) return 0; // no lexical signal → caller's provider/kind terms only

  const candWords = norm(`${hitLabel(h)} ${h.author ?? ""}`);
  const candSet = new Set(candWords);
  const candStr = candWords.join(" ");

  let matched = 0;
  for (const t of qTokens) if (candSet.has(t)) matched++;
  const overlap = matched / qTokens.length; // 0..1

  let score = overlap * 100;

  // +20 if the leading product/entity phrase appears (the plan stage places the
  // entity at the FRONT of visual_query): bigram match, or a strong single token.
  const bigram = qTokens.length > 1 ? `${qTokens[0]} ${qTokens[1]}` : "";
  if ((bigram && candStr.includes(bigram)) || (qTokens[0].length >= 4 && candSet.has(qTokens[0]))) {
    score += 20;
  }
  // -30 if the candidate shares no query tokens at all.
  if (matched === 0) score -= 30;

  return score;
}

/** A scored candidate, and the candidates the pre-Gemini cut set aside unscored. */
interface ScoredPool {
  picks: { hit: ProviderHit; score: number; fallback?: boolean }[];
  reserve: ProviderHit[];
}

/** Lexical-fallback acceptance bars — used when no Gemini score exists for a candidate. */
const LEX_VIDEO_BAR = 65;
const LEX_IMAGE_BAR = 80;

/**
 * Last resort before a beat gives up on real footage: the candidates the pre-Gemini cut
 * dropped, judged on the SAME lexical bars the pipeline already trusts whenever Gemini is
 * unavailable.
 *
 * These were fetched and paid for during the normal attempts and then thrown away, so a beat
 * could go off and generate AI while a usable real clip sat in memory. Scoring them costs
 * nothing — no Gemini call, no extra inline image — because the bar here is lexical by
 * design, not by fallback.
 *
 * Deliberately NOT a relaxation of the bar: a candidate still has to match the query to be
 * admitted. The reserve is by construction what the cut judged weakest, so admitting anything
 * that merely exists would trade a generated image for a bad real one.
 */
function reserveCandidates(
  reserve: ProviderHit[],
  query: string,
  usedIds: ReadonlySet<string>
): { hit: ProviderHit; score: number }[] {
  return reserve
    .filter((h) => !usedIds.has(h.dedupeId))
    .map((hit) => ({ hit, score: fallbackSemanticScore(query, hit) }))
    .filter((c) => (c.hit.kind === "video" ? c.score >= LEX_VIDEO_BAR : c.score >= LEX_IMAGE_BAR))
    .sort((a, b) => rankKey(b) - rankKey(a));
}

/**
 * Lightweight lexical-similarity score, used ONLY when Gemini scoring is
 * unavailable (no key / 503 / invalid response). It measures query→candidate
 * token overlap, then adds the same provider/video preference.
 * Final score = overlap*100 + provider_weight + video_bonus (+20 / -30).
 *
 * Value is byte-identical to the pre-split version — including the no-token case, where
 * lexicalMatchScore returns 0 and this returns provVid alone, exactly as before. Pinned by
 * golden values in visual-prefilter.test.ts.
 */
function fallbackSemanticScore(query: string, h: ProviderHit): number {
  const provVid = (PREFILTER_PROVIDER_WEIGHT[h.provider ?? ""] ?? 0) + (h.kind === "video" ? 4 : 0);
  return provVid + lexicalMatchScore(query, h);
}

// ── Stock-impossibility detector ──────────────────────────────────────────
// Some queries are conceptually right but hopeless for stock retrieval
// (chemistry/process abstractions) — route those straight to AI generation.
const AI_PREFER_KEYWORDS = [
  "surfactant", "catalyst", "molecule", "molecular", "chemical", "chemistry",
  "surface tension", "reaction", "alkaline",
];
/** A capitalised proper-noun token or "&" marks a strong product/entity query. */
function hasLikelyEntity(query: string): boolean {
  return /[A-Z]/.test(query) || query.includes("&");
}

/**
 * Does this beat name a specific real subject — one worth protecting from the gates that
 * hand a beat to AI generation?
 *
 * Two gates read this: the weak-pool surrender (weakPoolVerdict) and the chemistry-keyword
 * exemption in getAiPreferenceReason, which skips stock retrieval ENTIRELY. So the answer
 * decides, run-wide, which beats are even allowed to try stock.
 *
 * It used to be `hasLikelyEntity` alone: a capital letter or an ampersand. That protected
 * "Cummins P7100" and abandoned "steel mill workers 1940s" — an era, a trade and a decade,
 * every bit as specific, and well covered by stock. A cheap, expensive and invisible routing
 * decision was being made on letter case.
 *
 * The planner already classifies each beat, from the NARRATION rather than from the query
 * string, and the values are validated to a union before they reach the beat. When a field is
 * present it is AUTHORITATIVE, including in the negative direction — OR-ing the text
 * heuristic back in "for safety" would preserve the exact defect, since "Steel Mill Workers
 * 1940s" is protected by its capitals whatever the planner says. The text test survives only
 * as the fallback for beats that carry no planner fields (a Gemini-503 chunk, an older plan).
 */
function entityProtected(beat: Beat | undefined, query: string): boolean {
  if (beat?.productLabel?.trim()) return true; // a named product is an entity by definition
  if (beat?.queryType === "entity") return true;
  // Archival beats have thin stock pools BY NATURE, and surrendering them is the worst trade
  // available: AI cannot produce archival footage, only an imitation of it.
  if (beat?.footageKind === "archival") return true;
  if (beat?.queryType === "generic" || beat?.queryType === "abstract") return false;
  return hasLikelyEntity(query);
}
/**
 * Returns the chemistry/process KEYWORD that makes a query stock-unfriendly
 * (→ prefer AI), or null. Short but stock-searchable queries ("sunrise",
 * "detergent bottle", "laundry room") return null. Strong product/entity queries
 * (Tide, Walmart, Arm & Hammer) are EXEMPT (null). The keyword is surfaced so the
 * caller can log WHY a beat was routed to AI.
 */
function getAiPreferenceReason(query: string, beat?: Beat): string | null {
  if (!query.trim()) return null;
  if (entityProtected(beat, query)) return null; // protect product/entity/archival beats
  const q = query.toLowerCase();
  return AI_PREFER_KEYWORDS.find((k) => q.includes(k)) ?? null; // keyword name, else null
}

// ── Per-beat AI media routing (Patch 1: consumer + fallback) ───────────────
// CONSERVATIVE by design — this is only a SAFETY NET for when the planner did
// not emit beat.aiMedia (Gemini-503 chunk, missing/invalid field). The planner
// (Patch 2) is the primary decision-maker, so this list is deliberately limited
// to unambiguous, motion-defining stems. Generic stems (flow/wave/motion/spread)
// are intentionally EXCLUDED to avoid false-positive video selection.
const AI_VIDEO_KEYWORDS = [
  "explod", "particle", "splash", "collid", "morph", "transform", "swirl", "dissolv",
];
/**
 * Deterministic fallback verdict from the beat's text/prompt. Returns "video"
 * only on a strong motion stem, else null (→ resolver falls to global default).
 * Never returns "image" explicitly — absence of a motion signal is expressed as
 * null so the global default (image) owns the terminal decision.
 */
function keywordHeuristic(beat: Beat): "video" | null {
  const hay = `${beat.aiPrompt ?? ""} ${beat.visualQuery ?? ""} ${beat.text ?? ""}`.toLowerCase();
  return AI_VIDEO_KEYWORDS.some((k) => hay.includes(k)) ? "video" : null;
}
/**
 * Resolve the AI media kind for one beat. The global KIE_AI_MEDIA mode gates the
 * layered chain: "image"/"video" are HARD overrides (today's behavior); "auto"
 * enables per-beat routing — planner verdict → keyword heuristic → image default.
 * Returns the chosen media plus the reason (for logging / diagnostics).
 */
function resolveAiMedia(beat: Beat, override?: "image" | "video"): { media: "image" | "video"; reason: string } {
  // Fallback override wins over everything: this is the AI-fallback path (a real beat with
  // no findable footage) and FALLBACK_AI_MEDIA has pinned the media it may generate. Only
  // ever passed on the fallback path, so normal AI beats still fall through to the logic
  // below unchanged.
  if (override === "image" || override === "video") return { media: override, reason: `fallback:${override}` };
  const mode = (getSetting("KIE_AI_MEDIA") || "image").toLowerCase();
  if (mode === "image" || mode === "video") return { media: mode, reason: `global:${mode}` };
  // The operator's run-level photo/video ratio. applyAiVideoRatio OVERWRITES beat.aiMedia,
  // so the branch below would already return the same value — this one exists to say WHO
  // chose it, and the reason string is what the run log shows. Treat it as provenance, not
  // control flow; the media a beat gets is identical with or without it.
  // Its position is still load-bearing in one direction: it must stay BELOW the global hard
  // modes, so a run can never generate video against an explicit "images only".
  if (beat.aiMediaPinned && (beat.aiMedia === "image" || beat.aiMedia === "video")) {
    return { media: beat.aiMedia, reason: "run-ratio" };
  }
  // empty defaults to image above; explicit "auto" (or any unrecognized value) → per-beat routing
  if (beat.aiMedia === "video" || beat.aiMedia === "image") return { media: beat.aiMedia, reason: "planner" };
  const kw = keywordHeuristic(beat);
  if (kw) return { media: kw, reason: "keyword" };
  return { media: "image", reason: "default" };
}

/** (3) A first-gather pool with no video and only low-tier image providers. */
function poolIsWeak(pool: ProviderHit[]): boolean {
  if (pool.length === 0) return true;
  if (pool.some((h) => h.kind === "video")) return false;
  return Math.max(...pool.map(heuristicScore)) <= 0;
}
/**
 * What to do about a weak pool: score it anyway, broaden and look again, or give up on stock.
 *
 * Pure and exported for test, because the rule is easy to get subtly wrong. It used to be
 * "attempt 0 only, then route to AI", which meant the verdict "stock does not have this" was
 * reached on the PLANNER'S FIRST query — the most abstract of the three the ladder will try —
 * with attempts 1 and 2 never running at all.
 *
 * Now the first weak pool only earns a broadening. Giving up additionally requires that NO
 * attempt so far produced a strong pool (`weakSoFar`): broadening deliberately makes a query
 * vaguer, so a weak pool that FOLLOWS a strong one is evidence about the broadened query, not
 * about stock's coverage of the subject — and that case is scored rather than surrendered.
 */
function weakPoolVerdict(o: {
  attempt: number;
  weakSoFar: boolean;
  strict: boolean;
  entityProtected: boolean;
  pool: ProviderHit[];
}): "score" | "broaden" | "route-ai" {
  // Strict forbids AI outright, and a named entity is worth more attempts than a guess is.
  if (o.strict || o.entityProtected || !poolIsWeak(o.pool)) return "score";
  if (o.attempt === 0) return "broaden";
  return o.weakSoFar ? "route-ai" : "score";
}

/** Human-readable weak-pool summary for diagnostics only (no control-flow effect). */
function explainWeakPool(pool: ProviderHit[]): string {
  const videos = pool.filter((h) => h.kind === "video").length;
  const best = pool.length ? Math.max(...pool.map(heuristicScore)) : 0;
  const providers = [...new Set(pool.map((h) => h.provider ?? "?"))];
  return `candidates=${pool.length}, videos=${videos}, bestScore=${best}, providers=[${providers.join(",")}]`;
}

async function scoreAndPick(
  runId: string,
  beatIndex: number,
  sceneQuery: string,
  sceneText: string,
  videoContext: string | undefined,
  pool: ProviderHit[]
): Promise<ScoredPool> {
  if (pool.length === 0) return { picks: [], reserve: [] };
  const threshold = Math.max(0, Math.min(100, Number(getSetting("REAL_MATCH_THRESHOLD") || "85")));
  const apiKey = getSetting("GOOGLE_API_KEY");
  // scoring intentionally off → accept, rankKey() orders
  if (threshold <= 0) return { picks: pool.map((h) => ({ hit: h, score: threshold })), reserve: [] };
  if (!apiKey) {
    log(runId, "debug", `Beat ${beatIndex}: no Gemini key — lexical fallback scoring`, { stage: "visual" });
    // No prefilter on this path (it never ran here), so the whole pool is scored and
    // nothing is held back — there is no reserve because nothing was dropped.
    return { picks: pool.map((h) => ({ hit: h, score: fallbackSemanticScore(sceneQuery, h), fallback: true })), reserve: [] };
  }

  // Prefilter to the strongest few BEFORE the heavy multimodal call (Gemini load reduction).
  const gathered = pool;
  pool = prefilterCandidates(pool, sceneQuery, runId, beatIndex);
  // What the cut dropped. Already fetched and free; the caller keeps it as a last resort
  // before paying for AI, rather than discarding candidates it has already paid to find.
  const kept = new Set(pool.map((h) => h.dedupeId));
  const reserve = gathered.filter((h) => !kept.has(h.dedupeId));

  const circuit = beginVisionCall(runId);
  if (!circuit.allow) {
    return { picks: pool.map((h) => ({ hit: h, score: fallbackSemanticScore(sceneQuery, h), fallback: true })), reserve };
  }

  const thumbs = await Promise.all(pool.map((h) => (h.thumbUrl ? fetchThumb(h.thumbUrl) : Promise.resolve(null))));

  // Build a single multimodal request: instructions + (title + image) per candidate.
  const parts: ({ text: string } | { inline_data: { mime_type: string; data: string } })[] = [
    {
      text:
        `You are choosing the single best stock clip for ONE scene of a documentary video.\n` +
        `OVERALL VIDEO TOPIC: "${(videoContext || sceneText).slice(0, 400)}"\n` +
        `THIS SCENE (narration): "${sceneText.slice(0, 240)}"\n` +
        `WANTED VISUAL: "${sceneQuery}"\n\n` +
        `Below are numbered candidates (each: a title line saying whether it is a VIDEO or IMAGE, then its preview image). ` +
        `For EACH, score 0-100 using these criteria in order:\n` +
        `1. Semantic relevance [PRIMARY]: does it match THIS scene AND the overall video topic.\n` +
        `2. Prefer moving VIDEO footage over static images when both fit equally well.\n` +
        `3. Prefer cinematic documentary shots: wide shots, establishing shots, aerial shots, clean composition.\n` +
        `4. Penalize: static portraits, single-subject snapshots, retro/dated stills, amateur quality, cluttered framing, low resolution.\n` +
        `DOMAIN RULE: footage from a DIFFERENT real-world domain than the video topic is WRONG — score it 39 or below. ` +
        `Example: for a laundry-detergent video, a bowl of food / whipped cream / baking ingredients, a random street, a person's face, or an unrelated product is OFF-TOPIC even if the colours or shapes match the wanted visual. ` +
        `AUTHENTICITY RULE: this is a DOCUMENTARY — footage must look like a real photograph or real video, not a fabrication. ` +
        `Score 39 or below if the candidate shows ANY of: (a) gibberish, garbled, misspelled, or nonsensical text/letters/numbers; ` +
        `(b) fake, invented, or implausible brand names, labels, or logos; ` +
        `(c) an OBVIOUS CGI / 3D-render / digital-illustration / animated depiction of a REAL-WORLD subject (e.g. a rendered "chip", a rendered building, a rendered person) when real footage is expected; ` +
        `(d) other clearly synthetic artifacts (impossible geometry, plastic/over-smooth surfaces, melted or warped detail). ` +
        `A polished or cinematic look does NOT excuse fabrication — authenticity OVERRIDES criterion 3. ` +
        `Do NOT apply this rule to abstract motion-graphics that are clearly meant to be graphics, nor to real footage that merely contains coherent, correctly-spelled real-world text, signage, or logos. ` +
        `NON-B-ROLL RULE (Patch 2.3b): score 39 or below when the candidate's PRIMARY content is a TALKING-HEAD / ` +
        `PRESENTATION format rather than depictive B-roll — a person addressing the camera in an interview, podcast, ` +
        `webcam/selfie shot, news-desk anchor, creator commentary, conference keynote or lecture-to-camera, or a ` +
        `slide/presentation deck (commentary ABOUT the subject, not footage OF it). ` +
        `CARVE-OUT: do NOT penalize when the person/event shown IS the wanted subject itself (a historical/newsworthy ` +
        `figure giving the actual depicted address, or genuine archival broadcast of the real event). ` +
        `BUT do NOT penalize footage merely for lacking the EXACT brand, SKU, on-pack label, or historical era — stock libraries rarely have those, and generic SAME-CATEGORY footage is valid supporting B-roll ` +
        `(this leniency NEVER excuses fabricated/gibberish text or fake labels, which are penalized by the AUTHENTICITY RULE above). ` +
        `SCORING BANDS: 100 = exactly the wanted subject, perfect. ` +
        `85-95 = exact domain AND highly usable (clearly on-topic, well shot). ` +
        `75-84 = same product/subject CATEGORY — strong supporting B-roll (e.g. a generic washing-soda or detergent box / cleaning aisle when the wanted visual names a specific brand). ` +
        `40-74 = only loosely related to the topic. ` +
        `0-39 = wrong domain, misleading, low quality, OR fake/CGI/gibberish-text (see AUTHENTICITY RULE). ` +
        `Judge what you actually SEE, not the title. Return STRICTLY JSON: [{"i":<int>,"score":<int>}]. No markdown.`,
    },
  ];
  pool.forEach((h, i) => {
    parts.push({ text: `[${i}] ${h.kind} from ${h.provider}: ${hitLabel(h)}` });
    const thumb = thumbs[i];
    if (thumb) parts.push({ inline_data: { mime_type: thumb.mime, data: thumb.data } });
  });

  const model = getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL");
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 8000, thinkingConfig: { thinkingBudget: 0 } },
  });
  // Cost-optimized Vision resilience: stay on VISION_MATCH_MODEL (Flash-Lite by default)
  // and make at most two attempts. A transient Vision outage must not escalate this
  // high-volume multimodal payload to the more expensive planner model; after two failures
  // we fall back to the local lexical scorer below.
  try {
    const { json: j } = await callGemini({
      apiKey,
      model,
      body,
      maxAttempts: circuit.probe ? 1 : 2,
      allowModelFallback: false,
      timeoutMs: 30_000, // bound the per-beat vision call: no timeout = a slow/overloaded Gemini hangs the run forever (fails open below)
      backoffMs: (n) => 1500 * n,
      validate: (json, usedModel) => {
        // Cost Monitoring — vision scoring; image tokens are inside promptTokenCount.
        recordGemini(runId, "geminiVision", json.usageMetadata?.promptTokenCount ?? 0, json.usageMetadata?.candidatesTokenCount ?? 0, usedModel);
        const cand = json.candidates?.[0];
        const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        if (!text.trim()) throw new Error(`empty response (finishReason=${cand?.finishReason ?? "?"})`);
        JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text); // parseability check → a bad body also retries
      },
      onFailure: ({ reason, nextModel }) => {
        recordVisionAttemptFailure(runId, reason, circuit.probe);
        if (nextModel) log(runId, "debug", `Beat ${beatIndex}: scoring failed (${reason.slice(0, 80)}) — retrying`, { stage: "visual" });
      },
    });
    recordVisionCallSuccess(runId, circuit.probe);
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text) as { i: number; score: number }[];
    const scored = arr
      .map((x) => ({ hit: pool[Number(x.i)], score: Number(x.score) }))
      .filter((x) => x.hit && Number.isFinite(x.score))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const withThumbs = thumbs.filter(Boolean).length;
    log(runId, "debug", `Beat ${beatIndex}: scored ${pool.length} candidates (${withThumbs} with image) — best ${best ? best.score : "n/a"}/${threshold} (${best ? best.hit.provider : "—"})`, { stage: "visual" });
    return { picks: scored.length ? scored : pool.map((h) => ({ hit: h, score: 0 })), reserve };
  } catch (e) {
    // Reaches here on every beat once the key is exhausted; the notice fires only the first time.
    noteGeminiQuota(runId, (e as Error).message, "visual");
    log(runId, "warn", `Beat ${beatIndex}: scoring failed after 2 attempts (${(e as Error).message.slice(0, 80)}) — lexical fallback scoring`, { stage: "visual" });
    // fail-open, non-blocking: lexical relevance instead of arbitrary acceptance
    return { picks: pool.map((h) => ({ hit: h, score: fallbackSemanticScore(sceneQuery, h), fallback: true })), reserve };
  }
}

/** Download/render a chosen hit into outPath as a beat clip. */
async function materialize(
  runId: string,
  beat: Beat,
  hit: ProviderHit,
  beatDurSec: number,
  outPath: string,
  resolution?: string
): Promise<VisualResult> {
  // Storyblocks is the one provider whose hit.url is NOT a file: it is a signed manifest
  // that has to be exchanged for a CDN link (see resolveStoryblocksFile). That exchange is
  // also the BILLED step, and it happens here — i.e. only for the candidate the scorer
  // already picked, never once per candidate. A failed exchange drops this candidate and
  // the caller moves to the next one.
  if (hit.provider === "storyblocks") {
    const wantH = Number(/[x×](\d+)/.exec(resolution || "")?.[1] ?? 1080) || 1080;
    const real = await resolveStoryblocksFile(hit.url, wantH, runId);
    if (!real) throw new Error("storyblocks: could not resolve a downloadable file");
    // Cost Monitoring — this exchange consumes a download from the plan, and it was
    // recorded nowhere. Storyblocks wasn't even in the Costs page's provider table, so
    // it was invisible in every dimension: no euro, no usage count, no provider chip.
    // Metered only on a successful resolve, which is the step that actually bills.
    recordStoryblocksDownload(runId);
    hit = { ...hit, url: real };
  }
  if (hit.kind === "video") {
    await downloadToFile(hit.url, outPath, { "User-Agent": UA });
    // Integrity gate FIRST: a truncated download or an HTML/error body saved as
    // .mp4 can decode just enough to pass the freeze probe below (movingFrames>0)
    // yet break the compositor's `-stream_loop` read-to-EOF encode → silent black
    // filler. Reject here so acquireReal's loop falls through to the next candidate.
    const integ = probeVideoIntegrity(outPath);
    if (!integ.ok) {
      try { fs.unlinkSync(outPath); } catch {}
      log(runId, "debug", `Beat ${beat.index}: ${hit.provider} video rejected — ${integ.reason}`, { stage: "visual" });
      throw new Error(`unusable video (${integ.reason})`);
    }
    // Reject frozen AND near-static stock clips: `-stream_loop -1` in the compositor
    // plays a barely-moving clip verbatim (no Ken Burns), so it reads on screen as a
    // static photo sitting beside zooming stills. Reject anything under
    // minVideoMovingFrames() distinct frames across the 8s probe (setting
    // VIDEO_MIN_MOVING_FRAMES, default 8) so it falls through to the next candidate —
    // a moving clip or a Ken-Burned still (both have motion). A null
    // probe (ffmpeg missing) is still accepted (fail open). Throwing lets acquireReal's
    // loop fall through to the next passing candidate.
    const moving = movingFrameCount(outPath);
    const minMoving = minVideoMovingFrames();
    if (moving !== null && moving < minMoving) {
      try { fs.unlinkSync(outPath); } catch {}
      log(runId, "debug", `Beat ${beat.index}: ${hit.provider} video rejected — frozen/near-static (movingFrames=${moving} < ${minMoving})`, { stage: "visual" });
      throw new Error(`frozen/near-static video (movingFrames=${moving})`);
    }
    // Positive confirmation the freeze probe actually ran. `null` means ffmpeg/
    // mpdecimate didn't execute (binary missing/error) — the guard is silently
    // inactive (fail-open). Surface that at WARN so an inactive guard is visible.
    if (moving === null) {
      log(runId, "warn", `Beat ${beat.index}: ${hit.provider} video accepted — freeze probe unavailable (fail-open, guard inactive)`, { stage: "visual" });
    } else {
      log(runId, "debug", `Beat ${beat.index}: ${hit.provider} video accepted — freeze probe ok (movingFrames=${moving})`, { stage: "visual" });
    }
    return { path: outPath, kind: "video", provider: hit.provider ?? "real", attribution: hit };
  }
  const tmpImg = path.join(os.tmpdir(), `kb_${runId.slice(0, 8)}_${beat.index}${path.extname(new URL(hit.url).pathname) || ".jpg"}`);
  await downloadToFile(hit.url, tmpImg, { "User-Agent": UA });
  kenBurns(tmpImg, outPath, beatDurSec, beat.index % 2 === 1, resolution);
  try {
    fs.unlinkSync(tmpImg);
  } catch {}
  return { path: outPath, kind: "image", provider: hit.provider ?? "real", attribution: hit };
}

function ffmpegBinPath(): string {
  return resolveFfmpeg();
}

/** Grab a representative frame (~1s in) from a clip for vision scoring. */
function extractFrame(clipPath: string, outJpg: string, atSec = 1): boolean {
  const r = spawnSync(ffmpegBinPath(), ["-ss", String(Math.max(0, atSec)), "-i", clipPath, "-frames:v", "1", "-q:v", "3", "-y", outJpg], {
    stdio: "ignore",
    timeout: 30000,
  });
  return r.status === 0 && fs.existsSync(outJpg) && fs.statSync(outJpg).size > 0;
}

/** ffprobe alongside the configured ffmpeg (sibling binary). */
function ffprobeBinPath(): string {
  const f = ffmpegBinPath();
  return f === "ffmpeg" ? "ffprobe" : f.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
}

/**
 * Cheap integrity gate for a freshly-downloaded clip: it must be a real, non-tiny
 * file with a decodable video stream. Catches truncated downloads and HTML/error
 * bodies saved under a .mp4 name — which can decode just enough to pass the freeze
 * probe (movingFrames>0) yet later break the compositor's `-stream_loop` read-to-EOF
 * encode, producing a silent black filler. Fails OPEN (ok:true) when ffprobe itself
 * can't run, mirroring the freeze probe: never discard what we couldn't measure.
 * Only an EXPLICIT non-positive duration or a missing video stream rejects.
 */
function probeVideoIntegrity(clipPath: string): { ok: boolean; reason: string } {
  let size = -1;
  try { size = fs.statSync(clipPath).size; } catch { return { ok: false, reason: "missing file" }; }
  if (size < 2048) return { ok: false, reason: `tiny file (${size}B)` };
  const r = spawnSync(
    ffprobeBinPath(),
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type:format=duration", "-of", "default=nw=1:nk=1", clipPath],
    { encoding: "utf8", timeout: 20000 }
  );
  if (r.status !== 0) return { ok: true, reason: "probe unavailable (fail-open)" }; // couldn't measure → don't discard
  const out = (r.stdout || "").toString();
  if (!/\bvideo\b/.test(out)) return { ok: false, reason: "no video stream" };
  const durMatch = out.match(/(\d+\.?\d*)\s*$/);
  const dur = durMatch ? Number(durMatch[1]) : NaN;
  if (Number.isFinite(dur) && dur <= 0) return { ok: false, reason: "zero duration" };
  return { ok: true, reason: "ok" };
}

/**
 * WI-11 — crop out a caption STRIP (region "lower" or "upper") and zoom-to-fill back to
 * the clip's ORIGINAL WxH (aspect preserved). Removes `fraction` of frame height, scales the
 * kept band uniformly so its height fills the frame, then centre-crops width. Exact integer
 * pixels (one ffprobe) so no odd-dimension surprises. Returns false on any failure (caller
 * then keeps the un-cropped path / gives up).
 */
function cropClip(src: string, dst: string, region: "lower" | "upper", fraction: number): boolean {
  const probe = spawnSync(ffprobeBinPath(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", src], { encoding: "utf8", timeout: 15000 });
  const m = (probe.stdout || "").trim().match(/(\d+)x(\d+)/);
  if (probe.status !== 0 || !m) return false;
  const W = Number(m[1]), H = Number(m[2]);
  const F = Math.max(0.1, Math.min(0.4, fraction));
  const cropH = Math.round((H * (1 - F)) / 2) * 2; // kept band height (even)
  if (cropH < 16 || cropH >= H) return false;
  const y = region === "upper" ? H - cropH : 0; // keep bottom (text up top) vs keep top (text below)
  const scaleW = Math.round((W * (H / cropH)) / 2) * 2; // uniform zoom: band height → full H
  const x = Math.max(0, Math.round((scaleW - W) / 4) * 2); // centre horizontally (even offset)
  const vf = `crop=${W}:${cropH}:0:${y},scale=${scaleW}:${H},crop=${W}:${H}:${x}:0`;
  const r = spawnSync(ffmpegBinPath(), ["-i", src, "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-y", dst], { stdio: "ignore", timeout: 120000 });
  return r.status === 0 && fs.existsSync(dst) && fs.statSync(dst).size > 0;
}

/**
 * WI-11 — locate the dominant burned-in TEXT in ONE frame so crop-recovery knows whether a
 * caption strip can be removed. Separate lightweight vision call (does NOT touch scoreLocalImage).
 * Fail-open to "none" (→ caller skips crop). Tiny peripheral logos/timestamps are ignored.
 */
async function detectTextRegion(runId: string, framePath: string): Promise<"lower" | "upper" | "center" | "full" | "scattered" | "none"> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) return "none";
  let data: string;
  try {
    const buf = fs.readFileSync(framePath);
    if (buf.byteLength === 0 || buf.byteLength > 6 * 1024 * 1024) return "none";
    data = buf.toString("base64");
  } catch {
    return "none";
  }
  const mime = framePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  const instr =
    `Locate the dominant burned-in on-screen TEXT (subtitles, closed-captions, lower-third name banners, ` +
    `titles, headlines, kinetic typography, quote/lyric overlays, large watermarks) in ONE video frame. ` +
    `IGNORE tiny peripheral channel logos/bugs and small timestamps. Report WHERE the prominent readable text sits: ` +
    `"lower" = ONLY in the bottom ~third; "upper" = ONLY in the top ~third; "center" = across the middle / over the subject; ` +
    `"full" = covers most of the frame (text card/slide); "scattered" = prominent text in BOTH top and bottom (or several areas); ` +
    `"none" = no prominent text. Choose the SINGLE best region. Return STRICTLY JSON {"region":"lower|upper|center|full|scattered|none"}. No markdown.`;
  const circuit = beginVisionCall(runId);
  if (!circuit.allow) return "none";
  try {
    const model = getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL");
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: instr }, { inline_data: { mime_type: mime, data } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } },
    });
    // Vision-only retry: stay on the configured Vision model (Flash-Lite by default),
    // with no cross-model escalation. Fails open to "none" below.
    const { json: j, model: usedModel } = await callGemini({
      apiKey, model, body, maxAttempts: circuit.probe ? 1 : 2, allowModelFallback: false, backoffMs: () => 0, timeoutMs: 30_000,
      onFailure: ({ reason }) => recordVisionAttemptFailure(runId, reason, circuit.probe),
    });
    recordVisionCallSuccess(runId, circuit.probe);
    // Cost Monitoring — crop-recovery text-region localization is a vision call.
    recordGemini(runId, "geminiVision", j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0, usedModel);
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const reg = (JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as { region?: string }).region?.trim().toLowerCase() ?? "none";
    return (["lower", "upper", "center", "full", "scattered"] as const).find((x) => x === reg) ?? "none";
  } catch {
    return "none";
  }
}

/**
 * WI-11 — last-resort recovery for a RELEVANT clip lost only to a caption strip (after segment-
 * retry failed to find a clean full-frame window). Detects the text region; if it's a removable
 * "lower"/"upper" strip, crops it out (zoom-to-fill) and RE-SCORES the cropped clip with the same
 * footage pass. On a clean+relevant result the cropped file REPLACES `tmpClip` and its clipScore is
 * returned (caller routes it through best-of-N); otherwise returns null (no change, give up).
 */
async function tryCropRecovery(
  runId: string,
  beat: Beat,
  query: string,
  beatDurSec: number,
  tmpClip: string,
  videoContext: string | undefined,
  textFractions: number[]
): Promise<number | null> {
  const fraction = Math.max(0.1, Math.min(0.4, Number(getSetting("YT_CROP_FRACTION") || "0.22")));
  const clipBar = Math.max(0, Math.min(100, Number(getSetting("YT_CLIP_THRESHOLD") || "64")));
  const deadFrame = Math.max(0, Math.min(100, Number(getSetting("YT_DEAD_FRAME") || "25")));
  const deadPenalty = Math.max(0, Number(getSetting("YT_DEAD_PENALTY") || "8"));

  // WI-11a 1. STRICT multi-frame region consensus. Probe the frames that actually carried text
  // (fall back to spread thirds), then crop ONLY when every non-"none" region agrees on ONE strip
  // (lower XOR upper) with NO center/full/scattered present. A single misread (or text that moves)
  // → skip, instead of cropping the wrong band and zoom-amplifying the remaining text.
  const probeFracs = (textFractions.length ? textFractions : [0.3, 0.5, 0.7]).slice(0, 3);
  const regions: string[] = [];
  for (let i = 0; i < probeFracs.length; i++) {
    const probeFrame = `${tmpClip}.region${i}.jpg`;
    if (extractFrame(tmpClip, probeFrame, beatDurSec * probeFracs[i])) {
      regions.push(await detectTextRegion(runId, probeFrame));
      try { fs.unlinkSync(probeFrame); } catch {}
    }
  }
  const nonNone = regions.filter((r) => r !== "none");
  const lower = nonNone.filter((r) => r === "lower").length;
  const upper = nonNone.filter((r) => r === "upper").length;
  const blocked = nonNone.some((r) => r === "center" || r === "full" || r === "scattered");
  const region: "lower" | "upper" | null = !blocked && lower > 0 && upper === 0 ? "lower" : !blocked && upper > 0 && lower === 0 ? "upper" : null;
  if (!region) {
    log(runId, "info", `Beat ${beat.index}: crop-recovery skipped (region consensus [${regions.join(",") || "none"}] — not a single removable strip)`, { stage: "visual" });
    return null;
  }

  // 2. Crop the strip + zoom-to-fill.
  const cropped = `${tmpClip}.crop.mp4`;
  if (!cropClip(tmpClip, cropped, region, fraction)) {
    try { fs.unlinkSync(cropped); } catch {}
    log(runId, "debug", `Beat ${beat.index}: crop-recovery ffmpeg crop failed (region=${region})`, { stage: "visual" });
    return null;
  }

  // 3. Re-score the cropped clip (same WI-4 footage verdict; text must now be gone).
  const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
  const perFrame: number[] = [];
  for (let i = 0; i < fractions.length; i++) {
    const frame = `${cropped}.${i}.jpg`;
    if (extractFrame(cropped, frame, beatDurSec * fractions[i])) {
      perFrame.push(await scoreLocalImage(runId, beat.index, query, beat.text, videoContext, frame, "footage", beat.footageKind));
      try { fs.unlinkSync(frame); } catch {}
    }
  }
  const textVeto = perFrame.some((s) => s < 0);
  const scored = perFrame.filter((s) => s >= 0);
  const deadCount = scored.filter((s) => s < deadFrame).length;
  const deadVeto = scored.length > 0 && deadCount * 2 >= scored.length;
  const mean = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : 0;
  const clipScore = perFrame.length === 0 ? 100 : Math.max(0, mean - deadPenalty * deadCount);
  const acceptable = perFrame.length === 0 || (!textVeto && !deadVeto && clipScore >= clipBar);
  const frameDisplay = perFrame.map((s) => (s === -2 ? "HEAD" : s < 0 ? "TEXT" : s)).join(", ") || "none";
  log(runId, "info", `Beat ${beat.index}: crop-recovery region=${region} → re-score [${frameDisplay}] clipScore ${Math.round(clipScore)} (acceptable=${acceptable})`, { stage: "visual" });

  if (!acceptable) {
    try { fs.unlinkSync(cropped); } catch {}
    return null;
  }
  // 4. Cropped clip wins — it replaces tmpClip so the caller's best-of-N handling is unchanged.
  try { fs.renameSync(cropped, tmpClip); } catch { try { fs.copyFileSync(cropped, tmpClip); fs.unlinkSync(cropped); } catch {} }
  return clipScore;
}

/**
 * Minimum distinct (post-mpdecimate) frames over the 8s probe for a stock VIDEO clip
 * to count as "moving". Below this the clip reads on screen as a static photo (real
 * footage is used verbatim — no Ken Burns), so it's rejected and the beat falls through
 * to a moving clip or a Ken-Burned still.
 *
 * Why 8: mpdecimate keeps only frames that differ enough from their predecessor. In an
 * ffmpeg smoke test a frozen/near-static clip yielded ~1–4 distinct frames over the 8s
 * window, while a genuinely moving clip yielded tens-to-hundreds. 8 (≈ under 1 distinct
 * frame/sec) sits in that gap — safely above the static band, well below real motion —
 * so it drops photo-like clips without rejecting legitimately slow pans. It's a coarse
 * heuristic, hence tunable rather than hard-coded.
 *
 * Tune via the VIDEO_MIN_MOVING_FRAMES setting (no redeploy): raise it to be stricter,
 * lower it (0) to accept any clip. A null probe (ffmpeg unavailable) still fails open.
 */
function minVideoMovingFrames(): number {
  // Unset/blank → the default 8 (getSetting resolves DB→env→"" and does NOT fall back to
  // DEFAULTS, and Number("")===0 would silently DISABLE the guard). Only an explicit
  // numeric value overrides; "0" is the intentional "accept any clip" opt-out.
  const raw = getSetting("VIDEO_MIN_MOVING_FRAMES").trim();
  if (raw === "") return 8;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 8;
}

/**
 * Count the MOVING frames in a clip: decode through mpdecimate (which drops
 * near-duplicate frames) and read how many survive. A truncated/single-frame OR a
 * genuinely frozen clip collapses to ~1; a real moving clip keeps many. This
 * catches BOTH freeze causes (degenerate file AND static-but-valid stock) — which
 * a plain duration/nb_frames probe cannot. Analysis is capped to the first 8s to
 * bound cost. Returns the surviving-frame count, or null if the probe itself
 * couldn't run / produced no stats (caller then FAILS OPEN — never reject what we
 * couldn't measure, so valid footage is not discarded when ffmpeg is unavailable).
 */
function movingFrameCount(clipPath: string): number | null {
  const r = spawnSync(
    ffmpegBinPath(),
    ["-t", "8", "-i", clipPath, "-vf", "mpdecimate", "-an", "-f", "null", "-"],
    { stdio: "pipe", encoding: "utf8", timeout: 60000 }
  );
  const matches = [...((r.stderr ?? "") as string).matchAll(/frame=\s*(\d+)/g)];
  if (matches.length === 0) return null; // no stats parsed → can't judge → fail open
  return Number(matches[matches.length - 1][1]);
}

/**
 * WI-9 — next non-overlapping window start (seconds) for a segment-retry across the
 * SAME video, or null when no fresh window remains. Spreads probes over the duration
 * and skips any start within `need` of an already-tried window. Videos too short to
 * host a distinct window (< 2× need) return null (nothing to gain from a retry).
 */
function nextSegmentStart(dur: number, need: number, tried: number[]): number | null {
  if (!dur || dur < need * 2) return null;
  const fracs = [0.5, 0.2, 0.7, 0.35, 0.85, 0.1];
  for (const f of fracs) {
    const s = Math.max(0, Math.min(Math.floor(dur * f), dur - need - 1));
    if (tried.every((t) => Math.abs(t - s) > need)) return s;
  }
  return null;
}

/**
 * #2 — title-rerank BEFORE download. One cheap Gemini text call (titles/channels/durations only,
 * NO images, NO downloads) scores each candidate on TWO explicit axes:
 *   relevance   = how well the video's likely CONTENT matches the wanted visual subject;
 *   cleanliness = probability it is CLEAN depictive B-roll (raw/ambient/stock/establishing footage),
 *                 NOT a vlog / "I tried" / eating-challenge / reaction / review / tutorial / news /
 *                 listicle — those are semantically relevant but structurally caption/talking-head heavy.
 * Combined = relevance·cleanliness/100 (multiplicative → BOTH must be high; a relevant-but-vlog clip
 * scores low). Returns the candidates reordered by combined-desc plus the best combined score (for the
 * caller's early-bail). FAIL-OPEN: no key / error / bad parse → null (caller keeps original order, no bail).
 */
async function rerankByTitle(
  runId: string,
  beat: Beat,
  sceneQuery: string,
  videoContext: string | undefined,
  candidates: YtCandidate[],
): Promise<{ ordered: YtCandidate[]; topScore: number } | null> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey || candidates.length === 0) return null;
  const circuit = beginVisionCall(runId);
  if (!circuit.allow) return null;
  const list = candidates
    .map((c, i) => `[${i}] channel="${(c.channel ?? "?").slice(0, 40)}" | title="${(c.title ?? "?").slice(0, 90)}" | ${c.duration ?? "?"}s`)
    .join("\n");
  const instr =
    `You are ranking YouTube search results to pick CLEAN B-ROLL for ONE documentary scene. Judge ONLY from each candidate's channel + title + duration.\n` +
    `OVERALL VIDEO TOPIC: "${(videoContext || beat.text).slice(0, 300)}"\n` +
    `THIS SCENE (narration): "${beat.text.slice(0, 200)}"\nWANTED VISUAL: "${sceneQuery}"\n\n` +
    `For EACH candidate score TWO axes 0-100:\n` +
    `- "relevance": how well the video's likely CONTENT matches the wanted visual subject/scene.\n` +
    `- "cleanliness": probability it is CLEAN depictive B-roll — raw/ambient/stock/establishing/walking-tour/railfan footage OF the subject with NO burned-in captions/subtitles, NO on-screen presenter or talking head, NO reaction/commentary, NO listicle/ranking graphics, NO news chyrons. ` +
    `Score LOW (a relevant subject does NOT save it) for vlog / "I tried" / "eating" / "X for 24 hours" / review / reaction / tutorial / how-to / news / podcast / commentary formats — these carry on-screen text and talking heads. Score HIGH for pure-footage / ambient / establishing-shot channels.\n` +
    `Candidates:\n${list}\n\n` +
    `Return STRICTLY JSON [{"i":<int>,"relevance":<int>,"cleanliness":<int>}]. No markdown.`;
  const model = getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL");
  // Phase 1A — transient-failure resilience for the rerank early-bail. The bail is the
  // cheapest way to skip a hopeless YouTube pool BEFORE any download, but a single Gemini
  // 503 used to disable it (→ the full download grind, e.g. the ~11-min beat-5 case). The
  // shared resilience layer retries transient failures only (5xx / 429 / 20s timeout /
  // network), but Vision is pinned to the configured model and capped at two total attempts.
  // Permanent errors (4xx) and bad JSON fail open immediately (return null → caller keeps the
  // original order). YT_RERANK_RETRIES=0 reproduces today's single-shot exactly.
  const retries = Math.max(0, Math.min(5, Number(getSetting("YT_RERANK_RETRIES") || "2")));
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: instr }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
  });
  let arr: { i: number; relevance: number; cleanliness: number }[] | null = null;
  try {
    const { json: j, model: usedModel } = await callGemini({
      apiKey,
      model,
      body,
      maxAttempts: circuit.probe ? 1 : Math.min(2, retries + 1),
      allowModelFallback: false,
      timeoutMs: 20_000,
      // Non-blocking jittered backoff (jitter de-syncs concurrent beats): ~1s, then ~2.5s.
      backoffMs: (n) => (n === 1 ? 1000 : 2500) + Math.floor(Math.random() * 300),
      onFailure: ({ reason, nextModel }) => {
        recordVisionAttemptFailure(runId, reason, circuit.probe);
        if (nextModel) log(runId, "debug", `Beat ${beat.index}: title-rerank ${reason.slice(0, 40)} — retry with ${nextModel}`, { stage: "visual" });
      },
    });
    recordVisionCallSuccess(runId, circuit.probe);
    // Cost Monitoring — billed only on a successful call. The category picks the RATE, not
    // the modality: this call runs on VISION_MATCH_MODEL (gemini-3.1-flash-lite by default,
    // $0.25/$1.50 per 1M), so it must bill at the lite rate even though its payload is text.
    // "geminiText" would charge the gemini-3.5-flash rate ($1.50/$9.00) — 6× too much.
    recordGemini(runId, "geminiVision", j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0, usedModel);
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text) as { i: number; relevance: number; cleanliness: number }[];
  } catch (e) {
    log(runId, "debug", `Beat ${beat.index}: title-rerank failed (${(e as Error).message.slice(0, 80)}) — keeping original order`, { stage: "visual" });
    return null; // fail-open — caller keeps the original order and skips the bail (today's behavior)
  }
  if (!arr) return null; // budget exhausted without a parsed result → fail-open

  // Combined = relevance·cleanliness/100. Candidates the model didn't score keep combined 0 (sink to tail).
  const scoreById = new Map<number, number>();
  for (const x of arr) {
    const idx = Number(x.i);
    const rel = Math.max(0, Math.min(100, Number(x.relevance)));
    const clean = Math.max(0, Math.min(100, Number(x.cleanliness)));
    if (Number.isFinite(idx) && Number.isFinite(rel) && Number.isFinite(clean)) scoreById.set(idx, (rel * clean) / 100);
  }
  if (scoreById.size === 0) return null; // nothing parsed → fail-open
  const ordered = candidates
    .map((c, i) => ({ c, i, s: scoreById.get(i) ?? 0 }))
    .sort((a, b) => b.s - a.s);
  const topScore = ordered.length ? ordered[0].s : 0;
  log(runId, "debug", `Beat ${beat.index}: title-rerank top=${Math.round(topScore)} order=[${ordered.slice(0, 5).map((o) => `${o.i}:${Math.round(o.s)}`).join(" ")}${ordered.length > 5 ? " …" : ""}]`, { stage: "visual" });
  return { ordered: ordered.map((o) => o.c), topScore };
}

/**
 * Opt-in YouTube clip fallback (yt-dlp). Downloads a beat-length segment, scores
 * one of its frames with the same vision pass (relevance to the scene + overall
 * topic, and rejecting on-screen text per the fair-use "no text" rule), and uses
 * it only if it clears the threshold. The user is responsible for the legality
 * of anything published (copyright / monetization can't be detected here).
 * Returns null when disabled, yt-dlp is missing, or nothing clean matched.
 */
async function youtubeScoredFallback(
  runId: string,
  beat: Beat,
  query: string,
  beatDurSec: number,
  outPath: string,
  usedIds: Set<string>,
  videoContext: string | undefined
): Promise<VisualResult | null> {
  if (getSetting("YT_DLP_ENABLED") !== "1" || !configuredProviders().includes("youtube")) return null;
  // WI-4 — clip acceptance by CONSISTENCY (mean minus a per-dead-frame penalty), not by peaks,
  // and best-of-N across candidates instead of greedily taking the first passer. Fixes C1 (even
  // clips wrongly rejected / spiky clips wrongly accepted) and C4 (first-wins). YT_MATCH_THRESHOLD
  // (per-frame) is deprecated; YT_CLIP_THRESHOLD is the new clip-level bar. Kept: T1/T2 text-veto
  // (-1 sentinel) and fail-open when no frame extracts.
  const clipBar = Math.max(0, Math.min(100, Number(getSetting("YT_CLIP_THRESHOLD") || "64")));
  const deadFrame = Math.max(0, Math.min(100, Number(getSetting("YT_DEAD_FRAME") || "25")));
  const deadPenalty = Math.max(0, Number(getSetting("YT_DEAD_PENALTY") || "8"));
  const excellentBar = Math.max(0, Math.min(100, Number(getSetting("YT_EXCELLENT") || "85")));
  const tmpClip = path.join(os.tmpdir(), `yt_${runId.slice(0, 8)}_${beat.index}.mp4`);
  const heldBest = `${tmpClip}.best.mp4`; // best-of-N: held on disk while later candidates score
  const maxCandidates = Math.max(1, Math.min(12, Number(getSetting("YT_CANDIDATES") || "6"))); // WI-10: ceiling 12 (was 5) for the deep sweep
  const ytDebug = getSetting("YT_DEBUG") === "1";

  const finalize = (attribution: VisualResult["attribution"], clipScore: number, attempt: number): VisualResult => {
    try { fs.renameSync(heldBest, outPath); } catch { fs.copyFileSync(heldBest, outPath); try { fs.unlinkSync(heldBest); } catch {} }
    log(runId, "info", `Beat ${beat.index}: real video via YouTube — clipScore ${Math.round(clipScore)} (best-of-N, candidate ${attempt}/${maxCandidates})`, { stage: "visual" });
    return { path: outPath, kind: "video", provider: "youtube", attribution };
  };

  // #1 — separate YouTube retrieval query. When YT_SEPARATE_QUERY=1 and the planner supplied a
  // short title-optimized youtube_query, SEARCH + DOWNLOAD (chapter-match) use it, with NO suffix
  // augmentation. The descriptive `query` is still used for per-frame vision SCORING (relevance is
  // verified strictly). Missing youtube_query / flag off → ytQuery=query (today's behavior).
  const useSeparate = getSetting("YT_SEPARATE_QUERY") === "1" && !!beat.youtubeQuery;
  const ytQuery = useSeparate ? (beat.youtubeQuery as string) : query;
  if (useSeparate) log(runId, "debug", `Beat ${beat.index}: YouTube separate query "${ytQuery}" (scoring stays on "${query}")`, { stage: "visual" });

  // WI-8 — search + rank ONCE per beat; the best-of-N loop downloads candidates from this
  // ranking instead of re-running ytsearch each attempt (closes F1). usedIds-dedup still
  // yields a unique set, but now from ONE stable ranking (no per-search reshuffle).
  const ranked = await searchYouTube(runId, ytQuery, beatDurSec, usedIds, beat.footageKind === "archival", beat.queryType, useSeparate);
  if (ranked.length === 0) {
    log(runId, "debug", `Beat ${beat.index}: YouTube search returned no usable candidates — falling back to stock/AI`, { stage: "visual" });
    return null;
  }

  // #2 — title-rerank BEFORE download (YT_TITLE_RERANK). Reorder the pool toward clean depictive
  // footage (relevance × cleanliness) and EARLY-BAIL to stock/AI when even the best candidate's
  // combined title score is below YT_RERANK_FLOOR — i.e. a uniformly vlog/listicle/news pool that
  // would only waste downloads. Fail-open: rerank returns null → keep the original order, no bail.
  let pool = ranked;
  if (getSetting("YT_TITLE_RERANK") === "1") {
    const rr = await rerankByTitle(runId, beat, query, videoContext, ranked);
    if (rr) {
      pool = rr.ordered;
      const floor = Math.max(0, Math.min(100, Number(getSetting("YT_RERANK_FLOOR") || "45")));
      if (rr.topScore < floor) {
        log(runId, "info", `Beat ${beat.index}: title-rerank best ${Math.round(rr.topScore)} < floor ${floor} — pool is caption/vlog-heavy, skipping YouTube downloads → stock/AI`, { stage: "visual" });
        return null;
      }
    }
  }

  // best-of-N accumulator — highest-clipScore acceptable candidate held on disk so far.
  let best: { clipScore: number; attribution: VisualResult["attribution"]; attempt: number } | null = null;

  // WI-9 — on a text-veto of a RELEVANT clip, retry up to this many OTHER windows of the
  // SAME video to find a text-free segment (0 = off). Per-video budget, separate from
  // maxCandidates (which counts distinct videos).
  const segRetries = Math.max(0, Math.min(5, Number(getSetting("YT_SEGMENT_RETRIES") || "1")));
  const cropRecovery = getSetting("YT_CROP_RECOVERY") === "1"; // WI-11
  const need = Math.ceil(beatDurSec) + 1;

  // Walk the ranking; SCORE up to maxCandidates downloaded clips. A candidate that fails
  // to download just advances to the next ranked one (no scoring slot consumed).
  let scoredCount = 0;
  // Phase 1B — YouTube circuit breaker. Bail to stock/AI after YT_TEXT_VETO_LIMIT CONSECUTIVE
  // candidates whose TERMINAL outcome is a text veto (caption-saturated pool, e.g. the beat-5
  // case). Counts a text veto only after segment-retry AND crop-recovery have failed to rescue
  // the clip, and resets on any accept / below-bar / dead — so a relevant pool with a good late
  // hit (beat 1) is never cut short. 0 = off (today's behavior); clamped to the candidate budget.
  const textVetoLimit = Math.max(0, Math.min(maxCandidates, Number(getSetting("YT_TEXT_VETO_LIMIT") || "3")));
  let consecutiveTextVetoes = 0;
  for (const candidate of pool) {
    if (scoredCount >= maxCandidates) break;
    // WI-12 — dedup race: the ranked list is frozen at search time (WI-8), so a concurrently
    // running beat may have claimed this id AFTER our search. Re-check + claim NOW, synchronously
    // (no await between has() and add() → atomic) so two beats can't pick the same video/segment.
    const ytKey = `youtube:${candidate.id}`;
    if (usedIds.has(ytKey)) continue; // taken by another beat since our search → skip
    usedIds.add(ytKey);
    let res: VisualResult | null = null;
    try {
      res = await downloadYouTube(runId, candidate, ytQuery, beatDurSec, tmpClip, usedIds);
    } catch (e) {
      log(runId, "debug", `Beat ${beat.index}: youtube fetch failed (${(e as Error).message.slice(0, 100)})`, { stage: "visual" });
      break; // systemic yt-dlp failure → stop; use the best held so far (if any)
    }
    if (!res) continue; // this candidate failed to download → next ranked candidate
    scoredCount++;
    const attempt = scoredCount;
    const candAttribution = res.attribution; // stable for this video across all its windows (WI-11a)
    // WI-11a — best (highest non-text mean) RELEVANT-but-texty window held for crop-recovery, so a
    // later worse segment-retry window can't shadow the ideal crop target. Cropped AFTER the window
    // loop, on this held copy — never the last window.
    let cropCand: { path: string; mean: number; textFractions: number[] } | null = null;
    // Phase 1B — did THIS candidate terminate on a text veto? Set at the window loop's terminal
    // points; cleared if crop-recovery rescues clean footage. Drives the circuit breaker below.
    let candidateTextVeto = false;

    // WI-9 — inner loop over WINDOWS of this same video (window 0 = the default offset;
    // windows 1..segRetries = text-free-segment retries). The acceptance math (WI-4) is
    // identical per window; only the download offset changes.
    const triedStarts: number[] = [];
    let win = 0;
    while (true) {
      if (res.ytDebug?.segStart != null) triedStarts.push(res.ytDebug.segStart);
      const winLabel = win === 0 ? `${attempt}/${maxCandidates}` : `${attempt}/${maxCandidates} w${win}`;

      // DIAGNOSTICS (YT_DEBUG=1) — instrumentation only; frames COPIED to a per-candidate folder.
      let debugDir = "";
      if (ytDebug) {
        debugDir = path.join(DATA_DIR, "debug_frames", `run_${runId.slice(0, 8)}`, `beat_${beat.index}`, win === 0 ? `cand_${attempt}` : `cand_${attempt}_w${win}`);
        try { fs.mkdirSync(debugDir, { recursive: true }); } catch {}
      }

      // Sample 5 frames (10/30/50/70/90%). scoreLocalImage returns -1 for a frame with PROMINENT
      // burned-in text (T1/T2) — such a frame both vetoes the clip and is excluded from the math.
      const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
      const perFrame: number[] = [];
      const frameTimes: number[] = [];
      for (let i = 0; i < fractions.length; i++) {
        const atSec = beatDurSec * fractions[i];
        frameTimes.push(Number(atSec.toFixed(2)));
        const frame = `${tmpClip}.${i}.jpg`;
        if (extractFrame(tmpClip, frame, atSec)) {
          const s = await scoreLocalImage(runId, beat.index, query, beat.text, videoContext, frame, "footage", beat.footageKind);
          perFrame.push(s);
          if (ytDebug) { try { fs.copyFileSync(frame, path.join(debugDir, `frame_${i + 1}.jpg`)); } catch {} }
          try { fs.unlinkSync(frame); } catch {}
        }
      }

      // WI-4 verdict: clipScore = mean(non-text frames) − penalty·deadCount. Veto on prominent
      // text OR half-the-frames-dead (black/wrong/absent < deadFrame). Fail-open when no frame.
      const textVeto = perFrame.some((s) => s < 0);
      const scored = perFrame.filter((s) => s >= 0);
      const deadCount = scored.filter((s) => s < deadFrame).length;
      const deadVeto = scored.length > 0 && deadCount * 2 >= scored.length;
      const mean = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : 0;
      const clipScore = perFrame.length === 0 ? 100 : Math.max(0, mean - deadPenalty * deadCount);
      const acceptable = perFrame.length === 0 || (!textVeto && !deadVeto && clipScore >= clipBar);
      const reason = textVeto ? "text" : deadVeto ? "dead" : !acceptable ? "below-bar" : "ok";
      const frameDisplay = perFrame.map((s) => (s === -2 ? "HEAD" : s < 0 ? "TEXT" : s)).join(", ") || "none";

      log(runId, "debug", `Beat ${beat.index}: YouTube candidate ${winLabel} frames [${frameDisplay}] → clipScore ${Math.round(clipScore)} (dead ${deadCount}/${scored.length}; acceptable=${acceptable}; reason=${reason})`, { stage: "visual" });
      if (ytDebug) {
        const d = res.ytDebug;
        log(
          runId,
          "debug",
          `YT_DEBUG beat=${beat.index} cand=${winLabel} | text="${(beat.text || "").slice(0, 80)}" | query="${query}" | ` +
            `videoTitle="${(d?.title ?? "?").slice(0, 80)}" | videoId=${d?.id ?? "?"} | ` +
            `videoDurationSec=${d?.durationSec ?? "?"} | segment=${d?.segStart ?? "?"}-${d?.segEnd ?? "?"}s | ` +
            `beatDurSec=${beatDurSec.toFixed(2)} | frameTimestamps=[${frameTimes.join(", ")}] | ` +
            `frameScores=[${frameDisplay}] | clipScore=${Math.round(clipScore)} | dead=${deadCount}/${scored.length} | ` +
            `textVeto=${textVeto} | clipBar=${clipBar} | reason=${reason} | ` +
            `result=${acceptable ? "ACCEPTABLE" : "REJECTED"} | frames=${debugDir}`,
          { stage: "visual" },
        );
      }

      if (acceptable) {
        // WI-11a — a clean full-frame window won; drop any held crop candidate (full frame > zoom).
        if (cropCand) { try { fs.unlinkSync(cropCand.path); } catch {} cropCand = null; }
        // Early-exit: an excellent clip wins now — no need to download/score the rest.
        if (clipScore >= excellentBar) {
          try { fs.renameSync(tmpClip, heldBest); } catch { fs.copyFileSync(tmpClip, heldBest); try { fs.unlinkSync(tmpClip); } catch {} }
          return finalize(res.attribution, clipScore, attempt);
        }
        // best-of-N: keep this clip iff it beats the held best (rename overwrites the prior held).
        if (!best || clipScore > best.clipScore) {
          try { fs.renameSync(tmpClip, heldBest); } catch { fs.copyFileSync(tmpClip, heldBest); try { fs.unlinkSync(tmpClip); } catch {} }
          best = { clipScore, attribution: res.attribution, attempt };
          log(runId, "debug", `Beat ${beat.index}: best-of-N — candidate ${winLabel} held (clipScore ${Math.round(clipScore)})`, { stage: "visual" });
        } else {
          try { fs.unlinkSync(tmpClip); } catch {}
        }
        break; // done with this video
      }

      // WI-9 — text-veto on a RELEVANT clip (non-text frames clear the bar): the video is
      // on-topic, just this window has captions → try ANOTHER window of the SAME video.
      const relevant = !deadVeto && scored.length >= 2 && mean >= clipBar;

      // WI-11a — hold the BEST relevant-texty window as the crop target (copy it before a retry
      // overwrites tmpClip). textFractions = which sampled frames carried text (probe hints for the
      // strict region consensus). Crop itself runs AFTER this window loop, on this held copy.
      if (reason === "text" && relevant && cropRecovery && (!cropCand || mean > cropCand.mean)) {
        const cp = `${tmpClip}.cropcand.mp4`;
        try {
          fs.copyFileSync(tmpClip, cp);
          if (cropCand && cropCand.path !== cp) { try { fs.unlinkSync(cropCand.path); } catch {} }
          cropCand = { path: cp, mean, textFractions: fractions.filter((_, i) => perFrame[i] < 0) };
        } catch {}
      }

      if (reason === "text" && relevant && win < segRetries && res.ytDebug?.durationSec) {
        const nextStart = nextSegmentStart(res.ytDebug.durationSec, need, triedStarts);
        if (nextStart != null) {
          win++;
          log(runId, "info", `Beat ${beat.index}: YouTube candidate ${attempt}/${maxCandidates} text-veto on relevant clip — segment-retry window ${win}/${segRetries} @ ${nextStart}s`, { stage: "visual" });
          try { fs.unlinkSync(tmpClip); } catch {}
          try {
            res = await downloadYouTube(runId, candidate, ytQuery, beatDurSec, tmpClip, usedIds, nextStart);
          } catch (e) {
            log(runId, "debug", `Beat ${beat.index}: youtube segment-retry fetch failed (${(e as Error).message.slice(0, 100)})`, { stage: "visual" });
            res = null;
          }
          if (!res) { candidateTextVeto = true; break; } // retry download failed on a text-vetoed clip → give up (crop still runs on cropCand)
          continue; // re-score the new window
        }
      }

      // Give up this video's WINDOWS (not acceptable, no clean retry). Crop-recovery (if any held
      // candidate) runs after this loop.
      log(runId, "info", `Beat ${beat.index}: YouTube candidate ${winLabel} rejected (${reason})`, { stage: "visual" });
      candidateTextVeto = reason === "text"; // Phase 1B — only a text veto counts toward the breaker (dead/below-bar reset it)
      try { fs.unlinkSync(tmpClip); } catch {}
      break;
    }

    // WI-11 / WI-11a — crop-recovery LAST resort: the candidate is relevant but every window lost
    // to a caption strip → crop the BEST held window (strict multi-frame region consensus inside),
    // re-score, keep if clean. Full-frame windows are always preferred (tried first); this only zooms
    // when nothing else worked. The re-score gate rejects any crop that didn't actually clean up.
    if (cropCand && cropRecovery) {
      const cropScore = await tryCropRecovery(runId, beat, query, beatDurSec, cropCand.path, videoContext, cropCand.textFractions);
      if (cropScore != null) {
        candidateTextVeto = false; // Phase 1B — crop-recovery yielded a clean clip → not a terminal text veto
        // tryCropRecovery left the cropped clip at cropCand.path → route through best-of-N.
        if (cropScore >= excellentBar) {
          try { fs.renameSync(cropCand.path, heldBest); } catch { fs.copyFileSync(cropCand.path, heldBest); try { fs.unlinkSync(cropCand.path); } catch {} }
          return finalize(candAttribution, cropScore, attempt);
        }
        if (!best || cropScore > best.clipScore) {
          try { fs.renameSync(cropCand.path, heldBest); } catch { fs.copyFileSync(cropCand.path, heldBest); try { fs.unlinkSync(cropCand.path); } catch {} }
          best = { clipScore: cropScore, attribution: candAttribution, attempt };
          log(runId, "debug", `Beat ${beat.index}: best-of-N — candidate ${attempt} held via crop-recovery (clipScore ${Math.round(cropScore)})`, { stage: "visual" });
        } else {
          try { fs.unlinkSync(cropCand.path); } catch {}
        }
      } else {
        try { fs.unlinkSync(cropCand.path); } catch {} // crop failed/rejected → drop the held copy
      }
    }

    // Phase 1B — circuit breaker: tally CONSECUTIVE terminal text vetoes; any non-text outcome
    // (accept / below-bar / dead) resets the run. When a caption-saturated pool reaches the limit
    // we stop downloading and fall through to the held best (if any) or stock/AI below.
    if (textVetoLimit > 0) {
      consecutiveTextVetoes = candidateTextVeto ? consecutiveTextVetoes + 1 : 0;
      if (candidateTextVeto && consecutiveTextVetoes >= textVetoLimit) {
        log(runId, "info", `Beat ${beat.index}: YouTube circuit breaker triggered: ${consecutiveTextVetoes} consecutive text vetoes — bailing to fallback`, { stage: "visual" });
        break;
      }
    }
  }

  if (best) return finalize(best.attribution, best.clipScore, best.attempt);
  try { fs.unlinkSync(heldBest); } catch {}
  log(runId, "debug", `Beat ${beat.index}: YouTube exhausted up to ${maxCandidates} candidate(s) — falling back to stock/AI`, { stage: "visual" });
  return null;
}

/**
 * Real footage, best-of-all-sources. For up to 3 attempts (exact query, then two
 * broader searches) it gathers candidates from EVERY enabled source into one
 * pool and asks Gemini-vision to pick the single best match for the scene AND
 * the overall video context. The winner is used only if it clears
 * REAL_MATCH_THRESHOLD; otherwise the next attempt runs, a YouTube clip is tried,
 * then the caller falls back to AI. (Source order/"priority" no longer matters.)
 */
async function acquireReal(
  runId: string,
  beat: Beat,
  beatDurSec: number,
  outPath: string,
  usedIds: Set<string>,
  resolution?: string,
  videoContext?: string,
  youtubeFirst = false,
  topicPool?: TopicPool,
  strict = false
): Promise<VisualResult | null> {
  const rawText = beat.visualQuery || beat.text;
  const query = visualPromptToQuery(rawText);
  if (!query) return null;

  // Topic Pool Retrieval (P1) — when enabled and this beat carries a planner topicKey, the
  // provider fan-out is fetched ONCE per topic (per broaden attempt) and shared across every beat
  // in the topic; per-beat vision scoring and usedIds allocation are unchanged. `baseQuery` pins
  // the canonical pre-broaden query for the topic (first beat wins) so all members broaden the same
  // string and hit the same cache entry. When off / no topicKey, everything below is byte-identical
  // to the per-beat path.
  const topicActive = topicPool != null && !!beat.topicKey && getSetting("TOPIC_POOL") === "1";
  const topicKey = beat.topicKey;
  let baseQuery = query;
  if (topicActive && topicKey) {
    if (!topicPool!.base.has(topicKey)) topicPool!.base.set(topicKey, query);
    baseQuery = topicPool!.base.get(topicKey)!;
  }
  // Surface when a "what is absent" clause was dropped — these phrasings pull the
  // antonym subject from stock and used to silently route the beat to AI.
  const denegated = stripNegationClauses(rawText);
  if (denegated !== rawText) {
    log(runId, "debug", `Beat ${beat.index}: dropped negation clause for stock search ("${rawText}" → "${denegated}")`, { stage: "visual" });
  }
  const threshold = Math.max(0, Math.min(100, Number(getSetting("REAL_MATCH_THRESHOLD") || "85")));
  // Real Footage Media (REAL_MEDIA): "auto" (default) keeps BOTH photos+videos — byte-identical
  // to today. "image" = photos only (skips every YouTube/video path + drops video hits from the
  // pool), "video" = videos only. Values mirror ProviderHit.kind so the pool filter is a direct
  // equality check. Surfaced on the Run page; a filtered-empty pool falls through to AI as usual.
  const realMedia = (getSetting("REAL_MEDIA") || "auto").toLowerCase();
  // Diagnostics only — track the best candidate seen + the last query tried so the
  // exhaustion log can explain WHY the beat fell to AI. No effect on control flow.
  let bestSeen: { score: number; provider: string } | null = null;
  let lastSearchQuery = query;
  // Real-footage-only (strict): unlike bestSeen, this RETAINS the hit itself so the
  // best sub-bar candidate can be materialized instead of falling to AI. The normal
  // path discards it — a 74%-scoring real video loses to a generated image today.
  let bestHit: { hit: ProviderHit; score: number } | null = null;

  // YouTube-first (entity beats, YT_ROUTING=1): try real MOVING footage before
  // stock — YouTube's specificity beats stock for named places/people/events.
  // A miss falls through to the stock loop (no beat lost); reused as-is.
  if (youtubeFirst && realMedia !== "image") {
    log(runId, "debug", `Beat ${beat.index}: entity → YouTube-first`, { stage: "visual" });
    const ytFirst = await youtubeScoredFallback(runId, beat, query, beatDurSec, outPath, usedIds, videoContext);
    if (ytFirst) return ytFirst;
  }

  // Patch 2.2 — retry-degeneracy guards. broadenQuery() is a no-op for short/
  // entity-only queries (e.g. "AI chips"), so retries re-fetch the SAME deterministic
  // provider pool and re-run the heavy vision scorer to the same failing verdict.
  // triedQueries skips an identical broadened query before any fetch; scoredPools
  // skips scoreAndPick when a later (different) query yields a provably-identical pool.
  const triedQueries = new Set<string>();
  const scoredPools = new Set<string>();
  // Candidates the pre-Gemini cut set aside, gathered across every attempt and keyed by
  // dedupeId so the same asset offered on two attempts is held once.
  const reservePool = new Map<string, ProviderHit>();
  // False once ANY attempt produced a pool that wasn't weak — see weakPoolVerdict.
  let weakSoFar = true;

  // Strict adds a 4th, maximally-broad attempt (broadenQuery level 3 = one token).
  const maxAttempts = strict ? 4 : 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const searchQuery = broadenQuery(baseQuery, attempt);
    lastSearchQuery = searchQuery;
    // Skip a retry whose broadened query is byte-identical to one already tried —
    // it would re-fetch + re-score the same pool. continue (not break): a later
    // attempt may broaden to a genuinely different query.
    if (triedQueries.has(searchQuery)) {
      log(runId, "debug", `Beat ${beat.index}: retry ${attempt}/2 skipped — broadened query identical to a prior attempt ("${searchQuery}")`, { stage: "visual" });
      continue;
    }
    triedQueries.add(searchQuery);
    if (attempt > 0) {
      log(runId, "info", `Beat ${beat.index}: best real match below ${threshold}% — retry ${attempt}/2 (broader: "${searchQuery}")`, { stage: "visual" });
    }
    // Topic Pool: reuse the topic's shared gather (memoized in-flight per attempt), then apply the
    // used-clip filter at consumption. Otherwise the per-beat gather (usedIds filtered inside) — today's path.
    let pool: ProviderHit[];
    if (topicActive && topicKey) {
      const ck = `${topicKey}|${attempt}`;
      let p = topicPool!.pools.get(ck);
      if (!p) {
        p = gatherCandidates(runId, searchQuery, beatDurSec, NO_USED_FILTER);
        topicPool!.pools.set(ck, p);
        log(runId, "debug", `Beat ${beat.index}: topic pool MISS "${topicKey}" attempt ${attempt} — gathering "${searchQuery}"`, { stage: "visual" });
      } else {
        log(runId, "debug", `Beat ${beat.index}: topic pool HIT "${topicKey}" attempt ${attempt} — reusing shared gather`, { stage: "visual" });
      }
      pool = (await p).filter((h) => !usedIds.has(h.dedupeId));
    } else {
      pool = await gatherCandidates(runId, searchQuery, beatDurSec, usedIds);
    }
    // Real Footage Media filter — keep only the requested kind. "auto" (default) is a no-op, so
    // the pool is untouched (identical to today). Applied at consumption, so the shared topic-pool
    // cache stays full (all kinds) for other beats. An empty pool just continues to the next attempt.
    if (realMedia === "image" || realMedia === "video") {
      pool = pool.filter((h) => h.kind === realMedia);
    }
    if (pool.length === 0) continue;

    // Stock-impossibility (condition 3): a weak pool (no video, only low-tier image
    // providers) for a non-entity query. A single weak pool is no longer a verdict — see
    // weakPoolVerdict for why "stock does not have this" must not be decided on the
    // planner's first, most abstract query.
    const verdict = weakPoolVerdict({ attempt, weakSoFar, strict, entityProtected: entityProtected(beat, query), pool });
    if (verdict === "broaden") {
      // Hold the pool for the reserve tier rather than dropping it: these candidates are
      // already fetched, and if every broadened attempt also fails they are the last real
      // footage available before AI. Costs one extra provider fan-out and NO Gemini call.
      for (const h of pool) if (!usedIds.has(h.dedupeId)) reservePool.set(h.dedupeId, h);
      log(runId, "debug", `Beat ${beat.index}: weak pool on the planner's query — broadening before giving up (${explainWeakPool(pool)})`, { stage: "visual" });
      continue;
    }
    if (verdict === "route-ai") {
      log(runId, "debug", `Beat ${beat.index}: routing to AI (poolIsWeak: ${explainWeakPool(pool)})`, { stage: "visual" });
      return null;
    }
    weakSoFar = false;

    // Smart Gemini bypass: a clearly dominant strong candidate (Pexels video) is
    // accepted directly, skipping the heavy vision call (cuts Gemini load / 503s).
    const dominant = shouldBypassGemini(pool);
    if (dominant && !usedIds.has(dominant.dedupeId)) {
      usedIds.add(dominant.dedupeId);
      try {
        const res = await materialize(runId, beat, dominant, beatDurSec, outPath, resolution);
        log(runId, "debug", `Beat ${beat.index}: Gemini bypass — dominant candidate accepted`, { stage: "visual" });
        log(runId, "info", `Beat ${beat.index}: real ${res.kind} via ${dominant.provider} — bypass (${searchQuery})`, { stage: "visual" });
        return res;
      } catch (e) {
        // Download failed — fall through to normal scoring (the loop below skips
        // this dedupeId since it's already marked used).
        log(runId, "debug", `Beat ${beat.index}: bypass candidate failed to download (${(e as Error).message.slice(0, 80)}) — scoring the rest`, { stage: "visual" });
      }
    }

    // Skip the heavy vision call when this pool's exact candidate set was already
    // scored on a prior attempt (different broadened query, identical provider
    // results) — the verdict is provably the same. Placed AFTER poolIsWeak/bypass
    // so neither early-exit is affected; continue lets a later distinct pool score.
    const sig = pool.map((h) => h.dedupeId).sort().join("|");
    if (scoredPools.has(sig)) {
      log(runId, "debug", `Beat ${beat.index}: retry ${attempt}/2 skipped — candidate pool identical to a prior scored pool`, { stage: "visual" });
      continue;
    }
    scoredPools.add(sig);

    const { picks: scored, reserve } = await scoreAndPick(runId, beat.index, query, beat.text, videoContext, pool);
    // Hold what the cut dropped. Accumulated ACROSS attempts and drained once, late (below):
    // a later broadened attempt can still produce a Gemini-scored passer, which is strictly
    // better than a lexically-admitted reserve, so spending them early would be a downgrade.
    for (const h of reserve) if (!usedIds.has(h.dedupeId)) reservePool.set(h.dedupeId, h);
    for (const s of scored) if (!bestSeen || s.score > bestSeen.score) bestSeen = { score: s.score, provider: s.hit.provider ?? "?" };
    // Strict: keep the best hit ACROSS attempts. Ties break on rankKey so an all-equal
    // pool (e.g. REAL_MATCH_THRESHOLD=0 → every score 0) still prefers video/Pexels
    // rather than whatever happened to be first.
    if (strict) {
      for (const s of scored) {
        if (usedIds.has(s.hit.dedupeId)) continue;
        if (!bestHit || s.score > bestHit.score || (s.score === bestHit.score && rankKey(s) > rankKey(bestHit))) {
          bestHit = { hit: s.hit, score: s.score };
        }
      }
    }
    // Try EVERY candidate that clears the bar, best first. A download failure
    // (e.g. Wikimedia 429 rate-limit) used to discard a 95% match and fall
    // straight to AI — now it just moves to the next passing candidate.
    // Kind-specific acceptance bars. Gemini-success path: video >= 75, image >= 85.
    // Lexical-fallback path (Gemini unavailable) is UNCHANGED: video >= 65, image >= 80.
    const passing = scored
      .filter((c) =>
        c.fallback
          ? (c.hit.kind === "video" ? c.score >= LEX_VIDEO_BAR : c.score >= LEX_IMAGE_BAR)
          : (c.hit.kind === "video" ? c.score >= VIDEO_MATCH_THRESHOLD : c.score >= IMAGE_MATCH_THRESHOLD)
      )
      .sort((a, b) => rankKey(b) - rankKey(a)); // bars gate; rankKey only reorders the passers (video/provider preference)
    for (const cand of passing) {
      if (usedIds.has(cand.hit.dedupeId)) continue;
      usedIds.add(cand.hit.dedupeId);
      try {
        const res = await materialize(runId, beat, cand.hit, beatDurSec, outPath, resolution);
        log(runId, "info", `Beat ${beat.index}: real ${res.kind} via ${cand.hit.provider} — match ${cand.score}% (${searchQuery})`, { stage: "visual" });
        return res;
      } catch (e) {
        log(runId, "debug", `Beat ${beat.index}: ${cand.hit.provider} ${cand.score}% failed to download (${(e as Error).message.slice(0, 80)}) — trying next candidate`, { stage: "visual" });
      }
    }
  }

  // ── Reserve tier — the candidates the pre-Gemini cut dropped ────────────────
  // Every attempt above gathered up to SOURCE_POOL_MAX candidates but could only send
  // MAX_GEMINI_CANDIDATES to the scorer; the remainder used to be discarded, so a beat
  // could go and pay for AI generation while a matching real clip sat unused in memory.
  //
  // Drained ONCE, here, rather than per attempt: a later broadened attempt can still yield a
  // Gemini-scored passer, and that is strictly better than a lexically-admitted reserve.
  // Placed before the YouTube rung because these are already fetched, free, and licensed
  // stock, whereas YouTube costs a download and carries copyright risk.
  if (reservePool.size > 0) {
    const admitted = reserveCandidates([...reservePool.values()], query, usedIds);
    if (admitted.length > 0) {
      log(runId, "info", `Beat ${beat.index}: no candidate cleared the bar — trying ${admitted.length} of ${reservePool.size} held-back candidate(s) before AI`, { stage: "visual" });
    }
    for (const cand of admitted) {
      if (usedIds.has(cand.hit.dedupeId)) continue;
      usedIds.add(cand.hit.dedupeId);
      try {
        const res = await materialize(runId, beat, cand.hit, beatDurSec, outPath, resolution);
        log(runId, "info", `Beat ${beat.index}: real ${res.kind} via ${cand.hit.provider} — held-back candidate (lexical ${Math.round(cand.score)}, never scored by Gemini)`, { stage: "visual" });
        return res;
      } catch (e) {
        log(runId, "debug", `Beat ${beat.index}: held-back ${cand.hit.provider} failed to download (${(e as Error).message.slice(0, 80)}) — trying next`, { stage: "visual" });
      }
    }
  }

  // YouTube clip fallback (opt-in) — real MOVING footage when stock/web stills
  // didn't clear the bar, BEFORE giving up to AI. The clip's own frame is scored
  // by the same vision pass (relevance + reject on-screen text), so a clip is
  // only used if it actually matches and is clean.
  // Patch A — runs for any beat that did NOT already try YouTube-first: archival
  // (youtubeFirst) already probed YouTube and is excluded here; contemporary beats
  // now get the stock → YouTube → AI fallback that YT_ROUTING=1 had removed. Legacy
  // (YT_ROUTING=0, youtubeFirst always false) keeps the end-fallback for all — unchanged.
  if (!youtubeFirst && realMedia !== "image") {
    const yt = await youtubeScoredFallback(runId, beat, query, beatDurSec, outPath, usedIds, videoContext);
    if (yt) return yt;
  }

  // ── Real-footage-only (strict) — the bar itself is the last thing to go ──────
  // Everything above already ran: broadened attempts (incl. the extra level-3 one),
  // the full provider fan-out and YouTube. Nothing cleared the 75/80 bar, so accept
  // the BEST real candidate at ANY score rather than generating AI. This IS the
  // threshold relaxation — the bar is now 0, so there is nothing further to relax.
  if (strict && bestHit && !usedIds.has(bestHit.hit.dedupeId)) {
    usedIds.add(bestHit.hit.dedupeId);
    try {
      const res = await materialize(runId, beat, bestHit.hit, beatDurSec, outPath, resolution);
      log(runId, "info", `Beat ${beat.index}: real ${res.kind} via ${bestHit.hit.provider} — accepted below bar (${bestHit.score}%, Real-footage-only)`, { stage: "visual" });
      return res;
    } catch (e) {
      log(runId, "debug", `Beat ${beat.index}: best-effort candidate failed to download (${(e as Error).message.slice(0, 80)})`, { stage: "visual" });
    }
  }

  // Last-ditch (strict): every attempt's pool came back EMPTY. The usual cause is
  // usedIds exhaustion — the matches exist but other beats took them. Re-gather
  // ignoring usedIds and accept a REPEAT: the same footage twice is still real, and
  // this picks the most RELEVANT repeat (vs the pipeline's positionally-nearest one).
  if (strict && !bestHit) {
    const wideQuery = broadenQuery(baseQuery, 1);
    let pool = await gatherCandidates(runId, wideQuery, beatDurSec, NO_USED_FILTER);
    if (realMedia === "image" || realMedia === "video") pool = pool.filter((h) => h.kind === realMedia);
    if (pool.length > 0) {
      const { picks: scored } = await scoreAndPick(runId, beat.index, query, beat.text, videoContext, pool);
      // The reserve is not consulted here: this rung already re-gathers with NO_USED_FILTER
      // and accepts a repeat at any score, so it is strictly broader than the reserve is.
      const ranked = [...scored].sort((a, b) => b.score - a.score || rankKey(b) - rankKey(a));
      for (const cand of ranked) {
        try {
          const res = await materialize(runId, beat, cand.hit, beatDurSec, outPath, resolution);
          log(runId, "info", `Beat ${beat.index}: real ${res.kind} via ${cand.hit.provider} — accepted a repeat (${cand.score}%, Real-footage-only; no unused footage left)`, { stage: "visual" });
          return res;
        } catch {
          /* try the next candidate */
        }
      }
    }
  }

  log(runId, "warn", `Beat ${beat.index}: real retrieval exhausted after ${maxAttempts} attempts — ${strict ? "no real media reachable (Real-footage-only)" : "routing to AI"} (bestScore=${bestSeen ? bestSeen.score : "n/a"}, bestProvider=${bestSeen ? bestSeen.provider : "—"}, finalQuery="${lastSearchQuery}")`, { stage: "visual" });
  return null;
}

function aiAspect(resolution?: string): string {
  const m = (resolution || "").match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (h > w) return "9:16";
    if (w === h) return "1:1";
    return "16:9";
  }
  const o = orientationSetting();
  return o === "portrait" ? "9:16" : o === "square" ? "1:1" : "16:9";
}

const IMG_STOPWORDS = new Set(
  ("the a an and or but of to in on for with by at from as is are was were be this that these those it its you your we our they their will would can could should what why how when where who about into over under then than so just more very really there here not no yes if have has had do does did".split(/\s+/))
);
/** Reduce a sentence to a few concrete keywords — NEVER feed raw narration to an
 *  image model (it renders the sentence as on-screen text, e.g. a card with the
 *  script written on it). */
function keywordsOnly(text: string): string {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => w.length > 2 && !IMG_STOPWORDS.has(w));
  return (kept.length ? kept : words).slice(0, 8).join(" ");
}

/** Score ONE locally-generated image 0-100 for fit to the scene + video context (vision). */
async function scoreLocalImage(
  runId: string,
  beatIndex: number,
  sceneQuery: string,
  sceneText: string,
  videoContext: string | undefined,
  filePath: string,
  mode: "ai" | "footage" = "ai",
  footageKind?: "archival" | "contemporary" | "conceptual"
): Promise<number> {
  // Every `return 100` below is a FAIL-OPEN: the judge could not judge, so the frame is
  // accepted. That routing is deliberate and unchanged — but 100 clears every bar and reads
  // in the log exactly like a genuine perfect score, so each one now says so once per run.
  // See vision-qc.ts; it reports and routes nothing.
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) {
    noteVisionUnjudged(runId, "no GOOGLE_API_KEY is set, so there is no judge at all");
    return 100; // can't judge → accept
  }
  let data: string;
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.byteLength === 0 || buf.byteLength > 6 * 1024 * 1024) {
      noteVisionUnjudged(runId, `a frame was ${buf.byteLength === 0 ? "empty" : "too large to send (over 6 MB)"}`);
      return 100; // too big to send → accept
    }
    data = buf.toString("base64");
  } catch {
    noteVisionUnjudged(runId, "a frame could not be read from disk");
    return 100;
  }
  const mime = filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  // AI-still QC (nano-banana) vs REAL-footage QC (YouTube/archival/broadcast). The
  // footage rubric judges relevance/usability and must NOT penalize legitimate
  // real-world video traits (overlays, grain, low-res) that the AI rubric rejects.
  const instr =
    mode === "footage"
      ? `You are judging ONE FRAME from a REAL stock/archival/broadcast VIDEO clip for a documentary scene. ` +
        `This is REAL footage, NOT an AI image — normal real-world video traits are EXPECTED and must NOT lower the score: ` +
        `small peripheral channel/network logos or bugs, small timestamps, film grain, analog softness, ` +
        `low/standard resolution, letterboxing, archival artifacts, and real public figures. ` +
        `Historical television footage, documentaries, and archival news footage are valid even if grainy, soft, or low-resolution.\n` +
        `OVERALL VIDEO TOPIC: "${(videoContext || sceneText).slice(0, 300)}"\n` +
        `THIS SCENE: "${sceneText.slice(0, 200)}"\nWANTED SUBJECT: "${sceneQuery}"\n` +
        `Score 0-100 on whether this frame is USABLE B-roll for the scene, judged ONLY on: ` +
        `(1) semantic relevance — does it show the wanted subject/scene? (DOMINANT factor). A recognizable person ` +
        `matching the query is NOT sufficient on its own: the SETTING / LOCATION / COMPANY / EVENT in the frame must ALSO ` +
        `be consistent with the wanted scene and the overall video topic. If the right person appears in a clearly ` +
        `different place or context than the narration describes (e.g. the wanted scene is a Tesla factory interior but ` +
        `the frame is a SpaceX office or a neutral studio), score 40 or below as OFF-CONTEXT — identity alone is not relevance; ` +
        `(2) subject visibility & framing — is the subject actually visible and usably framed?; ` +
        `(3) frame integrity — intact image, not black, not a fade/transition, not corrupted/garbled. ` +
        `Score LOW (0-40) ONLY if the subject is wrong or absent, the footage is irrelevant, the frame is ` +
        `black/transition/corrupted/unusable, OR a watermark/graphic is so large it covers the subject. ` +
        `CLEAN-FRAME RULE: score 40 or below if the frame carries PROMINENT burned-in text that would end up in our ` +
        `final video — subtitles / closed-captions, large titles or headlines, kinetic typography, quote/lyric overlays, ` +
        `a dominating lower-third name banner, or a large watermark. We must show CLEAN footage; readable on-screen text ` +
        `from someone else's edit is disqualifying. (A SMALL peripheral channel logo/bug or a small timestamp is still acceptable.) ` +
        `Do NOT lower the score for small peripheral logos, grain, softness, or low resolution ` +
        `(unless the subject is unidentifiable), or for the clip being real archival/broadcast material. ` +
        `NON-B-ROLL RULE (Patch 2.3b): score 39 or BELOW when the frame's PRIMARY content is a TALKING-HEAD / ` +
        `PRESENTATION format rather than depictive B-roll — i.e. a modern person addressing the camera in an ` +
        `interview, podcast, webcam/selfie shot, news-desk anchor, YouTuber/creator commentary, conference keynote ` +
        `or lecture-to-camera, reaction video, screencast, or a slide/presentation deck. These are commentary ABOUT ` +
        `the subject, not footage OF it. ` +
        `CARVE-OUT (do NOT penalize): when the person/event on screen IS the wanted subject itself — a historical or ` +
        `newsworthy figure giving the actual depicted address or press conference (e.g. Nixon's resignation, a JFK ` +
        `speech), or genuine archival/broadcast footage OF the real event — that is valid B-roll, score it normally. ` +
        `Distinguish by cues: modern studio/webcam/podcast set, slides, or a pundit commenting → reject; archival ` +
        `podium/broadcast of the real moment, or the named subject themselves → keep.\n` +
        `ALSO report three observations our pipeline enforces (report what you SEE — do not fold them into the score): ` +
        `"text" = "prominent" if the frame carries readable burned-in text that would land in our final video ` +
        `(subtitles/closed-captions, large titles/headlines, kinetic typography, code, quote/lyric overlays, a ` +
        `dominating lower-third name banner, or a large watermark); "minor" for only a small peripheral channel ` +
        `logo/bug or a small timestamp; "none" if clean. ` +
        `"context_ok" = false if the setting/location/company/event clearly contradicts the wanted scene ` +
        `(right person but wrong place/event, e.g. a courtroom or a SpaceX office when a Tesla factory was wanted), else true. ` +
        `"talking_head" = "yes" if the frame's PRIMARY content is a THIRD-PARTY talking-head / presentation format — ` +
        `a modern presenter, YouTuber/creator, host, news anchor, or pundit addressing the camera in an interview, ` +
        `podcast, webcam/selfie shot, news desk, reaction/commentary, conference keynote or lecture-to-camera, or a ` +
        `slide/presentation deck. CARVE-OUT: report "no" when the person/event shown IS the wanted subject itself ` +
        `(a historical or newsworthy figure giving the actual depicted address or press conference, or genuine ` +
        `archival/broadcast footage OF the real event); "no" for ordinary depictive B-roll with no presenter.\n` +
        `Return STRICTLY JSON {"score":<int>,"text":"none|minor|prominent","context_ok":<true|false>,"talking_head":"yes|no"}. No markdown.`
      : `You are quality-checking ONE AI-generated image for a documentary scene.\n` +
        `OVERALL VIDEO TOPIC: "${(videoContext || sceneText).slice(0, 300)}"\n` +
        `THIS SCENE: "${sceneText.slice(0, 200)}"\nWANTED VISUAL: "${sceneQuery}"\n` +
        `Score 0-100: does the IMAGE fit this scene AND the topic, look photorealistic and high quality, ` +
        `and contain NO readable text/letters/captions/fake labels? Any baked-in text, gibberish words, fantasy/abstract look, ` +
        `or off-topic subject must score LOW. Return STRICTLY JSON {"score":<int>}.`;
  const circuit = beginVisionCall(runId);
  if (!circuit.allow) return 100; // breaker open → fail-open without spending another Vision request
  try {
    const model = getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL");
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: instr }, { inline_data: { mime_type: mime, data } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } },
    });
    // Vision-only retry: stay on the configured Vision model (Flash-Lite by default),
    // with no cross-model escalation. Fails open to score 100 below.
    // timeoutMs is REQUIRED: without it callGemini does a plain fetch with NO abort, so an
    // overloaded/slow Gemini (503 storms) hangs this call FOREVER and freezes the whole run at
    // frame-scoring with no error (the plan/rerank paths already pass a timeout; this heaviest,
    // highest-volume vision path did not). 30s/attempt → on a hang it aborts, retries Flash-Lite,
    // then fails open (accept) instead of dead-locking the pipeline.
    const { json: j, model: usedModel } = await callGemini({
      apiKey, model, body, maxAttempts: circuit.probe ? 1 : 2, allowModelFallback: false, backoffMs: () => 0, timeoutMs: 30_000,
      onFailure: ({ reason }) => recordVisionAttemptFailure(runId, reason, circuit.probe),
    });
    recordVisionCallSuccess(runId, circuit.probe);
    // Cost Monitoring — per-frame / AI-gate vision scoring (the heaviest vision path).
    recordGemini(runId, "geminiVision", j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0, usedModel);
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const m = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as { score?: number; text?: string; context_ok?: boolean; talking_head?: string };
    let s = Number.isFinite(m.score) ? Math.max(0, Math.min(100, Number(m.score))) : 100;
    // Footage-only deterministic gates — we enforce policy in code, not by asking the
    // (no-thinking) scorer to self-penalize a buried rule (which it ignored, scoring text
    // frames 100). Fields absent (model didn't report) → graceful no-op (relevance only).
    if (mode === "footage") {
      // T1/T2 — PROMINENT burned-in text vetoes the frame: return sentinel -1 (the YouTube
      // caller hard-rejects the clip on any negative frame). WI-5 — EXCEPT archival: real
      // newsreels carry intertitles/chyrons, so footage_kind=archival tolerates text (the
      // frame keeps its relevance score instead of being vetoed).
      const allowText = footageKind === "archival";
      if (!allowText && typeof m.text === "string" && m.text.trim().toLowerCase() === "prominent") return -1;
      // R1 — third-party talking-head hard-veto: sentinel -2, consumed IDENTICALLY to the text
      // veto (-1) by the YouTube caller's `perFrame.some(s => s < 0)` (and excluded from the
      // clipScore math by `perFrame.filter(s => s >= 0)`). The carve-out is baked into the rubric
      // (it reports "no" when the person IS the wanted subject / genuine archival broadcast), so
      // legit subject/archival footage is never vetoed — only THIRD-PARTY presenters. Gated by
      // YT_HEAD_VETO (default "0") → byte-identical to today until the flag is set.
      if (getSetting("YT_HEAD_VETO") === "1" && typeof m.talking_head === "string" && m.talking_head.trim().toLowerCase() === "yes") return -2;
      // B1 — right subject but wrong setting/event → cap off-context (≤39) so a clip whose
      // frames are all off-context fails the corroboration bar and the next candidate is tried.
      if (m.context_ok === false) s = Math.min(s, 39);
    }
    return s;
  } catch (e) {
    // An exhausted key deserves its own, more specific line as well; both notices are
    // once-per-run and self-deduplicating, so this is at most two lines for a whole run.
    noteGeminiQuota(runId, (e as Error).message, "visual");
    noteVisionUnjudged(runId, `the vision API failed (${(e as Error).message.slice(0, 60)})`);
    return 100; // fail-open
  }
}

/**
 * Split one of our ban-clause strings into the two things it actually contains.
 *
 * Every AI backend but Runware lacks a negative-prompt field, so the bans have always
 * been glued onto the POSITIVE prompt as "no X" clauses. Runware has a native
 * `negativePrompt`, and it takes BARE terms: leaving "no text" in it is a double
 * negative that pushes the model toward text — the opposite of what we want.
 *
 * So rather than maintaining a second hand-written ban list (which would drift from
 * the one the other providers send), Runware DERIVES its negative prompt from the
 * exact same strings:
 *   - `toNegativeTerms` keeps the bans, stripped of their negation
 *     ("absolutely no text" → "text", "NOT sci-fi" → "sci-fi").
 *   - `keepPositiveClauses` keeps the clauses that are positive INSTRUCTIONS rather
 *     than bans ("blank unlabeled plain packaging"), which still belong on the
 *     positive side.
 * Together they partition the input, so nothing is silently dropped.
 */
export function toNegativeTerms(clauses: string): string {
  const out: string[] = [];
  for (const raw of clauses.split(",")) {
    const c = raw.trim();
    if (!c) continue;
    const m = c.match(/^(?:absolutely\s+)?(?:no|not)\s+(.+)$/i);
    if (m) out.push(m[1].trim());
  }
  return out.join(", ");
}

/** The complement of `toNegativeTerms` — the clauses that are NOT bans. */
export function keepPositiveClauses(clauses: string): string {
  const out: string[] = [];
  for (const raw of clauses.split(",")) {
    const c = raw.trim();
    if (!c) continue;
    if (!/^(?:absolutely\s+)?(?:no|not)\s+/i.test(c)) out.push(c);
  }
  return out.join(", ");
}

/**
 * Character-reference routing is intentionally based on the SCENE content only —
 * never on AI_IMAGE_STYLE. A style prompt can contain instructions such as
 * "when an adult female is depicted..." on every beat; reading that would force the
 * portrait into object-only scenes.
 */
export function beatWantsCharacterReference(beat: Pick<Beat, "aiPrompt" | "visualQuery" | "text">): boolean {
  const scene = [beat.aiPrompt, beat.visualQuery, beat.text].filter(Boolean).join(" ");
  const explicitCharacter = /\b(?:woman|women|female|housekeeper|housekeeping\s+(?:attendant|staff)|room\s+attendant|maid|cleaning\s+lady|professional\s+cleaner|cleaning\s+professional|cleaning\s+worker|hotel\s+(?:attendant|worker|staff|employee)|hospitality\s+professional|worker|employee|staff\s+member|she|her|hers)\b/i;
  // A configured portrait represents the channel's first-person presenter. Embodied
  // actions are a useful signal even when the narration says only “I” and the planner
  // omits “housekeeper” from its visual prompt. Avoid generic “I think / I know” so the
  // portrait is not forced into explanatory object shots.
  const embodiedFirstPerson = /\bI\s+(?:saw|noticed|looked|stepped|walked|entered|checked|cleaned|wiped|found|reached|picked|opened|closed|touched|examined|watched|worked|held|removed|sprayed)\b/i;
  return explicitCharacter.test(scene) || embodiedFirstPerson.test(scene);
}

const CHARACTER_REFERENCE_INSTRUCTION =
  "Use the supplied reference image ONLY as the identity reference for the adult female character. " +
  "Preserve the same woman's facial structure, hairstyle, apparent age, skin tone, and overall likeness. " +
  "Do not copy the reference background, pose, crop, or lighting; create the requested scene naturally. " +
  "Do not turn her into a generic stock-photo model.";

/** AI b-roll for a beat — kie.ai (nano-banana image + Ken Burns, or Veo video), 69labs/Grok, or Runware. */
async function acquireAi(
  runId: string,
  beat: Beat,
  beatDurSec: number,
  outPath: string,
  aiStyle?: string,
  resolution?: string,
  videoContext?: string,
  // Set ONLY on the AI-fallback path (a real beat with no footage), from FALLBACK_AI_MEDIA.
  // "image"/"video" pin the media; undefined = normal AI mode, media resolved as always.
  mediaOverride?: "image" | "video"
): Promise<VisualResult> {
  let provider = (getSetting("AI_PROVIDER") || "kie").toLowerCase();
  const selectedFlowBrowser = provider === "flow_browser";
  const flowFallbackToKie = selectedFlowBrowser && getSetting("FLOW_FALLBACK_PROVIDER").toLowerCase() === "kie";
  const style = (aiStyle ?? getSetting("AI_IMAGE_STYLE")) || "";
  const configuredCharacterRef = (getSetting("AI_CHARACTER_REFERENCE_PATH") || "").trim();
  const providerSupportsCharacterRef = provider === "kie" || provider === "flow_browser";
  const useCharacterRef = providerSupportsCharacterRef && !!configuredCharacterRef && beatWantsCharacterReference(beat);
  const characterReferencePath = useCharacterRef && fs.existsSync(configuredCharacterRef) ? configuredCharacterRef : "";
  if (useCharacterRef && !characterReferencePath) {
    log(runId, "warn", `Beat ${beat.index}: character reference is configured but the local image is missing — using text-to-image`, { stage: "visual" });
  }
  // Hard ban on baked-in text — nano-banana/Veo love to render the prompt (or the
  // narration) onto cards, boxes and signs. Also blank/unlabeled packaging so it
  // doesn't invent fake brand labels.
  const noTextDefault =
    "absolutely no text, no captions, no words, no letters, no numbers, no labels, no brand names, no logos, " +
    "no signs, no posters, no handwriting, no writing on any object, blank unlabeled plain packaging, no watermark";
  // A PRODUCT shot the planner labelled. The ban above is not merely relaxed here, it is
  // replaced: measured on real runs, "blank unlabeled plain packaging" does not just strip
  // the lettering, it flattens the product into a featureless solid — a script line naming
  // "Arm & Hammer Super Washing Soda" rendered as a plain yellow cube on a shop floor. So
  // this list has to assert the product's IDENTITY first and the lettering second; a
  // correctly-spelled label on an anonymous block is the same failure.
  //
  // Note the clause forms are load-bearing: `keepPositiveClauses`/`toNegativeTerms` split
  // this list by the leading "no"/"not", so the product and label clauses stay in the
  // positive prompt and the bans go to Runware's negativePrompt. "blank unlabeled plain
  // packaging" is POSITIVE and must not appear here at all — it would survive into the
  // positive half and go on erasing the product.
  const productLabel = beat.productLabel;
  const noTextProduct = productLabel
    ? `the real product itself, a recognisable retail item of its category with authentic packaging design — ` +
      `correct shape, cap or dispenser, printed graphics and typography, not a plain coloured box, ` +
      `its packaging clearly and correctly reads "${productLabel}", sharp legible lettering, ` +
      `no other text anywhere in the frame, no captions, no subtitles, no signs, no posters, ` +
      `no handwriting, no gibberish lettering, no watermark`
    : null;
  const noText = noTextProduct ?? noTextDefault;
  // Anchor the generation to the WHOLE video's topic, not just this sentence —
  // an abstract per-scene prompt was producing off-topic art (e.g. a fantasy
  // mage for a laundry-detergent video). Plus hard quality + realism negatives.
  const topic = (videoContext || "").trim().slice(0, 160);
  const contextAnchor = topic ? `in a documentary about: ${topic}` : "";
  // The realism clause is two halves: what we WANT, and what we must AVOID. Split into
  // named constants so Runware can route the avoid-half to its native negativePrompt
  // while `realism` below still composes to the byte-identical string kie / 69labs /
  // Magnific have always received. (Pinned by a test — this must not drift.)
  const realismWant =
    "photorealistic, real-world, high quality, sharp focus, high resolution, natural lighting, documentary photography";
  const realismAvoid =
    "NOT fantasy, NOT sci-fi, NOT surreal, NOT abstract, NOT digital art, NOT illustration, NOT 3D render, no glowing magic, no neon";
  const realism = `${realismWant}. ${realismAvoid}`;
  // Prefer the rich Gemini-written generation prompt; fall back to the short stock
  // query, then to KEYWORDS of the narration — never the raw sentence (it gets
  // rendered as on-screen text).
  const base = beat.aiPrompt || beat.visualQuery || keywordsOnly(beat.text);
  const VARIANTS = ["", "alternative composition, different camera angle", "another realistic shot, cleaner simple framing", "wider establishing shot", "tighter close-up detail"];
  const buildPrompt = (v: string) => [base, contextAnchor, style, realism, noText, v].filter(Boolean).join(", ");
  // Runware variant: the SAME pieces, with both ban lists lifted out of the positive
  // prompt into the native negativePrompt below. Only the placement differs — base,
  // contextAnchor, style and the variant are shared verbatim, so there is no second
  // prompt to keep in sync. Positive-instruction clauses ("blank unlabeled plain
  // packaging") stay on the positive side, where they belong.
  const buildCleanPrompt = (v: string) =>
    [base, contextAnchor, style, realismWant, keepPositiveClauses(noText), v].filter(Boolean).join(", ");
  const negativePrompt = toNegativeTerms(`${noText}, ${realismAvoid}`);
  const aspect = aiAspect(resolution);
  const gateQuery = visualPromptToQuery(beat.visualQuery || beat.text) || base;
  // AI images typically score 68–78; gate AI on its OWN (lower) threshold so the
  // regen loop early-exits instead of always running maxAttempts. Final best-of-N
  // selection is unchanged — only the early-exit bar moves.
  const threshold = Math.max(0, Math.min(100, Number(getSetting("AI_MATCH_THRESHOLD") || getSetting("REAL_MATCH_THRESHOLD") || "75")));
  // Regenerate until the image clears the threshold, capped so an impossible
  // scene can't loop forever (then the best of the attempts is kept).
  const maxAttempts = Math.max(1, Math.min(8, Number(
    selectedFlowBrowser
      ? (getSetting("FLOW_REGEN_ATTEMPTS") || "1")
      : (getSetting("AI_REGEN_ATTEMPTS") || "5")
  )));

  // Magnific AI — one more AI b-roll backend (Mystic images + Ken Burns, or Hailuo
  // video). Used both as the CHOSEN provider (AI_PROVIDER=magnific) and, when
  // enabled, as a fallback for the other engines. Mirrors the kie branch exactly:
  // honors the image/video/auto media mode and runs the same scoring/regen loop.
  // Returns null if it produced nothing (caller falls through); never throws.
  const tryMagnific = async (): Promise<VisualResult | null> => {
    const { media, reason } = resolveAiMedia(beat, mediaOverride);
    log(runId, "debug", `Beat ${beat.index}: Magnific media = ${media} (reason=${reason})`, { stage: "visual" });
    if (media === "video") {
      try {
        log(runId, "info", `Beat ${beat.index}: Magnific video generation started (Hailuo)`, { stage: "visual" });
        const url = await generateMagnificVideoUrl(runId, buildPrompt(""), aspect, Math.ceil(beatDurSec));
        await downloadMagnific(url, outPath);
        recordMagnificVideo(runId, 6); // Cost Monitoring — Hailuo 1080p renders a fixed 6s clip
        log(runId, "info", `Beat ${beat.index}: Magnific video generation completed (Hailuo)`, { stage: "visual" });
        return { path: outPath, kind: "ai", provider: "magnific:video" };
      } catch (e) {
        log(runId, "warn", `Beat ${beat.index}: Magnific video failed (${(e as Error).message.slice(0, 160)}) — trying Magnific image`, { stage: "visual" });
        // fall through to the Mystic image path below
      }
    }
    let best: { path: string; score: number } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const tmpImg = path.join(os.tmpdir(), `mag_${runId.slice(0, 8)}_${beat.index}_${attempt}.png`);
      try {
        const url = await generateMagnificImageUrl(runId, buildPrompt(VARIANTS[attempt % VARIANTS.length]), aspect);
        await downloadMagnific(url, tmpImg);
        recordMagnificImage(runId); // Cost Monitoring — every generated image is billed (incl. regens)
      } catch (e) {
        log(runId, "debug", `Beat ${beat.index}: Magnific image gen failed (${(e as Error).message.slice(0, 80)})`, { stage: "visual" });
        if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const score = maxAttempts === 1 ? 100 : await scoreLocalImage(runId, beat.index, gateQuery, beat.text, videoContext, tmpImg);
      if (!best || score > best.score) {
        if (best) { try { fs.unlinkSync(best.path); } catch {} }
        best = { path: tmpImg, score };
      } else {
        try { fs.unlinkSync(tmpImg); } catch {}
      }
      if (score >= threshold) break;
      if (attempt < maxAttempts - 1) {
        log(runId, "info", `Beat ${beat.index}: Magnific image scored ${score}% (<${threshold}) — regenerating ${attempt + 1}/${maxAttempts - 1}`, { stage: "visual" });
      }
    }
    if (best) {
      kenBurns(best.path, outPath, beatDurSec, beat.index % 2 === 1, resolution);
      try { fs.unlinkSync(best.path); } catch {}
      log(runId, "info", `Beat ${beat.index}: AI still via Magnific/Mystic + Ken Burns — match ${best.score}%`, { stage: "visual" });
      return { path: outPath, kind: "ai", provider: "magnific:mystic" };
    }
    return null;
  };

  // Higgsfield — one more AI b-roll backend (Soul images + Ken Burns, or DoP/Kling
  // video). Used both as the CHOSEN provider (AI_PROVIDER=higgsfield) and, when enabled,
  // as a fallback for the other engines. Mirrors the Magnific closure exactly: honors the
  // image/video media mode and runs the same scoring/regen loop. Returns null if it
  // produced nothing (caller falls through); never throws.
  const tryHiggsfield = async (): Promise<VisualResult | null> => {
    const { media, reason } = resolveAiMedia(beat, mediaOverride);
    log(runId, "debug", `Beat ${beat.index}: Higgsfield media = ${media} (reason=${reason})`, { stage: "visual" });
    if (media === "video") {
      try {
        log(runId, "info", `Beat ${beat.index}: Higgsfield video generation started (DoP)`, { stage: "visual" });
        const url = await generateHiggsfieldVideoUrl(runId, buildPrompt(""), aspect, Math.ceil(beatDurSec));
        await downloadHiggsfield(url, outPath);
        recordHiggsfieldVideo(runId, Math.ceil(beatDurSec)); // Cost Monitoring — billed per video-second
        log(runId, "info", `Beat ${beat.index}: Higgsfield video generation completed (DoP)`, { stage: "visual" });
        return { path: outPath, kind: "ai", provider: "higgsfield:dop" };
      } catch (e) {
        log(runId, "warn", `Beat ${beat.index}: Higgsfield video failed (${(e as Error).message.slice(0, 160)}) — trying Higgsfield image`, { stage: "visual" });
        // fall through to the Soul image path below
      }
    }
    let best: { path: string; score: number } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const tmpImg = path.join(os.tmpdir(), `hf_${runId.slice(0, 8)}_${beat.index}_${attempt}.png`);
      try {
        const url = await generateHiggsfieldImageUrl(runId, buildPrompt(VARIANTS[attempt % VARIANTS.length]), aspect);
        await downloadHiggsfield(url, tmpImg);
        recordHiggsfieldImage(runId); // Cost Monitoring — every generated image is billed (incl. regens)
      } catch (e) {
        log(runId, "debug", `Beat ${beat.index}: Higgsfield image gen failed (${(e as Error).message.slice(0, 80)})`, { stage: "visual" });
        if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const score = maxAttempts === 1 ? 100 : await scoreLocalImage(runId, beat.index, gateQuery, beat.text, videoContext, tmpImg);
      if (!best || score > best.score) {
        if (best) { try { fs.unlinkSync(best.path); } catch {} }
        best = { path: tmpImg, score };
      } else {
        try { fs.unlinkSync(tmpImg); } catch {}
      }
      if (score >= threshold) break;
      if (attempt < maxAttempts - 1) {
        log(runId, "info", `Beat ${beat.index}: Higgsfield image scored ${score}% (<${threshold}) — regenerating ${attempt + 1}/${maxAttempts - 1}`, { stage: "visual" });
      }
    }
    if (best) {
      kenBurns(best.path, outPath, beatDurSec, beat.index % 2 === 1, resolution);
      try { fs.unlinkSync(best.path); } catch {}
      log(runId, "info", `Beat ${beat.index}: AI still via Higgsfield/Soul + Ken Burns — match ${best.score}%`, { stage: "visual" });
      return { path: outPath, kind: "ai", provider: "higgsfield:soul" };
    }
    return null;
  };

  if (provider === "magnific") {
    if (magnificConfigured()) {
      const r = await tryMagnific();
      if (r) return r;
      // Magnific produced nothing — don't lose the beat; fall through to the
      // universal 69labs/Grok floor below (throws only if that also fails).
      log(runId, "warn", `Beat ${beat.index}: Magnific produced nothing after ${maxAttempts} attempts — falling back to 69labs/Grok`, { stage: "visual" });
    } else {
      // Magnific is the chosen provider but disabled (MAGNIFIC_ENABLED=0) or has no
      // key — skip it immediately (no wasted retries/backoff) and drop to the floor.
      log(runId, "warn", `Beat ${beat.index}: Magnific selected but disabled or unconfigured — falling back to 69labs/Grok`, { stage: "visual" });
    }
  }

  if (provider === "higgsfield") {
    if (higgsfieldConfigured()) {
      const r = await tryHiggsfield();
      if (r) return r;
      // Higgsfield produced nothing — don't lose the beat; fall through to the
      // universal 69labs/Grok floor below (throws only if that also fails).
      log(runId, "warn", `Beat ${beat.index}: Higgsfield produced nothing after ${maxAttempts} attempts — falling back to 69labs/Grok`, { stage: "visual" });
    } else {
      // Higgsfield is the chosen provider but disabled (HIGGSFIELD_ENABLED=0) or missing a
      // key/secret — skip it immediately (no wasted retries/backoff) and drop to the floor.
      log(runId, "warn", `Beat ${beat.index}: Higgsfield selected but disabled or unconfigured — falling back to 69labs/Grok`, { stage: "visual" });
    }
  }

  if (provider === "flow_browser") {
    // The browser adapter is intentionally image-only and serialized inside
    // flow-browser.ts. Even though studio-pipeline requests several beats in parallel,
    // prompts/downloads can never cross. A videos-only fallback must not silently turn
    // into a still; if the operator enabled kie fallback, the normal kie branch below
    // remains able to honor it.
    if (mediaOverride === "video") {
      throw new FlowBrowserError("Google Flow browser is image-only, but this fallback beat requires video.", "config");
    }

    let best: { path: string; score: number } | null = null;
    let flowError: Error | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const tmpImg = path.join(os.tmpdir(), `flow_${runId.slice(0, 8)}_${beat.index}_${attempt}.png`);
      try {
        const flowPrompt = characterReferencePath
          ? `${buildPrompt(VARIANTS[attempt % VARIANTS.length])}, ${CHARACTER_REFERENCE_INSTRUCTION}`
          : buildPrompt(VARIANTS[attempt % VARIANTS.length]);
        log(
          runId,
          "info",
          `Beat ${beat.index}: Google Flow/Nano Banana generation started (${attempt + 1}/${maxAttempts})${characterReferencePath ? " — character reference active" : ""}`,
          { stage: "visual" }
        );
        await generateFlowImage(
          runId,
          flowPrompt,
          tmpImg,
          getSetting("FLOW_ASPECT_RATIO") || aspect,
          characterReferencePath ? { referenceImagePath: characterReferencePath } : undefined
        );
      } catch (e) {
        flowError = e as Error;
        try { fs.unlinkSync(tmpImg); } catch {}
        log(runId, "warn", `Beat ${beat.index}: Google Flow browser failed (${(e as Error).message.slice(0, 180)})`, { stage: "visual" });
        break; // UI/login failures are not improved by submitting the same prompt again.
      }
      const score = maxAttempts === 1 ? 100 : await scoreLocalImage(runId, beat.index, gateQuery, beat.text, videoContext, tmpImg);
      if (!best || score > best.score) {
        if (best) { try { fs.unlinkSync(best.path); } catch {} }
        best = { path: tmpImg, score };
      } else {
        try { fs.unlinkSync(tmpImg); } catch {}
      }
      if (score >= threshold) break;
      if (attempt < maxAttempts - 1) {
        log(runId, "info", `Beat ${beat.index}: Flow image scored ${score}% (<${threshold}) — regenerating ${attempt + 1}/${maxAttempts - 1}`, { stage: "visual" });
      }
    }
    if (best) {
      kenBurns(best.path, outPath, beatDurSec, beat.index % 2 === 1, resolution);
      try { fs.unlinkSync(best.path); } catch {}
      log(runId, "info", `Beat ${beat.index}: AI still via Google Flow/Nano Banana Pro + Ken Burns — match ${best.score}%`, { stage: "visual" });
      return { path: outPath, kind: "ai", provider: "flow:nano-banana-pro" };
    }

    if (!flowFallbackToKie) {
      // Fail closed: "Nano Banana through Flow only" must never drift into Grok,
      // Cloudflare, Pollinations, Meta, Magnific, or another paid model.
      if (flowError instanceof FlowBrowserError) throw flowError;
      throw new FlowBrowserError(`Beat ${beat.index}: Google Flow produced no image and paid fallback is disabled.`, "capture");
    }
    log(runId, "warn", `Beat ${beat.index}: Flow unavailable — using the configured kie.ai Nano Banana fallback`, { stage: "visual" });
    provider = "kie";
  }

  if (provider === "kie") {
    const { media, reason } = resolveAiMedia(beat, mediaOverride);
    log(runId, "debug", `Beat ${beat.index}: AI media = ${media} (reason=${reason})`, { stage: "visual" });
    if (media === "video") {
      // On any Veo failure (safety block, transient 500, timeout) DON'T lose the
      // beat: log once and fall through to the nano-banana image branch below.
      // Only if that also fails does acquireAi throw → pipeline neighbour reuse.
      try {
        const veoSec = Math.ceil(beatDurSec);
        const url = await generateVideoUrl(runId, buildPrompt(""), aspect, veoSec);
        await downloadKie(url, outPath);
        recordKieVeo(runId, veoSec); // Cost Monitoring — Veo billed per video-second
        log(runId, "info", `Beat ${beat.index}: AI video via kie.ai/Veo`, { stage: "visual" });
        return { path: outPath, kind: "ai", provider: "kie:veo" };
      } catch (e) {
        noteCreditExhausted(runId, "kie.ai", (e as Error).message, "visual");
        // "Videos only" fallback (mediaOverride==="video") means the operator asked for
        // AI video and NOT images — so don't quietly produce a still here. Rethrow → the
        // pipeline reuses a neighbouring visual for this beat instead. Normal AI-video
        // mode (no override) keeps the beat-saving image fallthrough, byte-identical.
        if (mediaOverride === "video") {
          log(runId, "warn", `Beat ${beat.index}: AI video (Veo) failed (${(e as Error).message.slice(0, 160)}) — Videos-only fallback, refusing to drop to an image`, { stage: "visual" });
          throw e;
        }
        log(runId, "warn", `Beat ${beat.index}: AI video (Veo) failed (${(e as Error).message.slice(0, 160)}) — falling back to AI image`, { stage: "visual" });
        // fall through to the nano-banana image branch (no rethrow, no return)
      }
    }
    // nano-banana image → score against the scene/context → regenerate if weak.
    // The SAME REAL_MATCH_THRESHOLD that gates real footage also gates AI here.
    if (characterReferencePath) {
      log(runId, "debug", `Beat ${beat.index}: character reference active — Nano Banana Edit (image-to-image)`, { stage: "visual" });
    }

    // Cheap-to-premium still-image chain for ordinary scenes:
    // Cloudflare -> Pollinations Z-Image -> Meta Muse -> kie.ai/Nano Banana.
    // Every intermediate image goes through the same Gemini quality gate. Character-reference
    // scenes deliberately skip the chain and stay on Nano Banana Edit for identity consistency.
    if (!characterReferencePath && !selectedFlowBrowser) {
      if (cloudflareImageConfigured() && !cloudflareDisabledRuns.has(runId)) {
        const cfImg = path.join(os.tmpdir(), `cf_${runId.slice(0, 8)}_${beat.index}.png`);
        try {
          log(runId, "debug", `Beat ${beat.index}: Cloudflare first-pass — FLUX.2 Klein 4B`, { stage: "visual" });
          const cfGeneration = await generateCloudflareImage(runId, buildPrompt(""), cfImg, aspect, {
            onRetry: ({ attempt, nextAttempt, delayMs, code, profileLabel }) => {
              log(runId, "warn", `Beat ${beat.index}: Cloudflare ${profileLabel || "profile"} HTTP 429${code ? ` / ${code}` : ""} — retry ${nextAttempt}/3 in ${(delayMs / 1000).toFixed(0)}s (attempt ${attempt} failed)`, { stage: "visual" });
            },
            onProfileFailover: ({ fromProfileLabel, toProfileLabel, status, code, message }) => {
              log(runId, "warn", `Beat ${beat.index}: Cloudflare operational failover ${fromProfileLabel} → ${toProfileLabel} (HTTP ${status ?? "?"}${code ? ` / ${code}` : ""}: ${message.slice(0, 110)})`, { stage: "visual" });
            },
          });
          const cfScore = await scoreLocalImage(runId, beat.index, gateQuery, beat.text, videoContext, cfImg);
          if (cfScore >= threshold) {
            kenBurns(cfImg, outPath, beatDurSec, beat.index % 2 === 1, resolution);
            try { fs.unlinkSync(cfImg); } catch {}
            log(runId, "info", `Beat ${beat.index}: AI still via Cloudflare/FLUX.2 Klein [${cfGeneration.profileLabel}] + Ken Burns — match ${cfScore}% (later providers avoided)`, { stage: "visual" });
            return { path: outPath, kind: "ai", provider: "cloudflare:flux-2-klein" };
          }
          try { fs.unlinkSync(cfImg); } catch {}
          log(runId, "info", `Beat ${beat.index}: Cloudflare image scored ${cfScore}% (<${threshold}) — trying Pollinations next`, { stage: "visual" });
        } catch (e) {
          try { fs.unlinkSync(cfImg); } catch {}
          const err = e as Error;
          const cfErr = e instanceof CloudflareImageError ? e : null;
          const status = cfErr?.status;
          const cfCode = cfErr?.cfCode;
          const cfMsg = (cfErr?.cfMessage || err.message).slice(0, 140);
          if (isCloudflareDailyQuotaError(cfErr)) {
            cloudflareDisabledRuns.add(runId);
            log(runId, "warn", `Beat ${beat.index}: Cloudflare disabled for this run (daily allocation exhausted, HTTP ${status ?? 429}${cfCode ? ` / ${cfCode}` : ""}) — trying Pollinations next`, { stage: "visual" });
          } else if (status === 401 || status === 403 || status === 404) {
            cloudflareDisabledRuns.add(runId);
            log(runId, "warn", `Beat ${beat.index}: Cloudflare disabled for this run (all usable profiles rejected/unavailable, HTTP ${status}) — trying Pollinations next`, { stage: "visual" });
          } else if (status === 429 && cfCode === 3040) {
            log(runId, "warn", `Beat ${beat.index}: Cloudflare temporarily unavailable this beat (HTTP 429 / 3040 after retries) — trying Pollinations next`, { stage: "visual" });
          } else if (status === 429) {
            log(runId, "warn", `Beat ${beat.index}: Cloudflare HTTP 429${cfCode ? ` / ${cfCode}` : ""} (${cfMsg}) — trying Pollinations next`, { stage: "visual" });
          } else {
            log(runId, "warn", `Beat ${beat.index}: Cloudflare failed (${err.message.slice(0, 140)}) — trying Pollinations next`, { stage: "visual" });
            noteCreditExhausted(runId, "Cloudflare", err.message, "visual");
          }
        }
      }

      if (pollinationsImageConfigured() && !pollinationsDisabledRuns.has(runId)) {
        const pollImg = path.join(os.tmpdir(), `pollinations_${runId.slice(0, 8)}_${beat.index}.png`);
        const pollModel = (getSetting("POLLINATIONS_IMAGE_MODEL") || "zimage").trim() || "zimage";
        try {
          log(runId, "debug", `Beat ${beat.index}: Pollinations second-pass — ${pollModel}`, { stage: "visual" });
          await generatePollinationsImage(buildPrompt(""), pollImg, aspect);
          const pollScore = await scoreLocalImage(runId, beat.index, gateQuery, beat.text, videoContext, pollImg);
          if (pollScore >= threshold) {
            kenBurns(pollImg, outPath, beatDurSec, beat.index % 2 === 1, resolution);
            try { fs.unlinkSync(pollImg); } catch {}
            log(runId, "info", `Beat ${beat.index}: AI still via Pollinations/${pollModel} + Ken Burns — match ${pollScore}% (Meta/kie.ai avoided)`, { stage: "visual" });
            return { path: outPath, kind: "ai", provider: `pollinations:${pollModel}` };
          }
          try { fs.unlinkSync(pollImg); } catch {}
          log(runId, "info", `Beat ${beat.index}: Pollinations image scored ${pollScore}% (<${threshold}) — trying Meta Muse next`, { stage: "visual" });
        } catch (e) {
          try { fs.unlinkSync(pollImg); } catch {}
          const pe = e instanceof PollinationsImageError ? e : null;
          const status = pe?.status;
          const msg = (pe?.pollinationsDetails || (e as Error).message).slice(0, 150);
          if (status === 401 || status === 402 || status === 403) {
            pollinationsDisabledRuns.add(runId);
            log(runId, "warn", `Beat ${beat.index}: Pollinations disabled for this run (HTTP ${status}: ${msg}) — trying Meta Muse next`, { stage: "visual" });
          } else {
            log(runId, "warn", `Beat ${beat.index}: Pollinations failed${status ? ` (HTTP ${status})` : ""} (${msg}) — trying Meta Muse next`, { stage: "visual" });
          }
        }
      }

      const metaApiKey = getSetting("META_API_KEY").trim();
      if (metaApiKey && !metaDisabledRuns.has(runId)) {
        const metaImg = path.join(os.tmpdir(), `meta_${runId.slice(0, 8)}_${beat.index}.png`);
        const metaModel = (getSetting("META_IMAGE_MODEL") || "muse-image-1.0").trim() || "muse-image-1.0";
        try {
          log(runId, "debug", `Beat ${beat.index}: Meta Muse third-pass — ${metaModel}`, { stage: "visual" });
          await generateMetaImage(buildPrompt(""), metaImg, aspect as "16:9" | "9:16", {
            apiKey: metaApiKey,
            baseUrl: getSetting("META_API_BASE_URL") || "https://api.meta.ai/v1",
            model: metaModel,
          });
          const metaScore = await scoreLocalImage(runId, beat.index, gateQuery, beat.text, videoContext, metaImg);
          if (metaScore >= threshold) {
            kenBurns(metaImg, outPath, beatDurSec, beat.index % 2 === 1, resolution);
            try { fs.unlinkSync(metaImg); } catch {}
            log(runId, "info", `Beat ${beat.index}: AI still via Meta Muse/${metaModel} + Ken Burns — match ${metaScore}% (kie.ai avoided)`, { stage: "visual" });
            return { path: outPath, kind: "ai", provider: `meta:${metaModel}` };
          }
          try { fs.unlinkSync(metaImg); } catch {}
          log(runId, "info", `Beat ${beat.index}: Meta Muse image scored ${metaScore}% (<${threshold}) — falling back to kie.ai`, { stage: "visual" });
        } catch (e) {
          try { fs.unlinkSync(metaImg); } catch {}
          const me = e instanceof MetaImageError ? e : null;
          const status = me?.status;
          const msg = (me?.metaDetails || (e as Error).message).slice(0, 150);
          if (status === 401 || status === 402 || status === 403 || status === 404) {
            metaDisabledRuns.add(runId);
            log(runId, "warn", `Beat ${beat.index}: Meta Muse disabled for this run (HTTP ${status}: ${msg}) — falling back to kie.ai`, { stage: "visual" });
          } else {
            log(runId, "warn", `Beat ${beat.index}: Meta Muse failed${status ? ` (HTTP ${status})` : ""} (${msg}) — falling back to kie.ai`, { stage: "visual" });
          }
        }
      }
    } else {
      log(runId, "debug", `Beat ${beat.index}: cheap-provider chain skipped — character reference scene stays on Nano Banana Edit`, { stage: "visual" });
    }

    let best: { path: string; score: number } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const tmpImg = path.join(os.tmpdir(), `kie_${runId.slice(0, 8)}_${beat.index}_${attempt}.png`);
      try {
        const variantPrompt = buildPrompt(VARIANTS[attempt % VARIANTS.length]);
        const prompt = characterReferencePath
          ? `${variantPrompt}, ${CHARACTER_REFERENCE_INSTRUCTION}`
          : variantPrompt;
        const url = await generateImageUrl(
          runId,
          prompt,
          aspect,
          characterReferencePath ? { referenceImagePath: characterReferencePath } : undefined
        );
        await downloadKie(url, tmpImg);
        recordKieImage(runId); // Cost Monitoring — every generated image is billed (incl. regens)
      } catch (e) {
        log(runId, "debug", `Beat ${beat.index}: AI image gen failed (${(e as Error).message.slice(0, 80)})`, { stage: "visual" });
        noteCreditExhausted(runId, "kie.ai", (e as Error).message, "visual");
        // WI-6 — back off between failed kie attempts so a transient "internal error" blip is
        // outlasted by the retry window (instant re-tries used to all hit the same outage).
        if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const score = maxAttempts === 1 ? 100 : await scoreLocalImage(runId, beat.index, gateQuery, beat.text, videoContext, tmpImg);
      if (!best || score > best.score) {
        if (best) { try { fs.unlinkSync(best.path); } catch {} }
        best = { path: tmpImg, score };
      } else {
        try { fs.unlinkSync(tmpImg); } catch {}
      }
      if (score >= threshold) break;
      if (attempt < maxAttempts - 1) {
        log(runId, "info", `Beat ${beat.index}: AI image scored ${score}% (<${threshold}) — regenerating ${attempt + 1}/${maxAttempts - 1}`, { stage: "visual" });
      }
    }
    if (best) {
      kenBurns(best.path, outPath, beatDurSec, beat.index % 2 === 1, resolution);
      try { fs.unlinkSync(best.path); } catch {}
      log(runId, "info", `Beat ${beat.index}: AI still via kie.ai/nano-banana + Ken Burns — match ${best.score}%`, { stage: "visual" });
      return { path: outPath, kind: "ai", provider: "kie:nano-banana" };
    }
    if (selectedFlowBrowser) {
      // The only permitted fallback for Flow mode is kie.ai Nano Banana. If it also
      // fails, stop here instead of reaching the universal Grok/provider chain below.
      throw new FlowBrowserError(`Beat ${beat.index}: Flow and kie.ai Nano Banana fallback both failed.`, "capture");
    }
    // WI-6 — kie.ai produced nothing (e.g. sustained "internal error"); don't lose the beat —
    // fall through to the 69labs/Grok engine below before giving up (throws only if THAT fails too).
    log(runId, "warn", `Beat ${beat.index}: kie.ai produced nothing after ${maxAttempts} attempts — falling back to 69labs/Grok`, { stage: "visual" });
  }
  // Runware — EXPERIMENTAL image backend. Structurally identical to the kie
  // nano-banana path above (generate → score → regenerate if weak → best-of-N →
  // Ken Burns); only the generation call differs, so every downstream stage sees the
  // same still on disk and cannot tell which provider made it. Image-only, so there
  // is no media-routing branch: it never generates AI video.
  if (provider === "runware") {
    // "Videos only" fallback means the operator asked for AI video and NOT images.
    // Runware cannot serve that, so skip it entirely rather than quietly returning a
    // still — the same promise the kie branch keeps at its Veo guard. Falling through
    // reaches the 69labs/Grok video engine below.
    if (mediaOverride === "video") {
      log(runId, "warn", `Beat ${beat.index}: Runware is image-only — Videos-only fallback, skipping to the AI video engine`, { stage: "visual" });
    } else {
      let best: { path: string; score: number } | null = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const tmpImg = path.join(os.tmpdir(), `rw_${runId.slice(0, 8)}_${beat.index}_${attempt}.png`);
        try {
          const variant = VARIANTS[attempt % VARIANTS.length];
          const img = await generateRunwareImage(runId, buildCleanPrompt(variant), {
            negativePrompt,
            // Some architectures (Seedream 4.0) refuse a negativePrompt. For those, the
            // bans go back inline via the very prompt every other provider already gets
            // — reused, not re-written, so there is still only one ban list.
            fallbackPrompt: buildPrompt(variant),
            resolution,
          });
          await downloadRunware(img.url, tmpImg);
          // Cost Monitoring — every generated image is billed (incl. regens). Runware
          // reports what it ACTUALLY charged, so this row is the real amount, not an
          // estimate; img.cost is null only if it reported none (never fabricated).
          recordRunwareImage(runId, img.cost, img.model);
        } catch (e) {
          log(runId, "debug", `Beat ${beat.index}: Runware image gen failed (${(e as Error).message.slice(0, 80)})`, { stage: "visual" });
          if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        const score = maxAttempts === 1 ? 100 : await scoreLocalImage(runId, beat.index, gateQuery, beat.text, videoContext, tmpImg);
        if (!best || score > best.score) {
          if (best) { try { fs.unlinkSync(best.path); } catch {} }
          best = { path: tmpImg, score };
        } else {
          try { fs.unlinkSync(tmpImg); } catch {}
        }
        if (score >= threshold) break;
        if (attempt < maxAttempts - 1) {
          log(runId, "info", `Beat ${beat.index}: Runware image scored ${score}% (<${threshold}) — regenerating ${attempt + 1}/${maxAttempts - 1}`, { stage: "visual" });
        }
      }
      if (best) {
        kenBurns(best.path, outPath, beatDurSec, beat.index % 2 === 1, resolution);
        try { fs.unlinkSync(best.path); } catch {}
        log(runId, "info", `Beat ${beat.index}: AI still via Runware + Ken Burns — match ${best.score}%`, { stage: "visual" });
        return { path: outPath, kind: "ai", provider: "runware" };
      }
      // Produced nothing — don't lose the beat; fall through to the Magnific fallback
      // and then the universal 69labs/Grok floor, exactly like a kie shortfall does.
      log(runId, "warn", `Beat ${beat.index}: Runware produced nothing after ${maxAttempts} attempts — falling back`, { stage: "visual" });
    }
  }

  const prompt = buildPrompt("");
  const dir = path.dirname(outPath);

  // 69labs branch. When 69labs is the CHOSEN AI provider, honor the AI-media mode
  // (image / video / auto) just like kie: image → a 69labs still + Ken Burns,
  // video → Grok text-to-video. (When we arrive here as a KIE fallback — kie
  // produced nothing — provider is still "kie", so we skip straight to the video
  // engine below as a last resort.)
  if (provider === "69labs") {
    const { media, reason } = resolveAiMedia(beat, mediaOverride);
    log(runId, "debug", `Beat ${beat.index}: AI media = ${media} (reason=${reason})`, { stage: "visual" });
    if (media === "image") {
      // 69labs still → score → regenerate if weak (mirrors the kie nano-banana path).
      let best: { path: string; score: number } | null = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const tmpImg = path.join(os.tmpdir(), `l69_${runId.slice(0, 8)}_${beat.index}_${attempt}.png`);
        try {
          await labs69Image(runId, buildPrompt(VARIANTS[attempt % VARIANTS.length]), tmpImg);
          // Cost Monitoring — every generated image is billed (incl. regens). This is a
          // STILL, so it bills at the image rate; it used to go through recordLabs69()
          // and be priced per VIDEO and labelled "videos".
          recordLabs69Image(runId);
        } catch (e) {
          log(runId, "debug", `Beat ${beat.index}: 69labs image gen failed (${(e as Error).message.slice(0, 80)})`, { stage: "visual" });
          noteCreditExhausted(runId, "69labs", (e as Error).message, "visual");
          if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        const score = maxAttempts === 1 ? 100 : await scoreLocalImage(runId, beat.index, gateQuery, beat.text, videoContext, tmpImg);
        if (!best || score > best.score) {
          if (best) { try { fs.unlinkSync(best.path); } catch {} }
          best = { path: tmpImg, score };
        } else {
          try { fs.unlinkSync(tmpImg); } catch {}
        }
        if (score >= threshold) break;
        if (attempt < maxAttempts - 1) {
          log(runId, "info", `Beat ${beat.index}: 69labs image scored ${score}% (<${threshold}) — regenerating ${attempt + 1}/${maxAttempts - 1}`, { stage: "visual" });
        }
      }
      if (best) {
        kenBurns(best.path, outPath, beatDurSec, beat.index % 2 === 1, resolution);
        try { fs.unlinkSync(best.path); } catch {}
        log(runId, "info", `Beat ${beat.index}: AI still via 69labs + Ken Burns — match ${best.score}%`, { stage: "visual" });
        return { path: outPath, kind: "ai", provider: "69labs:image" };
      }
      log(runId, "warn", `Beat ${beat.index}: 69labs image produced nothing after ${maxAttempts} attempts — falling back to 69labs video`, { stage: "visual" });
      // fall through to the Grok video engine below
    }
  }

  // Higgsfield fallback — when it's ENABLED but not the chosen provider, try it before
  // Magnific and the universal 69labs/Grok floor so a shortfall still gets another real AI
  // backend. No-op (byte-identical pipeline) when Higgsfield is disabled or unconfigured,
  // so it never changes behavior unless switched on.
  if (provider !== "higgsfield" && higgsfieldConfigured()) {
    log(runId, "info", `Beat ${beat.index}: ${provider} produced nothing — falling back to Higgsfield`, { stage: "visual" });
    const r = await tryHiggsfield();
    if (r) return r;
    log(runId, "warn", `Beat ${beat.index}: Higgsfield fallback produced nothing — trying Magnific / 69labs/Grok`, { stage: "visual" });
  }

  // Magnific fallback — when it's ENABLED but not the chosen provider, try it
  // before the universal 69labs/Grok floor so a kie/69labs shortfall still gets a
  // second real AI backend. No-op (byte-identical pipeline) when Magnific is
  // disabled or unconfigured, so it never changes behavior unless switched on.
  if (provider !== "magnific" && magnificConfigured()) {
    log(runId, "info", `Beat ${beat.index}: ${provider} produced nothing — falling back to Magnific`, { stage: "visual" });
    const r = await tryMagnific();
    if (r) return r;
    log(runId, "warn", `Beat ${beat.index}: Magnific fallback produced nothing — falling back to 69labs/Grok`, { stage: "visual" });
  }

  // AI-fallback "Images only" (mediaOverride === "image") means never an AI video — not even
  // as a last resort. Every image backend above (kie/69labs/Magnific, incl. the Magnific
  // fallback) produced nothing, and the universal 69labs/Grok floor below is text-to-VIDEO
  // (animateScene with a null keyframe). Reaching it would silently bill an expensive AI video
  // and break this setting's core promise ("Cheapest — never AI video"). Refuse and throw → the
  // pipeline reuses a neighbouring visual for this beat, exactly like the Veo "Videos only"
  // guard above. Normal AI mode and "both"/"video" fallback are unaffected: there mediaOverride
  // is undefined or "video", so this guard is skipped and the floor runs as before.
  if (mediaOverride === "image") {
    throw new Error(
      `AI fallback is "Images only" but no AI image could be generated for beat ${beat.index} — refusing to fall back to an AI video; the beat will reuse a neighbouring visual`
    );
  }

  // 69labs / Grok text-to-video (reuses the existing engine + retries).
  const pseudo: Scene = {
    index: beat.index,
    text: beat.text,
    visual_prompt: prompt,
    duration_hint_sec: Math.max(2, Math.round(beatDurSec)),
  };
  const generated = await animateScene(runId, pseudo, null, dir, { motionOverride: null });
  if (!generated) throw new Error(`AI generation produced no clip for beat ${beat.index}`);
  recordLabs69(runId); // Cost Monitoring — 69labs/Grok b-roll (rate TODO; unit logged)
  if (path.resolve(generated) !== path.resolve(outPath)) {
    fs.renameSync(generated, outPath);
  }
  return { path: outPath, kind: "ai", provider: "69labs" };
}

/**
 * Acquire the visual mp4 for one beat. Real beats try the configured providers,
 * then fall back to AI. AI beats go straight to generation.
 */
export async function acquireVisual(
  runId: string,
  beat: Beat,
  outPath: string,
  usedIds: Set<string>,
  opts: { aiStyle?: string; resolution?: string; videoContext?: string; topicPool?: TopicPool; strictReal?: boolean } = {}
): Promise<VisualResult> {
  // A cancelled run must not start ANY new per-beat work (not even a free stock
  // search or a billable AI generation). This runs when pLimit opens a slot for
  // this beat's thunk — i.e. after the user may have already cancelled.
  checkCancelled(runId);
  const beatDurSec = Math.max(0.8, (beat.endMs - beat.startMs) / 1000);
  // Real-footage-only: this beat must never reach acquireAi() below. The guarantee is
  // structural (control flow), NOT score-based — so it holds regardless of what any
  // relevance threshold is set to. Only ever true for real-sourced beats in "real"
  // visual mode; ai/mix beats are untouched.
  const strict = opts.strictReal === true && beat.source === "real";
  if (beat.source === "real") {
    // Stock-impossibility detector: skip real retrieval for queries stock libraries
    // can't satisfy (chemistry/process abstractions). Product/entity queries exempt.
    const stockQuery = visualPromptToQuery(beat.visualQuery || beat.text);
    const aiReason = getAiPreferenceReason(stockQuery, beat);
    if (aiReason && !strict) {
      log(runId, "debug", `Beat ${beat.index}: routing to AI (shouldPreferAi: keyword="${aiReason}")`, { stage: "visual" });
    } else {
      // Patch 2.4b — modality routing: ARCHIVAL beats try YouTube first (old
      // broadcast/newsreel footage stock lacks); contemporary/conceptual beats stay
      // Stock→AI even when they name a modern entity (the NVIDIA/Goldman fix). When the
      // planner emitted no footage_kind (undefined: 503/old beats), fall back to the
      // legacy entity proxy so behavior is byte-identical. Gated by YT_ROUTING (default off).
      const archival = beat.footageKind === "archival";
      const contemporary = beat.footageKind === "contemporary";
      const legacyEntity = beat.footageKind === undefined && beat.queryType === "entity";
      // Y1 — YT_PREFER widens YouTube-first onto contemporary beats (entity+generic);
      // conceptual is never footage_kind=contemporary so it stays AI. Archival/legacy
      // unchanged. Off by default → byte-identical to Patch A until the flag is set.
      const ytPrefer = getSetting("YT_PREFER") === "1";
      const youtubeFirst =
        getSetting("YT_ROUTING") === "1" && (archival || legacyEntity || (ytPrefer && contemporary));
      if (youtubeFirst) {
        const why = archival ? "footage_kind=archival" : contemporary ? "footage_kind=contemporary (YT_PREFER)" : "legacy entity proxy";
        log(runId, "debug", `Beat ${beat.index}: YouTube-first (${why})`, { stage: "visual" });
      }
      const real = await acquireReal(runId, beat, beatDurSec, outPath, usedIds, opts.resolution, opts.videoContext, youtubeFirst, opts.topicPool, strict);
      if (real) return real;
      // Reason (poolIsWeak / exhausted-after-3-attempts) is logged inside acquireReal.
    }
  }

  // Real-footage-only: acquireReal exhausted every strategy AND found zero candidates
  // (an empty pool every attempt — not "scored too low"; a low score would already have
  // been accepted). That means no real media was REACHABLE: providers erroring or
  // rate-limited, or REAL_MEDIA=image/video filtering the pool to nothing. Broadening
  // cannot fix either, so retrying forever would hang the run while holding a pLimit
  // slot. Rate limits are usually transient → wait once, re-run the whole ladder, then
  // give up WITHOUT generating AI: throwing hands the beat to the pipeline's existing
  // neighbour-reuse (studio-pipeline "No black screens"), which in this mode carries
  // over real footage.
  if (strict) {
    log(runId, "warn", `Beat ${beat.index}: no real media found — waiting ${Math.round(STRICT_RETRY_DELAY_MS / 1000)}s and retrying (Real-footage-only, never AI)`, { stage: "visual" });
    await new Promise((r) => setTimeout(r, STRICT_RETRY_DELAY_MS));
    checkCancelled(runId); // the wait may have spanned a cancellation
    const stockQuery = visualPromptToQuery(beat.visualQuery || beat.text);
    const retry = await acquireReal(runId, beat, beatDurSec, outPath, usedIds, opts.resolution, opts.videoContext, false, opts.topicPool, true);
    if (retry) return retry;
    throw new Error(
      `Real-footage-only: no real media reachable for beat ${beat.index} ("${stockQuery}") after retry — refusing to generate AI; the beat will reuse a neighbouring real visual`
    );
  }

  // AI FALLBACK media gate. We only reach here for a real-sourced beat when real footage
  // could not be found (acquireReal returned null, or the stock-impossibility detector
  // routed it to AI) — i.e. THIS is the fallback the operator wants to constrain. A
  // planned-AI beat (beat.source === "ai") also lands here, and must NOT be constrained:
  // that is normal AI mode. So the override is keyed strictly on beat.source.
  const mediaOverride = beat.source === "real" ? fallbackAiMedia() : undefined;
  return acquireAi(runId, beat, beatDurSec, outPath, opts.aiStyle, opts.resolution, opts.videoContext, mediaOverride);
}

/**
 * The media an AI *fallback* may generate, from FALLBACK_AI_MEDIA:
 *   "image" (default, cheapest) → never an AI video on the fallback path
 *   "video"                     → AI video only
 *   "both"                      → today's un-gated behaviour (returns undefined = no constraint)
 * Anything unset/unrecognized is treated as "image" — the safe, cheap direction, since the
 * whole point of this setting is to stop fallback silently running up AI-video cost.
 */
function fallbackAiMedia(): "image" | "video" | undefined {
  const v = (getSetting("FALLBACK_AI_MEDIA") || "image").toLowerCase();
  if (v === "both") return undefined;
  if (v === "video") return "video";
  return "image";
}

/**
 * Internals exposed for unit tests only — the wigolo adapter's response mapping and failure
 * modes, plus both provider-weight tables so a test can pin that no source silently ranks
 * itself above the others by being absent from them.
 *
 * Must stay at the END of the module: it reads consts declared far below wigoloSearch, and
 * a `const` object literal placed next to that function would evaluate before they exist.
 */
export const __testing = {
  wigoloSearch,
  gatherCandidates,
  PROVIDER_WEIGHT,
  PREFILTER_PROVIDER_WEIGHT,
  PROVIDERS,
  // The route-to-AI gate, exposed so the bake-off can COUNT how often it would fire rather
  // than reimplement its rule and drift from it.
  poolIsWeak,
  weakPoolVerdict,
  scoreLocalImage,
  hasLikelyEntity,
  entityProtected,
  // Selection internals — same contract as poolIsWeak above: the off-line metrics harness
  // (scripts/pool-metrics.ts) must run the REAL cut, the REAL ranking and the REAL slot
  // allocation, never a paraphrase of them that can drift as these are tuned.
  mergePools,
  prefilterCandidates,
  reserveCandidates,
  heuristicScore,
  fallbackSemanticScore,
  shouldBypassGemini,
  rankKey,
  SOURCE_POOL_PER_PROVIDER,
  SOURCE_POOL_MAX,
  MAX_GEMINI_CANDIDATES,
  VIDEO_MATCH_THRESHOLD,
  IMAGE_MATCH_THRESHOLD,
};

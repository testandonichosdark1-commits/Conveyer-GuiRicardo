import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { pLimit } from "../plimit";
import { resolveFfmpeg } from "../ffmpeg-bin";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import { kenBurns } from "./ken-burns";
import { animateScene } from "./img2vid";
import { labs69Image } from "./image-gen";
import { generateImageUrl, generateVideoUrl, downloadKie } from "./kie";
import { generateMagnificImageUrl, generateMagnificVideoUrl, downloadMagnific, magnificConfigured } from "./magnific";
import { recordGemini, recordKieImage, recordKieVeo, recordLabs69, recordMagnificImage, recordMagnificVideo } from "./cost-ledger";
import { callGemini } from "./gemini-models";
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
  attribution?: { author?: string | null; sourceUrl?: string; license?: string | null };
  /** Diagnostics only (YT_DEBUG) — populated by downloadYouTube; never affects behavior. */
  ytDebug?: { id: string; title?: string; durationSec?: number; segStart: number; segEnd: number };
}

type ProviderKind = "video" | "image";
interface ProviderHit {
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
  web: (q) => googleCseSearch(q),
};

/** Valid real-footage provider keys (excludes "youtube", which is handled
 * separately and is never part of a provider list). Exported so callers that
 * validate a per-channel footage_source_tiers config (studio-pipeline.ts)
 * share this single allow-list instead of duplicating it. */
export const FOOTAGE_PROVIDER_KEYS: readonly string[] = Object.keys(PROVIDERS);

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
async function googleCseSearch(query: string): Promise<ProviderHit[]> {
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
 * NOTHING calls this yet; it is added ahead of the Step 2 downloadYouTube conversion so
 * it can be reviewed and `tsc`/build-verified in isolation.
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
  timeout?: number;
  maxBuffer?: number;
  killSignal?: NodeJS.Signals;
  stdio?: "pipe" | "ignore";
  cwd?: string;
}
function runAsync(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { encoding, timeout, maxBuffer = 1024 * 1024, killSignal = "SIGTERM", stdio, cwd } = opts;
  const empty = (): string | Buffer => (encoding ? "" : Buffer.alloc(0));
  return new Promise<RunResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { stdio: stdio === "ignore" ? "ignore" : "pipe", cwd });
    } catch (err) {
      resolve({ status: null, signal: null, stdout: empty(), stderr: empty(), error: err as Error });
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;
    let timedOut = false;
    let bufferError: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let escalating = false;

    // Phase 3 (Step 2) — TERM→KILL escalation. Send killSignal (default SIGTERM) once,
    // then, if the child ignores it and never emits "close", force an uncatchable SIGKILL
    // after a short grace. SIGKILL guarantees the OS reaps the child → "close" fires →
    // finish() runs → the promise ALWAYS settles, so a stuck download can never silently
    // leak a YT_DOWNLOAD_CONCURRENCY slot. Idempotent: re-entry (repeated over-buffer data
    // events) re-sends the term signal harmlessly but arms the kill timer only once.
    const KILL_GRACE_MS = 5000;
    const terminate = () => {
      try { child.kill(killSignal); } catch {}
      if (escalating) return;
      escalating = true;
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, KILL_GRACE_MS);
    };

    const finish = (status: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const out = Buffer.concat(outChunks, outLen);
      const err = Buffer.concat(errChunks, errLen);
      const timeoutErr = timedOut ? Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) : undefined;
      resolve({
        status,
        signal,
        stdout: encoding ? out.toString(encoding) : out,
        stderr: encoding ? err.toString(encoding) : err,
        error: error ?? timeoutErr ?? bufferError,
      });
    };

    child.stdout?.on("data", (d: Buffer) => {
      outChunks.push(d);
      outLen += d.length;
      if (outLen > maxBuffer) {
        bufferError = Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ENOBUFS" });
        terminate();
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      errChunks.push(d);
      errLen += d.length;
      if (errLen > maxBuffer) {
        bufferError = Object.assign(new Error("stderr maxBuffer length exceeded"), { code: "ENOBUFS" });
        terminate();
      }
    });

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeout);
    }

    child.on("error", (err) => finish(null, null, err));
    child.on("close", (code, signal) => finish(code, signal));
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
        "-o", outPath,
        `https://www.youtube.com/watch?v=${c.id}`,
      ],
      { encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 }
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
 */
function broadenQuery(query: string, level: number): string {
  if (level <= 0) return query;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return query;

  const isGeneric = (t: string) => GENERIC_DESCRIPTORS.has(t.toLowerCase());

  // 1. Protected entity = leading run of non-generic tokens (no caps dependency).
  let entityEnd = 0;
  while (entityEnd < tokens.length && !isGeneric(tokens[entityEnd])) entityEnd++;
  const entity = tokens.slice(0, entityEnd);

  // 2. Remaining meaningful (non-generic) words, in source order.
  const meaningful = tokens.slice(entityEnd).filter((w) => !isGeneric(w));

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
  usedIds: ReadonlySet<string>,
  providerNames?: string[]
): Promise<ProviderHit[]> {
  const names = (providerNames ?? configuredProviders()).filter((n) => n !== "youtube" && PROVIDERS[n]);
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
  const seen = new Set<string>();
  const pool: ProviderHit[] = [];
  // Round-robin across providers so the pool isn't dominated by one source.
  for (let i = 0; i < SOURCE_POOL_PER_PROVIDER; i++) {
    for (const list of lists) {
      const h = list[i];
      if (!h || usedIds.has(h.dedupeId) || seen.has(h.dedupeId)) continue;
      seen.add(h.dedupeId);
      pool.push(h);
      if (pool.length >= SOURCE_POOL_MAX) return pool;
    }
  }
  return pool;
}

/** Fetch a candidate's preview as base64 for the vision scorer (small images only). */
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
    return { mime, data: buf.toString("base64") };
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
const PROVIDER_WEIGHT: Record<string, number> = {
  pexels: 4,
  pixabay: 2,
  youtube: 1,
  wikimedia: -1,
  openverse: -2,
  web: -3,
  archive: -4,
};
/** Ranking score = raw semantic score + provider weight + video bonus. */
function rankKey(s: { hit: ProviderHit; score: number }): number {
  return s.score + (PROVIDER_WEIGHT[s.hit.provider ?? ""] ?? 0) + (s.hit.kind === "video" ? VIDEO_BONUS : 0);
}

// ── Gemini load reduction (Phase 1) ───────────────────────────────────────
// Only the strongest few candidates reach the heavy multimodal scoring call.
const MAX_GEMINI_CANDIDATES = 10;
const PREFILTER_PROVIDER_WEIGHT: Record<string, number> = {
  pexels: 4,
  pixabay: 2,
  youtube: 1,
  wikimedia: -1,
  openverse: -2,
  web: -3,
  archive: -4,
};
/**
 * Cheap heuristic prefilter applied BEFORE the Gemini vision call: rank by
 * provider weight + video bonus + thumbnail bonus and keep only the top
 * MAX_GEMINI_CANDIDATES, so weak archive/web/no-thumbnail candidates don't burn
 * image tokens. The semantic scoring + rankKey() ordering afterwards is unchanged.
 */
function prefilterCandidates(pool: ProviderHit[], runId: string, beatIndex: number): ProviderHit[] {
  if (pool.length <= MAX_GEMINI_CANDIDATES) return pool;
  const heuristic = (h: ProviderHit) =>
    (PREFILTER_PROVIDER_WEIGHT[h.provider ?? ""] ?? 0) +
    (h.kind === "video" ? 4 : 0) +
    (h.thumbUrl ? 1 : 0);
  const filtered = [...pool].sort((a, b) => heuristic(b) - heuristic(a)).slice(0, MAX_GEMINI_CANDIDATES);
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
 * Lightweight lexical-similarity score, used ONLY when Gemini scoring is
 * unavailable (no key / 503 / invalid response). It measures query→candidate
 * token overlap against the candidate's available metadata (its slug-derived
 * label + author — ProviderHit carries no description/tags), then adds the same
 * provider/video preference, an entity-phrase boost, and a zero-overlap penalty.
 * Final score = overlap*100 + provider_weight + video_bonus (+20 / -30).
 */
function fallbackSemanticScore(query: string, h: ProviderHit): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean);
  const qTokens = norm(query).filter((t) => !IMG_STOPWORDS.has(t));
  const provVid = (PREFILTER_PROVIDER_WEIGHT[h.provider ?? ""] ?? 0) + (h.kind === "video" ? 4 : 0);
  if (qTokens.length === 0) return provVid; // no lexical signal → provider/kind only

  const candWords = norm(`${hitLabel(h)} ${h.author ?? ""}`);
  const candSet = new Set(candWords);
  const candStr = candWords.join(" ");

  let matched = 0;
  for (const t of qTokens) if (candSet.has(t)) matched++;
  const overlap = matched / qTokens.length; // 0..1

  let score = overlap * 100 + provVid;

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
 * Returns the chemistry/process KEYWORD that makes a query stock-unfriendly
 * (→ prefer AI), or null. Short but stock-searchable queries ("sunrise",
 * "detergent bottle", "laundry room") return null. Strong product/entity queries
 * (Tide, Walmart, Arm & Hammer) are EXEMPT (null). The keyword is surfaced so the
 * caller can log WHY a beat was routed to AI.
 */
function getAiPreferenceReason(query: string): string | null {
  if (!query.trim()) return null;
  if (hasLikelyEntity(query)) return null; // protect product/entity queries
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
function resolveAiMedia(beat: Beat): { media: "image" | "video"; reason: string } {
  const mode = (getSetting("KIE_AI_MEDIA") || "image").toLowerCase();
  if (mode === "image" || mode === "video") return { media: mode, reason: `global:${mode}` };
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
): Promise<{ hit: ProviderHit; score: number; fallback?: boolean }[]> {
  if (pool.length === 0) return [];
  const threshold = Math.max(0, Math.min(100, Number(getSetting("REAL_MATCH_THRESHOLD") || "85")));
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (threshold <= 0) return pool.map((h) => ({ hit: h, score: threshold })); // scoring intentionally off → accept, rankKey() orders
  if (!apiKey) {
    log(runId, "debug", `Beat ${beatIndex}: no Gemini key — lexical fallback scoring`, { stage: "visual" });
    return pool.map((h) => ({ hit: h, score: fallbackSemanticScore(sceneQuery, h), fallback: true }));
  }

  // Prefilter to the strongest few BEFORE the heavy multimodal call (Gemini load reduction).
  pool = prefilterCandidates(pool, runId, beatIndex);

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
  // Shared resilience layer (gemini-models.ts): 3 attempts with the original 1.5s/3s backoff,
  // now failing over across live models. gemini-2.5-flash intermittently returns an EMPTY/
  // truncated body (finishReason MAX_TOKENS) → `validate` meters cost then throws so that blip
  // is a TRANSIENT retry, exactly as before (billed MAX_TOKENS attempts still count).
  try {
    const { json: j } = await callGemini({
      apiKey,
      model,
      body,
      maxAttempts: 3,
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
        if (nextModel) log(runId, "debug", `Beat ${beatIndex}: scoring failed (${reason.slice(0, 80)}) — retrying`, { stage: "visual" });
      },
    });
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text) as { i: number; score: number }[];
    const scored = arr
      .map((x) => ({ hit: pool[Number(x.i)], score: Number(x.score) }))
      .filter((x) => x.hit && Number.isFinite(x.score))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const withThumbs = thumbs.filter(Boolean).length;
    log(runId, "debug", `Beat ${beatIndex}: scored ${pool.length} candidates (${withThumbs} with image) — best ${best ? best.score : "n/a"}/${threshold} (${best ? best.hit.provider : "—"})`, { stage: "visual" });
    return scored.length ? scored : pool.map((h) => ({ hit: h, score: 0 }));
  } catch (e) {
    log(runId, "warn", `Beat ${beatIndex}: scoring failed after 3 attempts (${(e as Error).message.slice(0, 80)}) — lexical fallback scoring`, { stage: "visual" });
    return pool.map((h) => ({ hit: h, score: fallbackSemanticScore(sceneQuery, h), fallback: true })); // fail-open, non-blocking: lexical relevance instead of arbitrary acceptance
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
  try {
    const model = getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL");
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: instr }, { inline_data: { mime_type: mime, data } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } },
    });
    // Shared resilience layer (gemini-models.ts): one attempt + one immediate failover to a live
    // model (no backoff — this is a per-frame best-effort gate). Fails open to "none" below.
    const { json: j, model: usedModel } = await callGemini({ apiKey, model, body, maxAttempts: 2, backoffMs: () => 0 });
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
  // shared resilience layer (gemini-models.ts) retries TRANSIENT failures only (5xx / 429 /
  // 20s timeout / network), now failing over across live models, with the original jittered
  // backoff (~1s, ~2.5s) that de-syncs concurrent beats. Permanent errors (4xx) and bad JSON
  // fail open immediately (return null → caller keeps the original order). YT_RERANK_RETRIES=0
  // reproduces today's single-shot exactly.
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
      maxAttempts: retries + 1,
      timeoutMs: 20_000,
      // Non-blocking jittered backoff (jitter de-syncs concurrent beats): ~1s, then ~2.5s.
      backoffMs: (n) => (n === 1 ? 1000 : 2500) + Math.floor(Math.random() * 300),
      onFailure: ({ reason, nextModel }) => {
        if (nextModel) log(runId, "debug", `Beat ${beat.index}: title-rerank ${reason.slice(0, 40)} — retry with ${nextModel}`, { stage: "visual" });
      },
    });
    // Cost Monitoring — title-rerank is a Gemini text call (billed only on a successful call).
    recordGemini(runId, "geminiText", j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0, usedModel);
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
type RealSearchDiag = { bestSeen: { score: number; provider: string } | null; lastSearchQuery: string };

/**
 * One tier's worth of the broaden/gather/score attempt-loop, scoped to
 * `providerNames`. Extracted out of `acquireReal` so per-channel source
 * tiering (below) can call this once per tier without duplicating the
 * delicate scoring/dedup/early-exit logic. `diag` is mutated in place so
 * `acquireReal`'s final "exhausted" log still reports the single best
 * candidate seen across every tier, not just the last one tried.
 */
async function acquireRealOneTier(
  runId: string,
  beat: Beat,
  beatDurSec: number,
  outPath: string,
  usedIds: Set<string>,
  resolution: string | undefined,
  videoContext: string | undefined,
  query: string,
  baseQuery: string,
  topicActive: boolean,
  topicKey: string | undefined,
  topicPool: TopicPool | undefined,
  providerNames: string[],
  tierIndex: number,
  threshold: number,
  diag: RealSearchDiag
): Promise<VisualResult | null> {
  // Patch 2.2 — retry-degeneracy guards. broadenQuery() is a no-op for short/
  // entity-only queries (e.g. "AI chips"), so retries re-fetch the SAME deterministic
  // provider pool and re-run the heavy vision scorer to the same failing verdict.
  // triedQueries skips an identical broadened query before any fetch; scoredPools
  // skips scoreAndPick when a later (different) query yields a provably-identical pool.
  // Scoped PER TIER (fresh Sets on every call) — a new tier is a genuinely different
  // provider pool for the same broadened query, so it's never a redundant re-fetch.
  const triedQueries = new Set<string>();
  const scoredPools = new Set<string>();

  for (let attempt = 0; attempt < 3; attempt++) {
    const searchQuery = broadenQuery(baseQuery, attempt);
    diag.lastSearchQuery = searchQuery;
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
    // Cache key is namespaced by tierIndex so a tier-2 gather never reuses tier-1's
    // cached pool for the same topicKey/attempt (they query different providers).
    let pool: ProviderHit[];
    if (topicActive && topicKey) {
      const ck = `${topicKey}|${tierIndex}|${attempt}`;
      let p = topicPool!.pools.get(ck);
      if (!p) {
        p = gatherCandidates(runId, searchQuery, beatDurSec, NO_USED_FILTER, providerNames);
        topicPool!.pools.set(ck, p);
        log(runId, "debug", `Beat ${beat.index}: topic pool MISS "${topicKey}" tier ${tierIndex} attempt ${attempt} — gathering "${searchQuery}"`, { stage: "visual" });
      } else {
        log(runId, "debug", `Beat ${beat.index}: topic pool HIT "${topicKey}" tier ${tierIndex} attempt ${attempt} — reusing shared gather`, { stage: "visual" });
      }
      pool = (await p).filter((h) => !usedIds.has(h.dedupeId));
    } else {
      pool = await gatherCandidates(runId, searchQuery, beatDurSec, usedIds, providerNames);
    }
    if (pool.length === 0) continue;

    // Stock-impossibility (condition 3): a weak first-gather pool (no video, only
    // low-tier image providers) for a non-entity query → give up on THIS TIER now
    // (the outer tier loop in acquireReal advances to the next tier, if any).
    if (attempt === 0 && !hasLikelyEntity(query) && poolIsWeak(pool)) {
      log(runId, "debug", `Beat ${beat.index}: tier ${tierIndex} weak (poolIsWeak: ${explainWeakPool(pool)})`, { stage: "visual" });
      return null;
    }

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

    const scored = await scoreAndPick(runId, beat.index, query, beat.text, videoContext, pool);
    for (const s of scored) if (!diag.bestSeen || s.score > diag.bestSeen.score) diag.bestSeen = { score: s.score, provider: s.hit.provider ?? "?" };
    // Try EVERY candidate that clears the bar, best first. A download failure
    // (e.g. Wikimedia 429 rate-limit) used to discard a 95% match and fall
    // straight to AI — now it just moves to the next passing candidate.
    // Kind-specific acceptance bars. Gemini-success path: video >= 75, image >= 85.
    // Lexical-fallback path (Gemini unavailable) is UNCHANGED: video >= 65, image >= 80.
    const passing = scored
      .filter((c) =>
        c.fallback
          ? (c.hit.kind === "video" ? c.score >= 65 : c.score >= 80)
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
  return null;
}

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
  sourceTiers?: string[][]
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
  // Diagnostics only — track the best candidate seen (across every tier) + the
  // last query tried so the exhaustion log can explain WHY the beat fell to AI.
  // No effect on control flow.
  const diag: RealSearchDiag = { bestSeen: null, lastSearchQuery: query };

  // YouTube-first (entity beats, YT_ROUTING=1): try real MOVING footage before
  // stock — YouTube's specificity beats stock for named places/people/events.
  // A miss falls through to the stock loop (no beat lost); reused as-is.
  if (youtubeFirst) {
    log(runId, "debug", `Beat ${beat.index}: entity → YouTube-first`, { stage: "visual" });
    const ytFirst = await youtubeScoredFallback(runId, beat, query, beatDurSec, outPath, usedIds, videoContext);
    if (ytFirst) return ytFirst;
  }

  // Per-channel b-roll source priority (Channel.footage_source_tiers): try each
  // tier of providers in order, exhausting the same broaden/score loop within a
  // tier (via acquireRealOneTier) before moving to the next tier. Unset/empty →
  // single implicit tier = the global FOOTAGE_SOURCES list, which collapses this
  // loop to exactly one iteration — byte-identical to the pre-tiering behavior.
  const tiers = sourceTiers && sourceTiers.length > 0 ? sourceTiers : [configuredProviders()];
  for (let t = 0; t < tiers.length; t++) {
    if (tiers.length > 1) {
      log(runId, "debug", `Beat ${beat.index}: b-roll tier ${t + 1}/${tiers.length} (${tiers[t].join(",")})`, { stage: "visual" });
    }
    const res = await acquireRealOneTier(
      runId, beat, beatDurSec, outPath, usedIds, resolution, videoContext,
      query, baseQuery, topicActive, topicKey, topicPool, tiers[t], t, threshold, diag
    );
    if (res) return res;
  }

  // YouTube clip fallback (opt-in) — real MOVING footage when stock/web stills
  // didn't clear the bar, BEFORE giving up to AI. The clip's own frame is scored
  // by the same vision pass (relevance + reject on-screen text), so a clip is
  // only used if it actually matches and is clean.
  // Patch A — runs for any beat that did NOT already try YouTube-first: archival
  // (youtubeFirst) already probed YouTube and is excluded here; contemporary beats
  // now get the stock → YouTube → AI fallback that YT_ROUTING=1 had removed. Legacy
  // (YT_ROUTING=0, youtubeFirst always false) keeps the end-fallback for all — unchanged.
  if (!youtubeFirst) {
    const yt = await youtubeScoredFallback(runId, beat, query, beatDurSec, outPath, usedIds, videoContext);
    if (yt) return yt;
  }

  const attemptsDesc = tiers.length > 1 ? `${tiers.length} tiers × 3 attempts` : "3 attempts";
  log(runId, "warn", `Beat ${beat.index}: real retrieval exhausted after ${attemptsDesc} — routing to AI (bestScore=${diag.bestSeen ? diag.bestSeen.score : "n/a"}, bestProvider=${diag.bestSeen ? diag.bestSeen.provider : "—"}, finalQuery="${diag.lastSearchQuery}")`, { stage: "visual" });
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
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) return 100; // can't judge → accept
  let data: string;
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.byteLength === 0 || buf.byteLength > 6 * 1024 * 1024) return 100; // too big to send → accept
    data = buf.toString("base64");
  } catch {
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
  try {
    const model = getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL");
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: instr }, { inline_data: { mime_type: mime, data } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } },
    });
    // Shared resilience layer (gemini-models.ts): one attempt + one immediate failover to a live
    // model (no backoff — this is the per-frame heavy path). Fails open to score 100 below.
    const { json: j, model: usedModel } = await callGemini({ apiKey, model, body, maxAttempts: 2, backoffMs: () => 0 });
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
  } catch {
    return 100; // fail-open
  }
}

/** AI b-roll for a beat — kie.ai (nano-banana image + Ken Burns, or Veo video) or 69labs/Grok. */
async function acquireAi(
  runId: string,
  beat: Beat,
  beatDurSec: number,
  outPath: string,
  aiStyle?: string,
  resolution?: string,
  videoContext?: string
): Promise<VisualResult> {
  const provider = (getSetting("AI_PROVIDER") || "kie").toLowerCase();
  const style = (aiStyle ?? getSetting("AI_IMAGE_STYLE")) || "";
  // Hard ban on baked-in text — nano-banana/Veo love to render the prompt (or the
  // narration) onto cards, boxes and signs. Also blank/unlabeled packaging so it
  // doesn't invent fake brand labels.
  const noText =
    "absolutely no text, no captions, no words, no letters, no numbers, no labels, no brand names, no logos, " +
    "no signs, no posters, no handwriting, no writing on any object, blank unlabeled plain packaging, no watermark";
  // Anchor the generation to the WHOLE video's topic, not just this sentence —
  // an abstract per-scene prompt was producing off-topic art (e.g. a fantasy
  // mage for a laundry-detergent video). Plus hard quality + realism negatives.
  const topic = (videoContext || "").trim().slice(0, 160);
  const contextAnchor = topic ? `in a documentary about: ${topic}` : "";
  const realism =
    "photorealistic, real-world, high quality, sharp focus, high resolution, natural lighting, documentary photography. " +
    "NOT fantasy, NOT sci-fi, NOT surreal, NOT abstract, NOT digital art, NOT illustration, NOT 3D render, no glowing magic, no neon";
  // Prefer the rich Gemini-written generation prompt; fall back to the short stock
  // query, then to KEYWORDS of the narration — never the raw sentence (it gets
  // rendered as on-screen text).
  const base = beat.aiPrompt || beat.visualQuery || keywordsOnly(beat.text);
  const VARIANTS = ["", "alternative composition, different camera angle", "another realistic shot, cleaner simple framing", "wider establishing shot", "tighter close-up detail"];
  const buildPrompt = (v: string) => [base, contextAnchor, style, realism, noText, v].filter(Boolean).join(", ");
  const aspect = aiAspect(resolution);
  const gateQuery = visualPromptToQuery(beat.visualQuery || beat.text) || base;
  // AI images typically score 68–78; gate AI on its OWN (lower) threshold so the
  // regen loop early-exits instead of always running maxAttempts. Final best-of-N
  // selection is unchanged — only the early-exit bar moves.
  const threshold = Math.max(0, Math.min(100, Number(getSetting("AI_MATCH_THRESHOLD") || getSetting("REAL_MATCH_THRESHOLD") || "75")));
  // Regenerate until the image clears the threshold, capped so an impossible
  // scene can't loop forever (then the best of the attempts is kept).
  const maxAttempts = Math.max(1, Math.min(8, Number(getSetting("AI_REGEN_ATTEMPTS") || "5")));

  // Magnific AI — one more AI b-roll backend (Mystic images + Ken Burns, or Hailuo
  // video). Used both as the CHOSEN provider (AI_PROVIDER=magnific) and, when
  // enabled, as a fallback for the other engines. Mirrors the kie branch exactly:
  // honors the image/video/auto media mode and runs the same scoring/regen loop.
  // Returns null if it produced nothing (caller falls through); never throws.
  const tryMagnific = async (): Promise<VisualResult | null> => {
    const { media, reason } = resolveAiMedia(beat);
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

  if (provider === "kie") {
    const { media, reason } = resolveAiMedia(beat);
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
        log(runId, "warn", `Beat ${beat.index}: AI video (Veo) failed (${(e as Error).message.slice(0, 160)}) — falling back to AI image`, { stage: "visual" });
        // fall through to the nano-banana image branch (no rethrow, no return)
      }
    }
    // nano-banana image → score against the scene/context → regenerate if weak.
    // The SAME REAL_MATCH_THRESHOLD that gates real footage also gates AI here.
    let best: { path: string; score: number } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const tmpImg = path.join(os.tmpdir(), `kie_${runId.slice(0, 8)}_${beat.index}_${attempt}.png`);
      try {
        const url = await generateImageUrl(runId, buildPrompt(VARIANTS[attempt % VARIANTS.length]), aspect);
        await downloadKie(url, tmpImg);
        recordKieImage(runId); // Cost Monitoring — every generated image is billed (incl. regens)
      } catch (e) {
        log(runId, "debug", `Beat ${beat.index}: AI image gen failed (${(e as Error).message.slice(0, 80)})`, { stage: "visual" });
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
    // WI-6 — kie.ai produced nothing (e.g. sustained "internal error"); don't lose the beat —
    // fall through to the 69labs/Grok engine below before giving up (throws only if THAT fails too).
    log(runId, "warn", `Beat ${beat.index}: kie.ai produced nothing after ${maxAttempts} attempts — falling back to 69labs/Grok`, { stage: "visual" });
  }
  const prompt = buildPrompt("");
  const dir = path.dirname(outPath);

  // 69labs branch. When 69labs is the CHOSEN AI provider, honor the AI-media mode
  // (image / video / auto) just like kie: image → a 69labs still + Ken Burns,
  // video → Grok text-to-video. (When we arrive here as a KIE fallback — kie
  // produced nothing — provider is still "kie", so we skip straight to the video
  // engine below as a last resort.)
  if (provider === "69labs") {
    const { media, reason } = resolveAiMedia(beat);
    log(runId, "debug", `Beat ${beat.index}: AI media = ${media} (reason=${reason})`, { stage: "visual" });
    if (media === "image") {
      // 69labs still → score → regenerate if weak (mirrors the kie nano-banana path).
      let best: { path: string; score: number } | null = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const tmpImg = path.join(os.tmpdir(), `l69_${runId.slice(0, 8)}_${beat.index}_${attempt}.png`);
        try {
          await labs69Image(runId, buildPrompt(VARIANTS[attempt % VARIANTS.length]), tmpImg);
          recordLabs69(runId); // Cost Monitoring — every generated image is billed (incl. regens)
        } catch (e) {
          log(runId, "debug", `Beat ${beat.index}: 69labs image gen failed (${(e as Error).message.slice(0, 80)})`, { stage: "visual" });
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
  opts: { aiStyle?: string; resolution?: string; videoContext?: string; topicPool?: TopicPool; sourceTiers?: string[][] } = {}
): Promise<VisualResult> {
  // A cancelled run must not start ANY new per-beat work (not even a free stock
  // search or a billable AI generation). This runs when pLimit opens a slot for
  // this beat's thunk — i.e. after the user may have already cancelled.
  checkCancelled(runId);
  const beatDurSec = Math.max(0.8, (beat.endMs - beat.startMs) / 1000);
  if (beat.source === "real") {
    // Stock-impossibility detector: skip real retrieval for queries stock libraries
    // can't satisfy (chemistry/process abstractions). Product/entity queries exempt.
    const stockQuery = visualPromptToQuery(beat.visualQuery || beat.text);
    const aiReason = getAiPreferenceReason(stockQuery);
    if (aiReason) {
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
      const real = await acquireReal(runId, beat, beatDurSec, outPath, usedIds, opts.resolution, opts.videoContext, youtubeFirst, opts.topicPool, opts.sourceTiers);
      if (real) return real;
      // Reason (poolIsWeak / exhausted-after-3-attempts) is logged inside acquireReal.
    }
  }
  return acquireAi(runId, beat, beatDurSec, outPath, opts.aiStyle, opts.resolution, opts.videoContext);
}

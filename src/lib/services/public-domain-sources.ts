/**
 * Footage sources whose results are PUBLIC DOMAIN or CC0 — usable on a monetized channel with
 * no licence, no attribution requirement and no copyright-claim risk. Every function filters
 * on the item's own rights field; anything not explicitly public domain / CC0 / "no known
 * copyright restrictions" is dropped, never passed on "probably fine".
 *
 *   nasa        — NASA Image and Video Library. US-government works. No key. Videos + photos.
 *   smithsonian — Smithsonian Open Access, CC0 media only. Free api.data.gov key.
 *   europeana   — European museums/archives, PD Mark + CC0 only. Free key. Photos + newsreel mp4s.
 *   flickr      — Flickr, licences 7/9/10 only (Commons "no known restrictions", CC0, PD Mark). Free key.
 *   dvids       — US Defense Visual Information Distribution Service (US-government works). Free key.
 *
 * A keyed source with no key returns [] — same contract as Pixabay. Contracts were probed live
 * on 2026-11-17 for NASA, Smithsonian (DEMO_KEY) and Europeana (public demo key); Flickr and
 * DVIDS are written from their documented API and have NOT been called with a real key yet.
 */
import { getSetting } from "../settings";
import type { ProviderHit } from "./visual-source";

const UA = "FacelessVideoGenerator/0.1 (local video tool)";

function clean(...fields: (string | null | undefined)[]): string | undefined {
  const parts = fields
    .map((f) => (f ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const text = parts.join(" · ").slice(0, 300);
  return text || undefined;
}

async function getJson<T>(url: URL | string, what: string, headers: Record<string, string> = {}): Promise<T> {
  const resp = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`${what} ${resp.status}`);
  return (await resp.json()) as T;
}

/* ── NASA ─────────────────────────────────────────────────────────────────── */

/** NASA videos longer than this are mostly briefings and webcasts, not b-roll. */
const NASA_MAX_VIDEO_SEC = 240;

function hmsToSec(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d+):(\d{2}):(\d{2})/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  const s = v.match(/^([\d.]+)\s*s$/);
  return s ? Number(s[1]) : null;
}

export async function nasaSearch(query: string): Promise<ProviderHit[]> {
  const search = (media: "image" | "video", size: number) => {
    const url = new URL("https://images-api.nasa.gov/search");
    url.searchParams.set("q", query.slice(0, 120));
    url.searchParams.set("media_type", media);
    url.searchParams.set("page_size", String(size));
    return url;
  };
  type Item = {
    href?: string;
    data?: { nasa_id?: string; media_type?: string; title?: string; description?: string; date_created?: string }[];
    links?: { href?: string; rel?: string; render?: string; width?: number }[];
  };
  // Separate requests: a mixed search is dominated by photos, and the few videos in it are
  // mostly hour-long webcasts that the duration filter below throws away.
  const [imgData, vidData] = await Promise.all([
    getJson<{ collection?: { items?: Item[] } }>(search("image", 8), "NASA"),
    getJson<{ collection?: { items?: Item[] } }>(search("video", 10), "NASA").catch(() => ({ collection: { items: [] as Item[] } })),
  ]);
  const hits: ProviderHit[] = [];
  const videos = vidData.collection?.items ?? [];
  const images = imgData.collection?.items ?? [];

  for (const it of images) {
    const d = it.data![0];
    const links = it.links ?? [];
    const big = links.find((l) => /~large\.jpg$/i.test(l.href ?? "")) ?? links.find((l) => /~orig\.jpg$/i.test(l.href ?? ""));
    const thumb = links.find((l) => l.rel === "preview")?.href ?? links[0]?.href;
    // The ~large rendition is listed only sometimes; the original is always at a fixed path.
    const id = d.nasa_id;
    if (!id) continue;
    const full = big?.href ?? `https://images-assets.nasa.gov/image/${encodeURIComponent(id)}/${encodeURIComponent(id)}~orig.jpg`;
    hits.push({
      kind: "image",
      url: full,
      dedupeId: `nasa:${id}`,
      thumbUrl: thumb ?? full,
      author: d.title?.slice(0, 160) ?? null,
      sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(id)}`,
      license: "Public domain (NASA)",
      description: clean(d.title, d.date_created?.slice(0, 10), d.description?.slice(0, 160)),
    });
  }

  await Promise.all(
    videos.map(async (it) => {
      const d = it.data![0];
      const id = d.nasa_id;
      if (!id) return;
      const base = `https://images-assets.nasa.gov/video/${encodeURIComponent(id)}/${encodeURIComponent(id)}`;
      try {
        // Skip long webcasts; also tells us which rendition is small enough to download.
        const meta = await getJson<Record<string, unknown>>(`https://images-assets.nasa.gov/video/${encodeURIComponent(id)}/metadata.json`, "NASA metadata");
        const sec = hmsToSec(meta["QuickTime:Duration"] ?? meta["QuickTime:MediaDuration"]);
        if (sec === null || sec > NASA_MAX_VIDEO_SEC) return;
        const thumb = (it.links ?? []).find((l) => /~large\.jpg$/i.test(l.href ?? ""))?.href ?? (it.links ?? [])[0]?.href;
        hits.push({
          kind: "video",
          url: `${base}~${sec <= 120 ? "large" : "medium"}.mp4`, // large ≈ 1080p, ~40 MB/min
          dedupeId: `nasa:${id}`,
          thumbUrl: thumb,
          author: d.title?.slice(0, 160) ?? null,
          sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(id)}`,
          license: "Public domain (NASA)",
          description: clean(d.title, d.date_created?.slice(0, 10), d.description?.slice(0, 160)),
        });
      } catch {
        /* skip this video */
      }
    })
  );
  return hits;
}

/* ── Smithsonian Open Access (CC0) ────────────────────────────────────────── */

export async function smithsonianSearch(query: string): Promise<ProviderHit[]> {
  const key = getSetting("SMITHSONIAN_API_KEY");
  if (!key) return [];
  const url = new URL("https://api.si.edu/openaccess/api/v1.0/search");
  url.searchParams.set("q", `${query.slice(0, 120)} AND online_visual_material:true`);
  url.searchParams.set("rows", "20");
  url.searchParams.set("api_key", key);
  type Media = { type?: string; idsId?: string; content?: string; thumbnail?: string; usage?: { access?: string } };
  type Row = {
    id?: string;
    title?: string;
    content?: {
      descriptiveNonRepeating?: { record_ID?: string; data_source?: string; online_media?: { media?: Media[] } };
      indexedStructured?: { date?: string[] };
    };
  };
  const data = await getJson<{ response?: { rows?: Row[] } }>(url, "Smithsonian");
  const hits: ProviderHit[] = [];
  for (const row of data.response?.rows ?? []) {
    const dn = row.content?.descriptiveNonRepeating;
    const media = (dn?.online_media?.media ?? []).find((m) => m.type === "Images" && m.usage?.access === "CC0" && m.idsId);
    if (!media) continue;
    const ids = encodeURIComponent(media.idsId!);
    hits.push({
      kind: "image",
      url: `https://ids.si.edu/ids/deliveryService?id=${ids}&max=1920`,
      dedupeId: `smithsonian:${media.idsId}`,
      thumbUrl: `https://ids.si.edu/ids/deliveryService?id=${ids}&max=400`,
      author: [row.title, dn?.data_source].filter(Boolean).join(" — ").slice(0, 160) || null,
      sourceUrl: dn?.record_ID ? `https://www.si.edu/object/${encodeURIComponent(dn.record_ID)}` : undefined,
      license: "CC0 (Smithsonian Open Access)",
      description: clean(row.title, row.content?.indexedStructured?.date?.[0], dn?.data_source),
    });
  }
  return hits;
}

/* ── Europeana (Public Domain Mark + CC0 only) ────────────────────────────── */

const EUROPEANA_FREE = /creativecommons\.org\/publicdomain\/(mark|zero)\//i;

export async function europeanaSearch(query: string): Promise<ProviderHit[]> {
  const key = getSetting("EUROPEANA_API_KEY");
  if (!key) return [];
  type Item = {
    id?: string;
    title?: string[];
    rights?: string[];
    type?: string;
    edmIsShownBy?: string[];
    edmPreview?: string[];
    guid?: string;
    year?: string[];
    dataProvider?: string[];
  };
  const search = async (type: "IMAGE" | "VIDEO", rows: number) => {
    const url = new URL("https://api.europeana.eu/record/v2/search.json");
    url.searchParams.set("wskey", key);
    url.searchParams.set("query", query.slice(0, 120));
    url.searchParams.set("rows", String(rows));
    url.searchParams.set("media", "true");
    url.searchParams.append("qf", "RIGHTS:*publicdomain*");
    url.searchParams.append("qf", `TYPE:${type}`);
    url.searchParams.set("profile", "rich");
    const d = await getJson<{ success?: boolean; items?: Item[]; error?: string }>(url, "Europeana");
    if (d.success === false) throw new Error(`Europeana: ${d.error ?? "request refused"}`);
    return d.items ?? [];
  };
  const [images, videos] = await Promise.all([search("IMAGE", 12), search("VIDEO", 6).catch(() => [] as Item[])]);
  const hits: ProviderHit[] = [];
  for (const it of [...videos, ...images]) {
    if (!(it.rights ?? []).some((r) => EUROPEANA_FREE.test(r))) continue; // double-check the filter
    const file = it.edmIsShownBy?.[0];
    if (!file || !/^https?:\/\//.test(file)) continue;
    const isVideo = it.type === "VIDEO";
    if (isVideo && !/\.mp4(\?|$)/i.test(file)) continue; // players / ogv / webm need a transcode
    hits.push({
      kind: isVideo ? "video" : "image",
      url: file,
      dedupeId: `europeana:${it.id}`,
      thumbUrl: it.edmPreview?.[0],
      author: [it.title?.[0], it.dataProvider?.[0]].filter(Boolean).join(" — ").slice(0, 160) || null,
      sourceUrl: it.guid?.replace(/[?&]utm_[^&]*/g, "").replace(/\?$/, ""),
      license: (it.rights ?? []).find((r) => EUROPEANA_FREE.test(r)) ?? "Public domain",
      description: clean(it.title?.[0], it.year?.[0], it.dataProvider?.[0]),
    });
  }
  return hits;
}

/* ── Flickr (licences 7, 9, 10 only) ──────────────────────────────────────── */

/** 7 = No known copyright restrictions (Flickr Commons), 9 = CC0, 10 = Public Domain Mark. */
export const FLICKR_FREE_LICENSES = ["7", "9", "10"];

export async function flickrSearch(query: string): Promise<ProviderHit[]> {
  const key = getSetting("FLICKR_API_KEY");
  if (!key) return [];
  const url = new URL("https://api.flickr.com/services/rest/");
  url.searchParams.set("method", "flickr.photos.search");
  url.searchParams.set("api_key", key);
  url.searchParams.set("text", query.slice(0, 120));
  url.searchParams.set("license", FLICKR_FREE_LICENSES.join(","));
  url.searchParams.set("content_types", "0"); // photos only, no screenshots/illustrations
  url.searchParams.set("media", "photos");
  url.searchParams.set("sort", "relevance");
  url.searchParams.set("per_page", "20");
  url.searchParams.set("extras", "license,owner_name,url_k,url_l,url_z,date_taken");
  url.searchParams.set("format", "json");
  url.searchParams.set("nojsoncallback", "1");
  type Photo = { id?: string; owner?: string; title?: string; license?: string; ownername?: string; url_k?: string; url_l?: string; url_z?: string; datetaken?: string };
  const d = await getJson<{ stat?: string; message?: string; photos?: { photo?: Photo[] } }>(url, "Flickr");
  if (d.stat && d.stat !== "ok") throw new Error(`Flickr: ${d.message ?? d.stat}`);
  const hits: ProviderHit[] = [];
  for (const p of d.photos?.photo ?? []) {
    if (!p.id || !FLICKR_FREE_LICENSES.includes(String(p.license))) continue;
    const full = p.url_k || p.url_l;
    if (!full) continue; // too small for a 1080p frame
    hits.push({
      kind: "image",
      url: full,
      dedupeId: `flickr:${p.id}`,
      thumbUrl: p.url_z || full,
      author: p.ownername ?? null,
      sourceUrl: p.owner ? `https://www.flickr.com/photos/${p.owner}/${p.id}` : undefined,
      license: p.license === "9" ? "CC0" : p.license === "10" ? "Public Domain Mark" : "No known copyright restrictions",
      description: clean(p.title, p.datetaken?.slice(0, 10), p.ownername),
    });
  }
  return hits;
}

/* ── DVIDS (US government works) ──────────────────────────────────────────── */

export async function dvidsSearch(query: string): Promise<ProviderHit[]> {
  const key = getSetting("DVIDS_API_KEY");
  if (!key) return [];
  const url = new URL("https://api.dvidshub.net/search");
  url.searchParams.set("api_key", key);
  url.searchParams.set("q", query.slice(0, 120));
  url.searchParams.append("type[]", "image");
  url.searchParams.append("type[]", "video");
  url.searchParams.set("max_results", "12");
  type Result = { id?: string; type?: string; title?: string; url?: string; date?: string; thumbnail?: { url?: string } | string; unit_name?: string };
  const d = await getJson<{ results?: Result[]; errors?: string[] }>(url, "DVIDS");
  if (d.errors?.length) throw new Error(`DVIDS: ${d.errors.join("; ")}`);
  const results = (d.results ?? []).filter((r) => r.id && (r.type === "image" || r.type === "video")).slice(0, 8);
  const hits = await Promise.all(
    results.map(async (r): Promise<ProviderHit | null> => {
      try {
        // The search result carries only a thumbnail; the file comes from /asset.
        const a = new URL("https://api.dvidshub.net/asset");
        a.searchParams.set("api_key", key);
        a.searchParams.set("id", r.id!);
        type Asset = { image?: string; files?: { src?: string; type?: string; width?: number }[]; duration?: number };
        const asset = (await getJson<{ results?: Asset }>(a, "DVIDS asset")).results ?? {};
        const thumb = typeof r.thumbnail === "string" ? r.thumbnail : r.thumbnail?.url;
        let file: string | undefined;
        if (r.type === "video") {
          const mp4s = (asset.files ?? []).filter((f) => f.src && /mp4/i.test(`${f.type ?? ""}${f.src}`));
          // Closest to 1080p without going far above it (smaller download, same frame).
          mp4s.sort((x, y) => Math.abs((x.width ?? 0) - 1920) - Math.abs((y.width ?? 0) - 1920));
          file = mp4s[0]?.src;
          if (asset.duration && asset.duration > 600) return null;
        } else {
          file = asset.image;
        }
        if (!file) return null;
        return {
          kind: r.type === "video" ? "video" : "image",
          url: file,
          dedupeId: `dvids:${r.id}`,
          thumbUrl: thumb ?? file,
          author: [r.title, r.unit_name].filter(Boolean).join(" — ").slice(0, 160) || null,
          sourceUrl: r.url,
          license: "Public domain (US government work, DVIDS)",
          description: clean(r.title, r.date?.slice(0, 10), r.unit_name),
        };
      } catch {
        return null;
      }
    })
  );
  return hits.filter((h): h is ProviderHit => h !== null);
}

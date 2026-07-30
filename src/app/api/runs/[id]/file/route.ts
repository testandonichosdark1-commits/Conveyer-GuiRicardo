import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { getRunDir } from "@/lib/run-paths";

// This route serves file bytes via node:fs streams, so it must run on the Node
// runtime (also the default for route handlers — pinned here for clarity/safety).
export const runtime = "nodejs";

const getRun = db.prepare("SELECT id, title, folder_name FROM runs WHERE id = ?");

/**
 * A lazily-piped web ReadableStream over a byte range of a file. Uses
 * fs.createReadStream (Node's `end` is INCLUSIVE), so memory stays flat
 * regardless of file size — never buffering the whole file (the old code did
 * `readFileSync`/`Buffer.alloc`, which throws ERR_FS_FILE_TOO_LARGE above ~2 GiB
 * and 500'd on long videos).
 */
function fileStream(target: string, range?: { start: number; end: number }): ReadableStream {
  const nodeStream = fs.createReadStream(target, range);
  return Readable.toWeb(nodeStream) as unknown as ReadableStream;
}

/**
 * Turn a run title into a safe download filename base. Strips only characters
 * that are illegal in a filename (path separators, control chars) and collapses
 * whitespace — it does NOT shorten the title, so the full title the user typed
 * is preserved in the download name. Length is bounded separately, by BYTES, so
 * a very long title still fits the ~255-byte filesystem limit (see MAX_NAME_BYTES).
 */
function safeFileBase(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "") // chars illegal on Windows/macOS
    .replace(/\s+/g, " ")
    .trim();
}

// Common filesystem NAME_MAX is 255 bytes; stay comfortably under it (leaving room
// for the extension). Realistic video titles are far shorter, so this only ever
// trims a pathologically long title — never a normal one.
const MAX_NAME_BYTES = 250;

/** Trim a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
function clampBytes(s: string, maxBytes: number): string {
  let out = s;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Serves any file from a run folder.
 *   /api/runs/{id}/file?p=final.mp4
 *   /api/runs/{id}/file?p=audio/scene_000.mp3
 *   ?download=1 — adds Content-Disposition: attachment.
 *
 * Supports HTTP Range requests (206) so HTML5 video players can seek,
 * and we don't load 200MB files into memory just to serve a 64KB chunk.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const run = getRun.get(id) as { id: string; title: string | null; folder_name: string | null } | undefined;
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const url = new URL(req.url);
  const rel = url.searchParams.get("p") ?? "final.mp4";
  const download = url.searchParams.get("download") === "1";

  const runDir = path.resolve(getRunDir(id));
  const target = path.resolve(path.join(runDir, rel));
  if (!target.startsWith(runDir + path.sep) && target !== runDir) {
    return NextResponse.json({ error: "path escape blocked" }, { status: 400 });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return NextResponse.json({ error: "file not found", target }, { status: 404 });
  }

  const stat = fs.statSync(target);
  const size = stat.size;
  const ext = path.extname(target).toLowerCase();
  const mime =
    ext === ".mp4" ? "video/mp4" :
    ext === ".mp3" ? "audio/mpeg" :
    ext === ".png" ? "image/png" :
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
    "application/octet-stream";

  const baseHeaders: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0",
  };
  if (download) {
    // Name the final video after the run's title (falling back to its folder name,
    // then the raw file name) so downloads aren't all "final.mp4". Other files keep
    // their real name.
    const base = path.basename(target);
    let downloadName = base;
    if (base === "final.mp4") {
      // Prefer the full title straight from the DB (not the sanitized/clamped
      // folder name); fall back to the folder name only when title is null.
      const titled = safeFileBase(run.title || "") || safeFileBase(run.folder_name || "");
      if (titled) {
        // Bound the whole name (title + extension) by bytes so we never exceed the
        // filesystem limit, trimming only the title part if it's pathologically long.
        const baseBudget = MAX_NAME_BYTES - Buffer.byteLength(ext, "utf8");
        downloadName = `${clampBytes(titled, baseBudget)}${ext}`;
      }
    }
    // RFC 5987: filename* carries the real (possibly accented) name; the quoted
    // ASCII filename is a fallback for older clients.
    const ascii = downloadName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    baseHeaders["Content-Disposition"] =
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }

  // === Range request (for seeking in audio/video players) ===
  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      const chunkSize = end - start + 1;
      return new Response(fileStream(target, { start, end }), {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(chunkSize),
          "Content-Range": `bytes ${start}-${end}/${size}`,
        },
      });
    }
  }

  // === Full response (streamed, not buffered) ===
  return new Response(fileStream(target), {
    headers: {
      ...baseHeaders,
      "Content-Length": String(size),
    },
  });
}

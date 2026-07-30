import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { getRunsRoot, dirSizeBytes } from "@/lib/run-paths";

// Walks the runs folder on disk — Node runtime.
export const runtime = "nodejs";

// Only live (non-deleted) jobs count toward the widget; deleted runs are hidden
// from the Jobs page and their folders are already gone from disk.
const countRuns = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE deleted_at IS NULL");

// The 4s Jobs poll hits this endpoint; cache the disk walk so we never re-scan
// the whole runs tree more than once per TTL.
const TTL_MS = 30_000;
let cache: { totalBytes: number; ts: number } | null = null;

export async function GET() {
  ensureInit();
  const jobCount = (countRuns.get() as { n: number }).n;

  const now = Date.now();
  if (!cache || now - cache.ts > TTL_MS) {
    const root = getRunsRoot();
    let totalBytes = 0;
    try {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (ent.isDirectory()) totalBytes += dirSizeBytes(path.join(root, ent.name));
      }
    } catch {
      totalBytes = 0; // root missing yet
    }
    cache = { totalBytes, ts: now };
  }

  return NextResponse.json({ totalBytes: cache.totalBytes, jobCount });
}

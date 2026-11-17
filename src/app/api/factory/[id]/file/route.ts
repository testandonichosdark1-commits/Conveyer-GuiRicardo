import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { ensureInit } from "@/lib/init";
import { getJob, jobFiles } from "@/lib/factory/jobs";

export const dynamic = "force-dynamic";

const KINDS = {
  script: "text/plain; charset=utf-8",
  description: "text/plain; charset=utf-8",
  research: "text/markdown; charset=utf-8",
  thumbnailPackage: "text/markdown; charset=utf-8",
  thumbnail: "image/jpeg",
} as const;

/** GET ?kind=script|description|research|thumbnailPackage|thumbnail[&download=1] */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") as keyof typeof KINDS | null;
  if (!kind || !(kind in KINDS)) return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  // Only ever a file jobFiles() found inside the job's own folder — never a path from the request.
  const file = jobFiles(job)[kind];
  if (!file || !fs.existsSync(file)) return NextResponse.json({ error: "not ready" }, { status: 404 });
  const headers: Record<string, string> = { "Content-Type": KINDS[kind], "Cache-Control": "no-store" };
  if (url.searchParams.get("download")) {
    headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(path.basename(file))}"`;
  }
  return new NextResponse(fs.readFileSync(file), { headers });
}

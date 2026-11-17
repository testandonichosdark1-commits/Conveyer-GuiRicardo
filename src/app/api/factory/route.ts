import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { createJob, listJobs, jobFiles, type ChannelKind } from "@/lib/factory/jobs";
import { pump, activeCount, factoryConcurrency } from "@/lib/factory/queue";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureInit();
  pump();
  const jobs = listJobs().map((j) => {
    const f = jobFiles(j);
    return {
      ...j,
      files: {
        script: !!f.script,
        description: !!f.description,
        research: !!f.research,
        thumbnail: !!f.thumbnail,
        thumbnailPackage: !!f.thumbnailPackage,
      },
    };
  });
  return NextResponse.json({ jobs, active: activeCount(), concurrency: factoryConcurrency() });
}

interface Body {
  titles?: unknown;
  channelKind?: unknown;
  channelId?: unknown;
  visualMode?: unknown;
  realPercent?: unknown;
  avatarPercent?: unknown;
  voice?: unknown;
  free?: unknown;
}

const clampPct = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : d;
};

export async function POST(req: Request) {
  ensureInit();
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const titles = (Array.isArray(body.titles) ? body.titles : String(body.titles ?? "").split("\n"))
    .map((t) => String(t).replace(/^[\s*•\-\d.)]+/, "").trim())
    .filter((t) => t.length >= 8);
  if (titles.length === 0) return NextResponse.json({ error: "Add at least one title." }, { status: 400 });
  if (titles.length > 50) return NextResponse.json({ error: "At most 50 titles per batch." }, { status: 400 });

  const kind = String(body.channelKind ?? "a") as ChannelKind;
  if (!["a", "b", "c"].includes(kind)) return NextResponse.json({ error: "channelKind must be a, b or c" }, { status: 400 });

  const vm = body.visualMode === "ai" || body.visualMode === "real" ? body.visualMode : "mix";
  const channelId = Number(body.channelId);
  const options = {
    channelId: Number.isFinite(channelId) && channelId > 0 ? channelId : null,
    visualMode: vm as "ai" | "real" | "mix",
    realPercent: clampPct(body.realPercent, 50),
    avatarPercent: clampPct(body.avatarPercent, 0),
    voice: (body.voice === "channel" ? "channel" : "voicestudio") as "channel" | "voicestudio",
    free: body.free !== false,
  };
  if (options.free) options.visualMode = "real";

  const created = titles.map((t) => createJob(t, kind, options));
  pump();
  return NextResponse.json({ created: created.map((j) => j.id) });
}

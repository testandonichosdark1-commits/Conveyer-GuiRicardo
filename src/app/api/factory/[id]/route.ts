import { NextResponse } from "next/server";
import fs from "node:fs";
import { ensureInit } from "@/lib/init";
import { deleteJob, getJob } from "@/lib/factory/jobs";
import { cancelJob, retryJob } from "@/lib/factory/queue";

export const dynamic = "force-dynamic";

/** POST { action: "cancel" | "retry" | "delete" } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { action } = ((await req.json().catch(() => ({}))) ?? {}) as { action?: string };
  if (action === "cancel") cancelJob(id);
  else if (action === "retry") retryJob(id);
  else if (action === "delete") {
    if (job.status === "running") return NextResponse.json({ error: "cancel it first" }, { status: 409 });
    deleteJob(id);
    // Keep paid outputs unless the folder only holds logs (never delete a finished script by accident).
    const left = fs.existsSync(job.folder) ? fs.readdirSync(job.folder) : [];
    if (left.every((n) => n.startsWith("claude-"))) fs.rmSync(job.folder, { recursive: true, force: true });
  } else return NextResponse.json({ error: "unknown action" }, { status: 400 });
  return NextResponse.json({ ok: true });
}

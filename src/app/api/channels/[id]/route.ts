import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getChannel, updateChannel, deleteChannel } from "@/lib/channels";

export const runtime = "nodejs";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const cid = Number(id);
  if (!getChannel(cid)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    updateChannel(cid, {
      name: String(body.name || ""),
      visual_mode: body.visual_mode as "ai" | "real" | "mix" | undefined,
      ai_style: body.ai_style != null ? String(body.ai_style) : null,
      visual_prompt: body.visual_prompt != null ? String(body.visual_prompt) : null,
      voice_id: body.voice_id != null ? String(body.voice_id) : null,
      interval_sec: body.interval_sec != null ? Number(body.interval_sec) : undefined,
      format: body.format != null ? String(body.format) : undefined,
      avatar_id: body.avatar_id != null ? Number(body.avatar_id) : null,
      real_ratio_percent: body.real_ratio_percent != null ? Number(body.real_ratio_percent) : null,
      footage_source_tiers: body.footage_source_tiers != null ? String(body.footage_source_tiers) : null,
    });
    return NextResponse.json(getChannel(cid));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  deleteChannel(Number(id));
  return NextResponse.json({ ok: true });
}

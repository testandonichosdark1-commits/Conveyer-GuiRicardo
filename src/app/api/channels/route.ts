import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { listChannels, createChannel, getChannel } from "@/lib/channels";

export const runtime = "nodejs";

export async function GET() {
  ensureInit();
  return NextResponse.json(listChannels());
}

export async function POST(req: Request) {
  ensureInit();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const id = createChannel({
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
    return NextResponse.json(getChannel(id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}

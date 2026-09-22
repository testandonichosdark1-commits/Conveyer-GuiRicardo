import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getChannel, updateChannel, deleteChannel, toClientChannel, mergeChannelApiKeys, deriveVoiceProvider } from "@/lib/channels";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const channel = getChannel(Number(id));
  if (!channel) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(toClientChannel(channel));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const cid = Number(id);
  const existing = getChannel(cid);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    // api_keys is OPTIONAL in the body — a save from a form that doesn't render the API
    // Keys section at all (there isn't one today, but keep this route generic) must not
    // wipe out overrides it never showed the operator.
    const apiKeysUpdate =
      body.api_keys && typeof body.api_keys === "object"
        ? mergeChannelApiKeys(existing.api_keys_json, body.api_keys as Record<string, string>)
        : undefined;
    const voiceId = body.voice_id != null ? String(body.voice_id) : null;
    updateChannel(cid, {
      name: String(body.name || ""),
      visual_mode: body.visual_mode as "ai" | "real" | "mix" | undefined,
      ai_style: body.ai_style != null ? String(body.ai_style) : null,
      visual_prompt: body.visual_prompt != null ? String(body.visual_prompt) : null,
      voice_id: voiceId,
      voice_speed: body.voice_speed != null && body.voice_speed !== "" ? Number(body.voice_speed) : null,
      // Derived, never trusted from the client — see deriveVoiceProvider()'s doc comment.
      voice_provider: deriveVoiceProvider(voiceId),
      api_keys_json: apiKeysUpdate,
      interval_sec: body.interval_sec != null ? Number(body.interval_sec) : undefined,
      format: body.format != null ? String(body.format) : undefined,
      avatar_id: body.avatar_id != null ? Number(body.avatar_id) : null,
    });
    const updated = getChannel(cid);
    return NextResponse.json(updated ? toClientChannel(updated) : null);
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

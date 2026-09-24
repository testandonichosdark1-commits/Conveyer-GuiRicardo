import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { listChannels, createChannel, getChannel, toClientChannel, mergeChannelApiKeys, deriveVoiceProvider } from "@/lib/channels";

export const runtime = "nodejs";

export async function GET() {
  ensureInit();
  return NextResponse.json(listChannels().map(toClientChannel));
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
    // A new channel has no prior stored keys to re-hydrate a mask from — the client
    // never has a mask to send back on create anyway (there is nothing to load yet).
    const apiKeys = body.api_keys && typeof body.api_keys === "object" ? (body.api_keys as Record<string, string>) : {};
    const voiceId = body.voice_id != null ? String(body.voice_id) : null;
    const id = createChannel({
      name: String(body.name || ""),
      visual_mode: body.visual_mode as "ai" | "real" | "mix" | undefined,
      ai_style: body.ai_style != null ? String(body.ai_style) : null,
      visual_prompt: body.visual_prompt != null ? String(body.visual_prompt) : null,
      character_terms: body.character_terms != null ? String(body.character_terms) : null,
      voice_id: voiceId,
      voice_speed: body.voice_speed != null && body.voice_speed !== "" ? Number(body.voice_speed) : null,
      // Derived, never trusted from the client — see deriveVoiceProvider()'s doc comment.
      voice_provider: deriveVoiceProvider(voiceId),
      api_keys_json: mergeChannelApiKeys(null, apiKeys),
      interval_sec: body.interval_sec != null ? Number(body.interval_sec) : undefined,
      format: body.format != null ? String(body.format) : undefined,
      avatar_id: body.avatar_id != null ? Number(body.avatar_id) : null,
    });
    const created = getChannel(id);
    return NextResponse.json(created ? toClientChannel(created) : null);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}

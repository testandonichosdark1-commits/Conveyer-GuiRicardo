import { NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSpeech } from "@/lib/services/voicebox-client";

export const runtime = "nodejs";

const DEFAULT_PREVIEW_TEXT =
  "Hello, this is a preview of this voice. I hope it sounds just right for your video.";

/** POST /api/voices/voicebox/:id/preview — generates a short sample and streams
 *  the mp3 back for an inline <audio> player; nothing is persisted. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let text = DEFAULT_PREVIEW_TEXT;
  try {
    const body = (await req.json()) as { text?: string };
    if (body?.text?.trim()) text = body.text.trim().slice(0, 500);
  } catch {
    // no body / not JSON — use the default preview line
  }

  const tmpPath = path.join(os.tmpdir(), `voice-preview-${Date.now()}.mp3`);
  try {
    await generateSpeech(id, text, tmpPath);
    const buf = fs.readFileSync(tmpPath);
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

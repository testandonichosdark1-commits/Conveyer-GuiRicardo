import { NextResponse } from "next/server";
import { getSetting } from "@/lib/settings";
import { listPresetVoices } from "@/lib/services/voicebox-client";

export const runtime = "nodejs";

/** GET /api/voicebox-presets/:engine — preset voices available for one engine (e.g. "kokoro"). */
export async function GET(_req: Request, { params }: { params: Promise<{ engine: string }> }) {
  const { engine } = await params;
  if (!getSetting("VOICEBOX_DIR")) return NextResponse.json([]);
  try {
    return NextResponse.json(await listPresetVoices(engine));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

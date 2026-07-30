import { NextResponse } from "next/server";
import { deleteVoiceProfile } from "@/lib/services/voicebox-client";

export const runtime = "nodejs";

/** DELETE /api/voices/voicebox/:id */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await deleteVoiceProfile(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

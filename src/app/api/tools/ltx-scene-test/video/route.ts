import fs from "node:fs/promises";
import path from "node:path";
import { LTX_TEST_DIR } from "@/lib/services/ltx/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) return new Response("Teste inválido", { status: 400 });
  try {
    const dir = path.join(LTX_TEST_DIR, id);
    const journal = JSON.parse(await fs.readFile(path.join(dir, "attempt.json"), "utf8"));
    if (journal.phase !== "complete" || !journal.stoppedVerified) return new Response("Teste ainda não concluído", { status: 409 });
    const video = await fs.readFile(path.join(dir, "scene_1080p.mp4"));
    return new Response(video, { headers: { "Content-Type": "video/mp4", "Content-Length": String(video.length),
      "Cache-Control": "no-store", "Content-Disposition": 'inline; filename="scene_1080p.mp4"' } });
  } catch { return new Response("Vídeo não encontrado", { status: 404 }); }
}

import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { getRunDir } from "@/lib/run-paths";
import { listLtxScenes, attachLtxClip, ltxSceneDir } from "@/lib/services/ltx/pipeline";
import { resolveLtxTarget } from "@/lib/services/ltx/targets";
import { LTX_TEST_DIR } from "@/lib/services/ltx/session";
import { listDrafts, draftDir } from "@/lib/services/ltx/script-drafts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("input") === "1") {
    try {
      const target = await resolveLtxTarget(url.searchParams.get("runId") || "", Number(url.searchParams.get("index")), url.searchParams.get("fingerprint") || "");
      const dir = ltxSceneDir(target.runDir, target.request.index);
      const saved = JSON.parse(await fs.readFile(path.join(dir, "input.json"), "utf8"));
      if (saved.fingerprint !== target.request.fingerprint) throw new Error("Imagem de outra cena.");
      const png = await fs.readFile(path.join(dir, "input.png"));
      return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    } catch { return NextResponse.json({ error: "A imagem desta cena ainda não foi aplicada." }, { status: 404 }); }
  }
  const runs = db.prepare("SELECT id, title FROM runs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100").all() as { id: string; title: string }[];
  const scenes = [];
  for (const run of runs) {
    for (const scene of await listLtxScenes(getRunDir(run.id))) scenes.push({ ...scene, runId: run.id, title: run.title || "Vídeo sem título" });
  }
  for (const draft of await listDrafts()) {
    for (const scene of await listLtxScenes(draftDir(draft.id))) scenes.push({ ...scene, runId: draft.id, title: draft.title });
  }
  return NextResponse.json({ scenes });
}
/** Local recovery only. Never uploads or submits a generation. */
export async function POST(req: Request) {
  if (req.headers.get("Origin") !== new URL(req.url).origin) return NextResponse.json({ error: "Abra no Conveyer." }, { status: 403 });
  try {
    const body = await req.json();
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(body.jobId)) throw new Error("Geração inválida.");
    const jobDir = path.join(LTX_TEST_DIR, body.jobId);
    const saved = JSON.parse(await fs.readFile(path.join(jobDir, "target.json"), "utf8"));
    const target = await resolveLtxTarget(saved.runId, saved.index, saved.fingerprint);
    await attachLtxClip(target.runDir, saved.index, saved.fingerprint, jobDir);
    await fs.writeFile(path.join(jobDir, "attached.json"), JSON.stringify(saved), { mode: 0o600 });
    return NextResponse.json({ attached: true });
  } catch { return NextResponse.json({ error: "O clipe ainda não pode ser aplicado à cena. Confira a geração, a parada e se a cena mudou." }, { status: 409 }); }
}

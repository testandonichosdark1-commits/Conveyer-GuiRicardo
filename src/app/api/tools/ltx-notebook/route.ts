import { NextResponse } from "next/server";
import {
  connectLtxNotebook, disconnectLtxNotebook, generateLtxClipViaNotebook, probeNotebook, readLtxNotebookSession,
} from "@/lib/services/ltx/notebook";
import { readLtxInputImage } from "@/lib/services/ltx/pipeline";
import { resolveLtxTarget } from "@/lib/services/ltx/targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ManualJob = { state: "running" | "done" | "failed"; error?: string };
// Manual "generate this scene" clicks from /tools/ltx-scene-test; the pipeline path does not use this.
const shared = globalThis as typeof globalThis & { __conveyerLtxNotebookJobs?: Map<string, ManualJob> };
const jobs = shared.__conveyerLtxNotebookJobs ??= new Map();

/** Never returns the token. `?check=1` also asks the notebook whether it is still up. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const session = await readLtxNotebookSession();
  const key = url.searchParams.get("job");
  const job = key ? jobs.get(key) ?? null : null;
  if (!session) return NextResponse.json({ connected: false, job });
  let live: boolean | null = null, liveError: string | null = null;
  if (url.searchParams.get("check") === "1") {
    try {
      const health = await probeNotebook(session.baseUrl, session.token);
      live = health.comfy && health.modelsReady;
      if (!live) liveError = health.comfy ? "Modelos LTX incompletos no notebook." : "ComfyUI do notebook não respondeu.";
    } catch (error) { live = false; liveError = (error as Error).message; }
  }
  return NextResponse.json({ connected: true, baseUrl: session.baseUrl, gpu: session.gpu, vramGb: session.vramGb,
    sparseAttention: session.sparseAttention, profile: session.profile ?? "full", connectedAt: session.connectedAt, deadline: session.deadline, live, liveError, job });
}

export async function POST(req: Request) {
  if (req.headers.get("Origin") !== new URL(req.url).origin) {
    return NextResponse.json({ error: "Abra no Conveyer." }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Requisição inválida." }, { status: 400 }); }

  if (body.action === "disconnect") {
    await disconnectLtxNotebook();
    return NextResponse.json({ connected: false });
  }
  if (body.action === "connect") {
    try {
      const session = await connectLtxNotebook(String(body.url ?? ""), String(body.token ?? ""));
      return NextResponse.json({ connected: true, gpu: session.gpu, vramGb: session.vramGb, sparseAttention: session.sparseAttention, profile: session.profile ?? "full" });
    } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
  }
  if (body.action === "generate") {
    const session = await readLtxNotebookSession();
    if (!session) return NextResponse.json({ error: "Conecte o notebook primeiro." }, { status: 409 });
    let target: Awaited<ReturnType<typeof resolveLtxTarget>>;
    try {
      target = await resolveLtxTarget(String(body.runId ?? ""), Number(body.index), String(body.fingerprint ?? ""));
      if (target.request.media !== "video") throw new Error();
    } catch { return NextResponse.json({ error: "A cena de vídeo não foi encontrada ou mudou. Atualize a lista." }, { status: 409 }); }
    if (!(await readLtxInputImage(target.runDir, target.request.index, target.request.fingerprint))) {
      return NextResponse.json({ error: "Aplique primeiro a imagem inicial desta cena (GPT ou upload)." }, { status: 409 });
    }
    const key = `${target.runId}:${target.request.index}:${target.request.fingerprint}`;
    if (jobs.get(key)?.state === "running") return NextResponse.json({ error: "Esta cena já está sendo gerada.", job: key }, { status: 409 });
    jobs.set(key, { state: "running" });
    void generateLtxClipViaNotebook(target.runDir, target.request.index, target.request.fingerprint, { session })
      .then(() => { jobs.set(key, { state: "done" }); })
      .catch((error: Error) => {
        const cause = error.cause instanceof Error ? error.cause.message : error.message;
        jobs.set(key, { state: "failed", error: cause.slice(0, 300) });
      });
    return NextResponse.json({ job: key, state: "running" }, { status: 202 });
  }
  return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
}

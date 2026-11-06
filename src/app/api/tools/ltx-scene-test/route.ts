import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { NextResponse } from "next/server";
import { ltxPreparation } from "@/lib/services/ltx/workflow";
import { saveLtxImage, attachLtxClip } from "@/lib/services/ltx/pipeline";
import { resolveLtxTarget } from "@/lib/services/ltx/targets";
import { animateLtxScene } from "@/lib/services/ltx/scene";
import { readLtxSession, ltxTransport, requestLtxStop, guardianVerifiedStop, LTX_TEST_DIR } from "@/lib/services/ltx/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await readLtxSession();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    const consumed = session && await fs.stat(path.join(LTX_TEST_DIR, session.approvalId, "request.lock")).then(() => true, () => false);
    return NextResponse.json({ ready: Boolean(session && !consumed), approvalId: session?.approvalId ?? null });
  }
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) return NextResponse.json({ error: "Teste inválido." }, { status: 400 });
  try {
    const journal = JSON.parse(await fs.readFile(path.join(LTX_TEST_DIR, id, "attempt.json"), "utf8"));
    journal.stoppedVerified = journal.stoppedVerified || await guardianVerifiedStop(id);
    const attached = await fs.readFile(path.join(LTX_TEST_DIR, id, "attached.json"), "utf8").then(JSON.parse, () => null);
    const target = await fs.readFile(path.join(LTX_TEST_DIR, id, "target.json"), "utf8").then(JSON.parse, () => null);
    return NextResponse.json({ ...journal, id, attached, target,
      videoUrl: journal.phase === "complete" && journal.stoppedVerified ? `/api/tools/ltx-scene-test/video?id=${id}` : null });
  } catch {
    const reserved = await fs.stat(path.join(LTX_TEST_DIR, id, "request.lock")).then(() => true, () => false);
    return NextResponse.json({ phase: "waiting", stoppedVerified: false, id }, { status: reserved ? 200 : 404 });
  }
}

async function boundedForm(req: Request) {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("Selecione uma imagem.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 12 * 1024 * 1024) throw new Error("Envie uma imagem de até 10 MB.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return await new Response(Buffer.concat(chunks), { headers: { "Content-Type": req.headers.get("Content-Type") ?? "" } }).formData();
}

export async function POST(req: Request) {
  if (req.headers.get("Origin") !== new URL(req.url).origin) {
    return NextResponse.json({ error: "Abra o teste dentro do Conveyer." }, { status: 403 });
  }
  let form: FormData;
  try { form = await boundedForm(req); }
  catch { return NextResponse.json({ error: "Envie uma imagem válida de até 10 MB." }, { status: 400 }); }
  const action = form.get("action");
  if (action === "stop") {
    const stopped = await requestLtxStop(String(form.get("approvalId") ?? ""));
    return NextResponse.json({ stopRequested: stopped }, { status: stopped ? 202 : 409 });
  }
  if (action !== "prepare" && action !== "generate") return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
  const prompt = String(form.get("prompt") ?? "");
  let preparation: ReturnType<typeof ltxPreparation>;
  let imagePng: Buffer;
  try {
    preparation = ltxPreparation(prompt);
    const image = form.get("image");
    if (!(image instanceof File) || !image.size || image.size > 10 * 1024 * 1024 ||
        !["image/png", "image/jpeg", "image/webp"].includes(image.type)) throw new Error("Imagem inválida.");
    // Decode on the server, discard metadata and normalize the actual file fed to ComfyUI.
    imagePng = await sharp(Buffer.from(await image.arrayBuffer()), { limitInputPixels: 40_000_000 })
      .rotate().resize(1920, 1080, { fit: "cover" }).png().toBuffer();
  } catch { return NextResponse.json({ error: "Confira a imagem e descreva a cena em até 6.000 caracteres." }, { status: 400 }); }
  let target: Awaited<ReturnType<typeof resolveLtxTarget>> | null = null;
  const runId = form.get("runId");
  if (runId) {
    try {
      target = await resolveLtxTarget(String(runId), Number(form.get("index")), String(form.get("fingerprint")));
      if (action === "generate" && target.request.media !== "video") throw new Error("Esta cena pede uma imagem.");
    } catch { return NextResponse.json({ error: "A cena mudou ou não foi encontrada. Atualize a lista." }, { status: 409 }); }
  }
  if (action === "prepare") {
    if (target) await saveLtxImage(target.runDir, target.request.index, target.request.fingerprint, imagePng);
    return NextResponse.json({ ...preparation, imageDataUrl: `data:image/png;base64,${imagePng.toString("base64")}`,
      imageApplied: target?.request.media === "image" });
  }
  if (form.get("confirmPaid") !== "true") return NextResponse.json({ error: "É necessária confirmação explícita do teste pago." }, { status: 403 });
  const session = await readLtxSession();
  if (!session || form.get("approvalId") !== session.approvalId) {
    return NextResponse.json({ error: "Geração bloqueada: falta uma GPU autorizada com parada automática verificada." }, { status: 409 });
  }
  const outputDir = path.join(LTX_TEST_DIR, session.approvalId);
  // Reserve the whole approval across concurrent browser requests/server instances.
  await fs.mkdir(outputDir, { recursive: true });
  try { const lock = await fs.open(path.join(outputDir, "request.lock"), "wx", 0o600); await lock.close(); }
  catch { return NextResponse.json({ error: "Esta autorização já foi usada. Não haverá novo envio.", id: session.approvalId }, { status: 409 }); }
  const savedTarget = target ? { runId: target.runId, index: target.request.index, fingerprint: target.request.fingerprint } : null;
  if (savedTarget) {
    try { await fs.writeFile(path.join(outputDir, "target.json"), JSON.stringify(savedTarget), { flag: "wx", mode: 0o600 }); }
    catch { await requestLtxStop(session.approvalId); return NextResponse.json({ error: "Não foi possível reservar esta cena; parada solicitada." }, { status: 409 }); }
  }
  // Independent guardian survives the request and app; the durable attempt prevents retries.
  void animateLtxScene({ session, prompt, imagePng, outputDir }, ltxTransport(session)).then(async () => {
    if (!target || !savedTarget) return;
    try {
      await attachLtxClip(target.runDir, savedTarget.index, savedTarget.fingerprint, outputDir);
      await fs.writeFile(path.join(outputDir, "attached.json"), JSON.stringify(savedTarget), { mode: 0o600 });
    } catch { /* Keep successful clip: applying it locally can be retried without a generation. */ }
  }).catch(async () => {
    const stoppedVerified = await ltxTransport(session).stopAndVerify(session).catch(() => false);
    // Expose a safe terminal state even when preflight fails before the journal is created.
    const journalPath = path.join(outputDir, "attempt.json");
    try {
      const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
      journal.phase = "failed";
      journal.stoppedVerified = journal.stoppedVerified || stoppedVerified;
      journal.error = "O teste falhou. Confira a confirmação de parada; o envio não será repetido.";
      await fs.writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
    } catch {
      await fs.writeFile(journalPath, JSON.stringify({ phase: "failed", stoppedVerified,
        error: "O teste foi bloqueado antes do envio. Confira a GPU no Runpod." }), { mode: 0o600 }).catch(() => {});
    }
  });
  return NextResponse.json({ id: session.approvalId, phase: "waiting" }, { status: 202 });
}

import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { resolveFfmpeg, resolveFfprobe } from "@/lib/ffmpeg-bin";
import { ltxSceneDir, readyLtxScene, attachImportedLtxClip } from "@/lib/services/ltx/pipeline";
import { resolveLtxTarget } from "@/lib/services/ltx/targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_VIDEO_DURATION_SEC = 120;
const execFileAsync = promisify(execFile);

async function validateVideo(filePath: string) {
  const { stdout } = await execFileAsync(resolveFfprobe(), [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height,duration:format=duration",
    "-of", "json", filePath,
  ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const probe = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
    format?: { duration?: string };
  };
  const video = probe.streams?.[0];
  const duration = Number(video?.duration ?? probe.format?.duration);
  if (video?.codec_type !== "video" || typeof video.width !== "number" || typeof video.height !== "number" ||
      !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) ||
      video.width < 16 || video.height < 16 || !Number.isFinite(duration) || duration <= 0 ||
      duration > MAX_VIDEO_DURATION_SEC) {
    throw new Error(`O arquivo precisa conter vídeo válido de até ${MAX_VIDEO_DURATION_SEC} segundos.`);
  }
  await execFileAsync(resolveFfmpeg(), [
    "-v", "error", "-nostdin", "-i", filePath, "-map", "0:v:0", "-f", "null", "-",
  ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
}

export async function POST(req: Request) {
  if (req.headers.get("Origin") !== new URL(req.url).origin) {
    return NextResponse.json({ error: "Abra a importação dentro do Conveyer." }, { status: 403 });
  }
  const url = new URL(req.url);
  let target: Awaited<ReturnType<typeof resolveLtxTarget>>;
  try {
    target = await resolveLtxTarget(url.searchParams.get("runId") || "", Number(url.searchParams.get("index")),
      url.searchParams.get("fingerprint") || "");
    if (target.request.media !== "video") throw new Error("Esta cena pede uma imagem, não um vídeo.");
  } catch {
    return NextResponse.json({ error: "A cena não foi encontrada ou mudou. Atualize a lista." }, { status: 409 });
  }
  if (!req.body) return NextResponse.json({ error: "Envie um arquivo MP4." }, { status: 400 });
  const contentLength = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "O vídeo precisa ter até 256 MB." }, { status: 413 });
  }
  if (await readyLtxScene(target.runDir, target.request) && req.headers.get("x-replace-existing") !== "true") {
    return NextResponse.json({ error: "Esta cena já tem um clipe. Marque a confirmação para substituí-lo." }, { status: 409 });
  }

  const dir = ltxSceneDir(target.runDir, target.request.index);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.import-${randomUUID()}.mp4`);
  let bytes = 0;
  try {
    const limitedBody = Readable.fromWeb(req.body as import("node:stream/web").ReadableStream<Uint8Array>).pipe(
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          callback(bytes > MAX_UPLOAD_BYTES ? new Error("O vídeo precisa ter até 256 MB.") : null, chunk);
        },
      }),
    );
    await pipeline(limitedBody, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
    if (bytes < 1000) throw new Error("O arquivo enviado está vazio ou incompleto.");
    await validateVideo(tempPath);
    await attachImportedLtxClip(target.runDir, target.request.index, target.request.fingerprint, tempPath);
    return NextResponse.json({ imported: true, ready: true, runId: target.runId, index: target.request.index });
  } catch (error) {
    const status = error instanceof Error && error.message.includes("até 256 MB") ? 413 : 400;
    return NextResponse.json({ error: status === 413
      ? "O vídeo precisa ter até 256 MB."
      : "Não foi possível importar. Envie um MP4 íntegro com uma faixa de vídeo de até 120 segundos." }, { status });
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

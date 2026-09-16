import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { ensureInit } from "@/lib/init";
import { uploadsDir, extForUpload, validateUploadedAudio } from "@/lib/services/voiceover-upload";

/**
 * VOICEOVER UPLOAD — stage a pre-recorded narration for a future run.
 *
 * The audio is sent as the RAW request body (not multipart) so it streams straight to
 * disk in constant memory — the same reason /api/avatar does it: a long WAV is easily
 * hundreds of MB, and buffering it via formData()/arrayBuffer() would spike the server's
 * heap by the full file size. Metadata (filename) comes via query params.
 *
 * This route ONLY stages and validates. It creates no run and starts no pipeline — a
 * rejection here costs nothing, which is the whole point of validating before the run
 * exists. Consuming the upload is a later stage.
 *
 * Success → 200 { uploadId, durationSec, sizeBytes, codec, sampleRateHz, channels }
 * Failure → 400 { error, reason }   (the staged file is deleted)
 */

export const runtime = "nodejs";
// Don't let the framework try to buffer/parse the (potentially huge) body for us.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  ensureInit();

  if (!req.body) {
    return NextResponse.json(
      { error: "No request body — send the audio file as the raw request body.", reason: "empty" },
      { status: 400 }
    );
  }

  const url = new URL(req.url);
  const filename = url.searchParams.get("filename");
  const uploadId = randomUUID();
  const stagedPath = path.join(uploadsDir(), `${uploadId}${extForUpload(filename)}`);

  // Stream to disk (constant memory, any size).
  try {
    const nodeStream = Readable.fromWeb(req.body as unknown as NodeWebReadableStream<Uint8Array>);
    await pipeline(nodeStream, fs.createWriteStream(stagedPath));
  } catch (e) {
    // A half-written file must never survive a failed transfer.
    try {
      fs.unlinkSync(stagedPath);
    } catch {}
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Failed to save the upload: ${msg}`, reason: "unreadable" }, { status: 500 });
  }

  const result = await validateUploadedAudio(stagedPath);
  if (!result.ok) {
    // Rejected uploads are not kept — nothing will ever consume them.
    try {
      fs.unlinkSync(stagedPath);
    } catch {}
    return NextResponse.json({ error: result.error, reason: result.reason }, { status: 400 });
  }

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(stagedPath).size;
  } catch {}

  return NextResponse.json({
    uploadId,
    durationSec: result.probe.durationSec,
    sizeBytes,
    codec: result.probe.codec,
    sampleRateHz: result.probe.sampleRateHz,
    channels: result.probe.channels,
  });
}

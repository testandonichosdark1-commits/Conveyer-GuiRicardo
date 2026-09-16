import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { runAvatarPipeline } from "@/lib/avatar-pipeline";
import { sanitizeFolderName, pickAvailableFolderName, getRunDir } from "@/lib/run-paths";
import { getPromptPreset } from "@/lib/prompts";

/**
 * AVATAR MODE — create a run from an uploaded talking-head MP4.
 *
 * The MP4 is sent as the RAW request body (not multipart) so it streams
 * straight to disk in constant memory — an hour-long HD avatar video can be
 * 1-2 GB+, and buffering that in RAM (formData/arrayBuffer) would OOM the
 * server. There is no upload size cap: it's a local app, the only limit is
 * the user's disk. Metadata (title, presetId) comes via query params.
 */

export const runtime = "nodejs";
// Don't let the framework try to buffer/parse the (huge) body for us.
export const dynamic = "force-dynamic";

const insertRun = db.prepare(
  "INSERT INTO runs (id, title, folder_name, status, script, config_json) VALUES (?, ?, ?, 'pending', ?, ?)"
);
const setPresetSnapshot = db.prepare(
  "UPDATE runs SET preset_id = ?, preset_name = ?, preset_content = ?, preset_animation_motion = ?, preset_image_prompt = ?, preset_voice_id = ? WHERE id = ?"
);
const setRunStatus = db.prepare("UPDATE runs SET status = ? WHERE id = ?");

export async function POST(req: Request) {
  ensureInit();

  if (!req.body) {
    return NextResponse.json(
      { error: "No request body — upload the MP4 as the raw request body." },
      { status: 400 }
    );
  }

  const url = new URL(req.url);
  const title = (url.searchParams.get("title") || "").trim() || null;
  const presetIdRaw = url.searchParams.get("presetId");
  const presetId = presetIdRaw ? Number(presetIdRaw) : null;

  const id = randomUUID();
  const baseFolderName = sanitizeFolderName(title ?? "", id.slice(0, 8));
  const folderName = pickAvailableFolderName(baseFolderName);

  // script column is NOT NULL — avatar runs have no script, store "".
  insertRun.run(id, title, folderName, "", JSON.stringify({ mode: "avatar" }));

  if (presetId && presetId > 0) {
    const preset = getPromptPreset(presetId);
    if (preset) {
      setPresetSnapshot.run(
        preset.id,
        preset.name,
        preset.content,
        preset.animation_motion,
        preset.image_prompt,
        preset.heygen_voice_id,
        id
      );
    }
  }

  // Stream the upload straight to disk (constant memory, any size).
  const runDir = getRunDir(id);
  fs.mkdirSync(runDir, { recursive: true });
  const videoPath = path.join(runDir, "avatar-input.mp4");
  try {
    const nodeStream = Readable.fromWeb(req.body as unknown as NodeWebReadableStream<Uint8Array>);
    await pipeline(nodeStream, fs.createWriteStream(videoPath));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setRunStatus.run("error", id);
    return NextResponse.json({ error: `Failed to save uploaded video: ${msg}` }, { status: 500 });
  }

  if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size === 0) {
    setRunStatus.run("error", id);
    return NextResponse.json({ error: "Uploaded video was empty." }, { status: 400 });
  }

  runAvatarPipeline(id, videoPath).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("avatar pipeline crash", e);
  });

  return NextResponse.json({ id, folderName });
}

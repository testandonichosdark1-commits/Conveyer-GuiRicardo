import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { runPipeline } from "@/lib/pipeline";
import { sanitizeFolderName, pickAvailableFolderName } from "@/lib/run-paths";
import { getPromptPreset } from "@/lib/prompts";
import { legacyRunVoiceId } from "@/lib/voice-select";

const insertRun = db.prepare(
  "INSERT INTO runs (id, title, folder_name, status, script, config_json) VALUES (?, ?, ?, 'pending', ?, ?)"
);
const setReuseMap = db.prepare(
  "UPDATE runs SET reuse_map_json = ? WHERE id = ?"
);
const setPresetSnapshot = db.prepare(
  "UPDATE runs SET preset_id = ?, preset_name = ?, preset_content = ?, preset_animation_motion = ?, preset_image_prompt = ?, preset_voice_id = ? WHERE id = ?"
);
// Keyset pagination for "Show more": newest-first, optional `before` cursor on
// created_at. Keyset (not OFFSET) stays correct as new runs arrive during polling.
// Soft-deleted runs (deleted_at set) are hidden from every listing.
const listRuns = db.prepare(
  "SELECT id, title, folder_name, status, degraded, created_at, updated_at, output_path, config_json FROM runs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?"
);
const listRunsBefore = db.prepare(
  "SELECT id, title, folder_name, status, degraded, created_at, updated_at, output_path, config_json FROM runs WHERE deleted_at IS NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?"
);

export async function GET(req: Request) {
  ensureInit();
  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 25;
  const before = url.searchParams.get("before");
  const rows = before ? listRunsBefore.all(before, limit) : listRuns.all(limit);
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  ensureInit();
  const body = (await req.json()) as {
    title?: string;
    script?: string;
    /** Optional: scene_index → drive_file_id. Pipeline downloads those instead of generating. */
    reuseMap?: Record<string, string>;
    /** Optional: Prompt Preset id (from /prompts presets). Snapshot is stored on the run. */
    presetId?: number | null;
    /** Optional: true = pipeline auto-searches the library; false = manual reuseMap only. */
    autoReuse?: boolean;
  };
  const script = (body.script ?? "").trim();
  if (!script) {
    return NextResponse.json({ error: "script is empty" }, { status: 400 });
  }

  const id = randomUUID();
  const baseFolderName = sanitizeFolderName(body.title ?? "", id.slice(0, 8));
  const folderName = pickAvailableFolderName(baseFolderName);

  // Per-run config. autoReuse: true = pipeline auto-searches the Drive library
  // for reusable clips; false = use only the manually-picked reuseMap below.
  const config: Record<string, unknown> = {};
  if (typeof body.autoReuse === "boolean") config.autoReuse = body.autoReuse;
  insertRun.run(id, body.title ?? null, folderName, script, JSON.stringify(config));

  // Persist reuseMap so the pipeline can read it without callers passing options.
  // Keys are normalized to strings — they already are in JSON, but TS allowed
  // Record<number, string> in some call sites.
  if (body.reuseMap && typeof body.reuseMap === "object") {
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.reuseMap)) {
      if (typeof v === "string" && v.length > 0) normalized[String(k)] = v;
    }
    if (Object.keys(normalized).length > 0) {
      setReuseMap.run(JSON.stringify(normalized), id);
    }
  }

  // Snapshot the chosen channel profile (if any) onto the run row. We store the
  // content too, not just the id, so deleting the profile later doesn't break
  // re-runs / diagnostics. Snapshotted: scene_split content, optional
  // animation_motion override, optional image_prompt override, optional
  // per-channel HeyGen voice_id.
  if (typeof body.presetId === "number" && body.presetId > 0) {
    const preset = getPromptPreset(body.presetId);
    if (preset) {
      setPresetSnapshot.run(
        preset.id,
        preset.name,
        preset.content,
        preset.animation_motion,
        preset.image_prompt,
        // Legacy pipeline drives TTS_PROVIDER (HeyGen by default), where the
        // preset's HeyGen voice is the correct value. Kept as-is — only the
        // ElevenLabs studio path must avoid it.
        legacyRunVoiceId(preset),
        id
      );
    }
  }

  // Запускаємо пайплайн у фоні. На локалі цього досить.
  runPipeline(id, script).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("pipeline crash", e);
  });

  return NextResponse.json({ id, folderName });
}

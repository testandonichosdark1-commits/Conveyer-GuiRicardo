import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { runStudioPipeline } from "@/lib/studio-pipeline";
import { sanitizeFolderName, pickAvailableFolderName } from "@/lib/run-paths";
import { getPromptPreset } from "@/lib/prompts";
import { getAvatar } from "@/lib/avatars";
import { getChannel } from "@/lib/channels";
import { getSetting } from "@/lib/settings";
import { studioRunVoiceId } from "@/lib/voice-select";

export const runtime = "nodejs";

const insertRun = db.prepare(
  "INSERT INTO runs (id, title, folder_name, status, script, config_json) VALUES (?, ?, ?, 'pending', ?, ?)"
);
// NOTE: the studio pipeline narrates with ElevenLabs, so the preset snapshot must
// NOT carry the preset's HeyGen voice (a HeyGen id sent to ElevenLabs →
// voice_not_found). preset_voice_id is set separately, only from the channel's
// ElevenLabs voice, via setVoiceSnapshot / studioRunVoiceId.
const setPresetSnapshot = db.prepare(
  "UPDATE runs SET preset_id = ?, preset_name = ?, preset_content = ?, preset_animation_motion = ?, preset_image_prompt = ? WHERE id = ?"
);
const setVoiceSnapshot = db.prepare("UPDATE runs SET preset_voice_id = ? WHERE id = ?");
const setAvatarSnapshot = db.prepare(
  "UPDATE runs SET avatar_db_id = ?, avatar_engine = ?, avatar_heygen_id = ?, avatar_image_key = ?, avatar_use_iv = ?, avatar_motion_prompt = ? WHERE id = ?"
);

interface Body {
  script?: string;
  title?: string;
  avatarId?: number | null;
  channelId?: number | null;
  presetId?: number | null;
  visualMode?: "ai" | "real" | "mix";
  secondsPerVisual?: number;
  avatarPercent?: number;
  realPercent?: number;
  aiStyle?: string;
  visualPrompt?: string;
  sceneTransitions?: boolean;
  footageSourceTiers?: string | null;
}

export async function POST(req: Request) {
  ensureInit();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const script = (body.script || "").trim();
  if (!script) return NextResponse.json({ error: "Script is required." }, { status: 400 });

  // Channel supplies defaults (mode / interval / style / default avatar) that the
  // explicit body overrides.
  const channel = body.channelId ? getChannel(Number(body.channelId)) : null;

  // Resolve the avatar (explicit pick, else the channel's default). An explicit
  // pick that isn't ready is a hard error; a stale channel-default just degrades
  // to a faceless run rather than blocking every video on that channel.
  const explicit = body.avatarId != null;
  const avatarId = body.avatarId ?? channel?.avatar_id ?? null;
  let avatar = null;
  if (avatarId) {
    const found = getAvatar(Number(avatarId));
    const ready = found && found.status === "ready" && found.heygen_id;
    if (!ready) {
      if (explicit) {
        const reason = !found ? "introuvable" : `pas encore prêt (statut : ${found.status})`;
        return NextResponse.json(
          { error: `L'avatar sélectionné est ${reason}. Attendez qu'il soit prêt.` },
          { status: 409 }
        );
      }
      // Channel default is missing/not-ready → continue without an avatar.
      avatar = null;
    } else {
      avatar = found;
    }
  }

  const id = randomUUID();
  const baseFolder = sanitizeFolderName(body.title ?? "", id.slice(0, 8));
  const folderName = pickAvailableFolderName(baseFolder);

  const config = {
    mode: "studio",
    visualMode: body.visualMode ?? channel?.visual_mode ?? "mix",
    // Seconds-per-visual has a SINGLE source: the on-screen Create Video control
    // (itself seeded from the global SECONDS_PER_VISUAL on load). The channel no longer
    // overrides it — that was a hidden, non-UI-editable override. Resolve to a concrete
    // number: explicit body → global setting → hardcoded 4.5.
    secondsPerVisual: body.secondsPerVisual ?? (Number(getSetting("SECONDS_PER_VISUAL")) || 4.5),
    avatarPercent: body.avatarPercent,
    realPercent: body.realPercent ?? channel?.real_ratio_percent ?? undefined,
    aiStyle: body.aiStyle ?? channel?.ai_style ?? undefined,
    visualPrompt: body.visualPrompt ?? channel?.visual_prompt ?? undefined,
    format: channel?.format,
    channelId: channel?.id,
    sceneTransitions: typeof body.sceneTransitions === "boolean" ? body.sceneTransitions : undefined,
    footageSourceTiers: body.footageSourceTiers ?? channel?.footage_source_tiers ?? undefined,
  };

  insertRun.run(id, body.title?.trim() || null, folderName, script, JSON.stringify(config));

  if (body.presetId) {
    const preset = getPromptPreset(Number(body.presetId));
    if (preset) {
      setPresetSnapshot.run(
        preset.id,
        preset.name,
        preset.content,
        preset.animation_motion,
        preset.image_prompt,
        id
      );
    }
  }

  if (avatar) {
    setAvatarSnapshot.run(
      avatar.id,
      avatar.engine,
      avatar.heygen_id,
      avatar.image_key,
      avatar.use_avatar_iv,
      avatar.motion_prompt,
      id
    );
  }

  // Per-channel ElevenLabs narration voice — the ONLY source of preset_voice_id for
  // the studio pipeline (never a preset's HeyGen voice). null → the pipeline uses
  // the global ELEVENLABS_VOICE_ID.
  const studioVoice = studioRunVoiceId(channel);
  if (studioVoice) {
    setVoiceSnapshot.run(studioVoice, id);
  }

  runStudioPipeline(id, script).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("studio pipeline crash", e);
  });

  return NextResponse.json({ id, folderName });
}

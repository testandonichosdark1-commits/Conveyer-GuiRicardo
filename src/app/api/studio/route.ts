import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { runStudioPipeline } from "@/lib/studio-pipeline";
import { failRun } from "@/lib/run-lifecycle";
import { sanitizeFolderName, pickAvailableFolderName } from "@/lib/run-paths";
import { getPromptPreset } from "@/lib/prompts";
import { getAvatar } from "@/lib/avatars";
import { verifyHeygenAvatar, checkAvatarVSupport } from "@/lib/services/heygen-avatar";
import { getChannel } from "@/lib/channels";
import { getSetting } from "@/lib/settings";
import { resolveStagedUpload } from "@/lib/services/voiceover-upload";
import { studioRunVoiceId, studioRunSpeed, studioRunAi84Model } from "@/lib/voice-select";
import { resolveAi84Backend } from "@/lib/services/ai84-voice-engine";
import type { Ai84Backend } from "@/lib/providers";
import { missingVoiceRefusal } from "@/lib/voice-preflight";

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
// Per-channel voiceover-speed override snapshot (NULL → global TTS_SPEED), mirroring setVoiceSnapshot.
const setSpeedSnapshot = db.prepare("UPDATE runs SET voice_speed = ? WHERE id = ?");
// TTS model this run was created with (NULL → the provider reads its global setting).
const setModelSnapshot = db.prepare("UPDATE runs SET voice_model = ? WHERE id = ?");
const setAvatarSnapshot = db.prepare(
  "UPDATE runs SET avatar_db_id = ?, avatar_engine = ?, avatar_heygen_id = ?, avatar_image_key = ?, avatar_use_iv = ?, avatar_motion_prompt = ?, avatar_api_engine = ? WHERE id = ?"
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
  /** Share of the AI beats to generate as video rather than stills, 0–100. Sent only
   * when AI media = "auto"; omitted = the planner decides per beat (unchanged behavior). */
  aiVideoPercent?: number;
  aiStyle?: string;
  visualPrompt?: string;
  sceneTransitions?: boolean;
  /** Informational Overlays toggle (Create Video). Default OFF. */
  overlays?: boolean;
  /** Real Footage fallback behavior — "strict" = never generate AI ("real" mode only). */
  realFallback?: "ai" | "strict";
  /**
   * Id from POST /api/uploads/voiceover — use that already-recorded narration INSTEAD of
   * synthesizing one from `script`. Mutually exclusive with `script`. Absent = today's
   * script→TTS flow, unchanged.
   */
  voiceoverUploadId?: string;
  /**
   * Voice for THIS video. Beats the channel's voice; absent, the run uses the channel's (or
   * the global setting), which is what every video does today.
   *
   * API-ONLY — our own create page does not send it. It briefly had a voice picker, but the
   * per-channel voice turned out to cover the need it was built for (two videos narrating
   * with different voices, on different AI84 engines, at the same time) without putting a
   * control on the front page that shows an error whenever a provider's voice catalogue is
   * unreachable. The field stays because it works when called and it is the seam that would
   * bring that picker back as a one-file change — the same shape as a channel's default
   * avatar, which is likewise settable only through the API.
   */
  voiceId?: string;
  /**
   * Which AI84 engine `voiceId` came from. A closed enum, never a model string: the model is
   * derived server-side from the catalog, so a client cannot ask for an arbitrary one.
   * Anything unrecognised is ignored as if absent.
   *
   * Purely an optimization — omit it and the engine is resolved from the voice itself. It
   * exists so a caller that already knows the engine can skip that lookup.
   */
  voiceBackend?: string;
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
  const uploadId = (body.voiceoverUploadId || "").trim();

  // A run needs exactly ONE narration source. With no upload id this is byte-identical to
  // the original check — same condition, same message, same status — so an existing
  // script-mode client cannot tell the difference.
  if (!script && !uploadId) return NextResponse.json({ error: "Script is required." }, { status: 400 });
  if (script && uploadId) {
    return NextResponse.json(
      { error: "Provide either a script or an uploaded voiceover, not both." },
      { status: 400 }
    );
  }

  // Resolve the upload BEFORE the run row exists: a refusal here costs nothing.
  let voiceoverPath: string | null = null;
  if (uploadId) {
    voiceoverPath = resolveStagedUpload(uploadId);
    if (!voiceoverPath) {
      return NextResponse.json(
        { error: "That uploaded voiceover is no longer available — please upload it again." },
        { status: 400 }
      );
    }
    // An uploaded voiceover has no script to time against, so Whisper is the ONLY way to
    // place visuals. Refuse now rather than after the run row (and its avatar checks) exist.
    if (!getSetting("GROQ_API_KEY").trim()) {
      return NextResponse.json(
        {
          error:
            "Uploading a voiceover requires a Groq API key for transcription — add GROQ_API_KEY in Settings, or paste a script instead.",
        },
        { status: 409 }
      );
    }
  }

  // Channel supplies defaults (mode / interval / style / default avatar) that the
  // explicit body overrides.
  const channel = body.channelId ? getChannel(Number(body.channelId)) : null;

  // The voice this run will actually use: chosen for this video → channel's → null (the
  // provider's global setting). Resolved BEFORE the pre-flight, so a voice picked on the
  // create page counts as "this run has a voice" — otherwise we would refuse a run the
  // operator has explicitly configured.
  const explicitVoiceId = (body.voiceId || "").trim() || null;
  const runVoiceId = studioRunVoiceId(channel, explicitVoiceId);

  // Pre-flight: does this run have a voice at all? Script mode only — an uploaded
  // voiceover synthesizes nothing, so a missing TTS voice is irrelevant to it. Costs
  // nothing, asks nothing over the network, and turns a guaranteed mid-run death (every
  // provider's TTS throws on a blank voice, but only after the run row and possibly a
  // billable job exist) into a refusal with no run and no spend. See lib/voice-preflight.ts.
  if (!uploadId) {
    const noVoice = missingVoiceRefusal(getSetting("VOICEOVER_PROVIDER"), runVoiceId, getSetting);
    if (noVoice) return NextResponse.json({ error: noVoice }, { status: 409 });
  }

  // Resolve the avatar (explicit pick, else the channel's default). An explicit
  // pick that isn't ready is a hard error; a stale channel-default just degrades
  // to a faceless run rather than blocking every video on that channel.
  const explicit = body.avatarId != null;
  const avatarId = body.avatarId ?? channel?.avatar_id ?? null;
  let avatar = null;
  if (avatarId) {
    const found = getAvatar(Number(avatarId));
    // Stage 2 renders Avatar V on v3, so the Stage-1 refusal is gone: an Avatar V avatar
    // is now as renderable as any other. What replaces it is the eligibility re-check
    // below — support is per-avatar, mutable, and must never be assumed from the fact
    // that we stored "avatar_v" at import time.
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

  /**
   * Pre-flight: the avatar is "ready" in OUR database, but does it still exist on
   * HeyGen? Those are different questions, and we learned the difference the hard way —
   * an avatar was deleted on HeyGen's side while its row stayed `ready` here, so every
   * avatar beat 404'd ("avatar look not found"), each one silently degraded to b-roll,
   * and the run reported success. The operator got a faceless video and a green tick.
   *
   * Checking here — before the voiceover is synthesized and paid for — turns that into
   * a refusal that costs nothing and says what to do about it.
   *
   * Failing OPEN is deliberate, and mirrors verifyHeygenAvatar's existing contract:
   * only `checked && !engine` means "HeyGen definitively does not have this". A network
   * hiccup or a bad key yields `checked: false`, and must never block a run that would
   * otherwise have rendered — this check exists to catch a certainty, not to add a new
   * way for runs to fail.
   */
  if (avatar?.heygen_id) {
    const live = await verifyHeygenAvatar(avatar.heygen_id);
    if (live.checked && !live.engine) {
      if (explicit) {
        return NextResponse.json(
          {
            error:
              `L'avatar « ${avatar.name} » n'existe plus sur votre compte HeyGen — il y a été supprimé. ` +
              `Recréez-le dans Avatars, ou choisissez-en un autre. ` +
              `(Sans cela, la vidéo serait générée sans avatar.)`,
          },
          { status: 409 }
        );
      }
      // Channel default vanished → degrade to a faceless run, exactly as this route
      // already does for a stale/deleted default. It must not block the channel.
      avatar = null;
    }
  }

  /**
   * Avatar V eligibility — ONE live check per execution, never a cached answer.
   *
   * `avatars.api_engine` is the operator's INTENT; it is not evidence that HeyGen still
   * grants Avatar V for this avatar. Support is per-avatar and mutable, and HeyGen
   * documents no rule for how it is granted, so the only trustworthy source is
   * supported_api_engines, right now.
   *
   * Here is the last moment this costs nothing: after this, /api/studio creates the run
   * and the pipeline synthesizes the voiceover. Without the check, an avatar that lost
   * Avatar V would fail on every beat AFTER the voiceover was paid for, and degrade to a
   * faceless video. We refuse instead — and never quietly render it on Avatar IV, which
   * would be a different engine at a different price than the one that was chosen.
   *
   * Unlike the existence pre-flight above, this does NOT fail open: `checkAvatarVSupport`
   * returns ok:false when it cannot get a definitive answer, and proceeding on a guess is
   * exactly the substitution this exists to prevent. Resume runs the same check itself —
   * it re-enters the pipeline without passing through this route.
   */
  if (avatar?.heygen_id && avatar.api_engine === "avatar_v") {
    const cap = await checkAvatarVSupport(avatar.heygen_id);
    if (!cap.ok || !cap.supported) {
      const why = !cap.ok
        ? `Impossible de vérifier la compatibilité Avatar V (${cap.error}).`
        : `L'avatar « ${avatar.name} » ne prend plus en charge Avatar V sur votre compte HeyGen.`;
      if (explicit) {
        return NextResponse.json(
          { error: `${why} La vidéo n'a pas été lancée — aucun coût engagé. Choisissez un autre avatar, ou réessayez.` },
          { status: 409 }
        );
      }
      // Channel default is no longer eligible → faceless, as for any unusable default.
      // Never silently downgrade it to Avatar IV: that is a different engine and price.
      avatar = null;
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
    realPercent: body.realPercent,
    // Spread-in only when actually sent, like `overlays` below: a run created without a
    // photo/video ratio keeps a byte-identical config_json, so nothing about existing
    // clients or their resumes changes.
    ...(Number.isFinite(Number(body.aiVideoPercent))
      ? { aiVideoPercent: Math.max(0, Math.min(100, Number(body.aiVideoPercent))) }
      : {}),
    aiStyle: body.aiStyle ?? channel?.ai_style ?? undefined,
    visualPrompt: body.visualPrompt ?? channel?.visual_prompt ?? undefined,
    format: channel?.format,
    channelId: channel?.id,
    sceneTransitions: typeof body.sceneTransitions === "boolean" ? body.sceneTransitions : undefined,
    // Overlays default OFF. Added to config_json ONLY when explicitly true, so a run
    // created without it (every existing client) has a byte-identical config_json.
    ...(body.overlays === true ? { overlays: true as const } : {}),
    // Real Footage fallback behavior. Snapshotted per-run (not a global setting) so a
    // Resume replays the mode the run was created with. Only "strict" opts in.
    realFallback: body.realFallback === "strict" ? "strict" : "ai",
    // Provenance only — added ONLY for upload runs, so a script run's config_json stays
    // byte-identical to what it was before this feature existed. Nothing branches on it
    // (the pipeline is told the path directly); it exists so a run can be identified later.
    ...(voiceoverPath ? { voiceoverSource: "upload" as const } : {}),
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
      // Snapshotted, not read live at render time: (engine='talking_photo',
      // use_iv=NULL) is identical for Avatar V and Legacy, so this is the ONLY thing
      // that tells a resumed run which engine it was created with. Reading it live
      // would render on whatever the avatar row says NOW — or on v2 if the row is gone.
      avatar.api_engine,
      id
    );
  }

  // The narration voice for this run — chosen on the create page, else the channel's
  // (never a preset's HeyGen voice). null → the pipeline uses the provider's global
  // setting, exactly as before.
  const studioVoice = runVoiceId;
  if (studioVoice) {
    setVoiceSnapshot.run(studioVoice, id);
  }

  // Per-channel voiceover speed — snapshot at create so the run is stable if the
  // channel is edited later (mirrors the voice snapshot). null → global TTS_SPEED.
  const studioSpeed = studioRunSpeed(channel);
  if (studioSpeed != null) {
    setSpeedSnapshot.run(studioSpeed, id);
  }

  // The engine this video runs on. AI84's engine is chosen by the model, and the model is a
  // global setting read at synthesis time — so without a per-run value two concurrent runs
  // share one engine, and one global setting cannot serve an operator whose channels are
  // split across both.
  //
  // The engine follows the VOICE, whatever its source. The create page tags its pick, which
  // is free and already correct; anything else (a channel voice, the global one, an id typed
  // by hand) is resolved against AI84's own catalogues. Unknown → null → the global model
  // stays in charge, exactly as before.
  const bodyHint =
    body.voiceBackend === "minimax" || body.voiceBackend === "elevenlabs" ? body.voiceBackend : null;
  const provider = getSetting("VOICEOVER_PROVIDER");
  // The voice TTS will really be handed — including the global one, which is otherwise read
  // only inside ai84Tts.
  const voiceForEngine = runVoiceId || getSetting("AI84_VOICE_ID").trim() || null;
  let backendHint: Ai84Backend | null = bodyHint;
  if (!backendHint && provider.toLowerCase() === "ai84" && voiceForEngine) {
    // Fails open by contract, but the run must not die on an unforeseen throw either: the
    // engine is an optimization over the global setting, never a precondition for a video.
    backendHint = await resolveAi84Backend(getSetting("AI84_API_KEY"), voiceForEngine).catch(() => null);
  }
  const studioModel = studioRunAi84Model({
    provider,
    voiceId: voiceForEngine,
    backendHint,
    globalModel: getSetting("AI84_MODEL"),
  });
  if (studioModel) {
    setModelSnapshot.run(studioModel, id);
  }

  // Script mode passes undefined here, so the call is identical to before.
  runStudioPipeline(id, script, voiceoverPath ?? undefined).catch((e) => {
    // Backstop for a rejection that escaped the pipeline's own try/catch/finally
    // (e.g. a fault before the try, or in the catch/finally): mark the run failed
    // and release its lock in-process, so it isn't stuck until the next restart.
    const msg = e instanceof Error ? e.message : String(e);
    failRun(id, `Pipeline failed to start or crashed unexpectedly: ${msg}`);
    // eslint-disable-next-line no-console
    console.error("studio pipeline crash", e);
  });

  return NextResponse.json({ id, folderName });
}

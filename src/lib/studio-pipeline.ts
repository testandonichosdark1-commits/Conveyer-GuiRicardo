import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import db from "./db";
import { log } from "./logger";
import { getSetting, setChannelSettingOverrides, clearChannelSettingOverrides } from "./settings";
import { getChannel, channelSettingOverrides } from "./channels";
import { resolveFfmpeg, resolveFfprobe, assertFfmpegAvailable } from "./ffmpeg-bin";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { checkCancelled, clearCancelled, CancelledError } from "./cancellation";
import { APP_VERSION } from "./version";
import { synthesizeVoiceover } from "./services/elevenlabs-voiceover";
import { voiceoverFromFile } from "./services/voiceover-file";
import { planBeats, type Beat, type VideoStructure } from "./services/studio-plan";
import { acquireVisual, createTopicPool } from "./services/visual-source";
import { writeCredits, readCredits, creditFrom, type CreditEntry } from "./services/credits";
import { generateAvatarClip, type AvatarHandle } from "./services/heygen-video";
import { checkAvatarVSupport } from "./services/heygen-avatar";
import { assembleStudioVideo, sliceAudio, decodeToWav, type RenderBeat } from "./services/studio-assemble";
import { recordHeygenEngine } from "./services/cost-ledger";
import { rebuildSceneAssetsFromDisk, syncRunToDrive } from "./services/run-upload";
import type { HeygenEngine } from "./pricing";
import { beginRun, endRun } from "./run-lifecycle";
import { noteCreditExhausted } from "./services/credit-exhaustion";
import { joinDegraded, type DegradeCode } from "./degraded";
import { beginStoryblocksRun } from "./services/storyblocks";
import { FlowBrowserError } from "./services/flow-browser";

/**
 * With Google Flow as the AI provider, beats run ONE AT A TIME: a beat only starts once the
 * previous one has finished with a result — from whichever source produced it (Flow Pro,
 * Flow 2, Cloudflare, Pollinations, Meta Muse, kie.ai). Otherwise a beat falling back to
 * another provider frees its slot and the next beat starts while the first is still working,
 * which is the overlap the operator asked to remove. Other providers keep VISUAL_CONCURRENCY.
 */
function visualConcurrency(): number {
  if ((getSetting("AI_PROVIDER") || "").toLowerCase() === "flow_browser") return 1;
  return Math.max(1, Number(getSetting("VISUAL_CONCURRENCY") || "3"));
}

/**
 * A FlowBrowserError with code "capture" means this ONE beat exhausted every source it
 * was allowed — Flow itself, and (when FLOW_FALLBACK_PROVIDER is configured) its kie.ai
 * fallback too — the exact "this provider produced nothing" outcome every other AI
 * provider (kie/Cloudflare/Pollinations/Meta) already degrades from below: log a warning
 * and let the beat reuse the nearest good neighbour instead of a black frame. Every other
 * code (login/credits/config/ui/timeout) only reaches here when the operator explicitly
 * disabled the fallback (strict Flow-only mode) — "never reuse an unrelated image" is
 * still honored for THAT case by failing the whole run closed, same as before.
 *
 * Before this distinction existed, every FlowBrowserError aborted the run outright —
 * including "capture", so a single beat losing both Flow and its configured kie.ai
 * fallback (a transient, single-beat hiccup) could crash a run over an hour into
 * rendering, discarding every beat already finished. See CLAUDE.md's Flow browser section.
 */
function isFlowBeatExhausted(e: FlowBrowserError): boolean {
  return e.code === "capture" || e.code === "policy";
}

/**
 * AVATAR DOCUMENTARY pipeline.
 *
 *   script → ElevenLabs voiceover (+ word timings) → beats → per beat:
 *     real/AI b-roll (Ken Burns on stills) + a HeyGen avatar clip on avatar
 *     beats → composite over the one voiceover → final.mp4.
 *
 * See docs/DESIGN.md for the full design and confirmed API shapes.
 */

const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);
/**
 * Records what the run actually delivered ('avatar_all' | 'avatar_partial' | NULL).
 * Always written on completion, NULL included: a Resume that finally renders the
 * avatar must CLEAR an earlier degrade, or the run would keep warning about a
 * problem it no longer has.
 */
const setDegraded = db.prepare("UPDATE runs SET degraded = ? WHERE id = ?");
const setStructure = db.prepare("UPDATE runs SET structure_json = ? WHERE id = ?");
// Cost Monitoring — final video length, persisted once at completion (cost/min).
const setDuration = db.prepare("UPDATE runs SET duration_sec = ? WHERE id = ?");
const getConfigStmt = db.prepare("SELECT config_json FROM runs WHERE id = ?");
const getAvatarSnapStmt = db.prepare(
  "SELECT avatar_db_id, avatar_engine, avatar_heygen_id, avatar_image_key, avatar_use_iv, avatar_motion_prompt, avatar_api_engine FROM runs WHERE id = ?"
);
const getVoiceSnapStmt = db.prepare("SELECT preset_voice_id, voice_speed, voice_model FROM runs WHERE id = ?");
const getTitleStmt = db.prepare("SELECT title FROM runs WHERE id = ?");

interface StudioConfig {
  visualMode: "ai" | "real" | "mix";
  secondsPerVisual: number;
  avatarPercent: number;
  realPercent: number;
  /** Share of the AI beats to render as generated video, 0–100. Sent only when the
   * operator picked AI media = "auto"; undefined = the planner decides per beat, which
   * is what every run created before this feature replays on Resume. */
  aiVideoPercent: number | undefined;
  aiStyle: string | undefined;
  format: string | undefined;
  visualPrompt: string | undefined;
  /** Per-run dip-to-black toggle (Create Video → Advanced). undefined → global default. */
  sceneTransitions: boolean | undefined;
  /** Per-run Informational Overlays toggle (Create Video). Default OFF. When not true,
   * the planner request and the assembly are byte-identical to before this feature. */
  overlays: boolean | undefined;
  /**
   * Real Footage fallback behavior (Create Video → Advanced), "real" mode only.
   * "ai" (default) = today's behavior: a beat with no good real match falls back to AI.
   * "strict" = Real footage only — never generate AI for this run's real beats.
   * Snapshotted here rather than read from settings so Resume can't flip a finished
   * run's mode mid-video (config_json is what resumeStudioPipeline replays).
   */
  realFallback: "ai" | "strict";
  /** The channel this run was created with (config_json.channelId, snapshotted at
   *  /api/studio create-time). Re-resolved live at pipeline start (not itself
   *  snapshotted) so a channel's API-key/voice-provider/character-reference overrides
   *  edited AFTER the run was created still apply on Resume — unlike the avatar
   *  snapshot, these are account-config, not a billable choice that must stay pinned. */
  channelId: number | undefined;
}

function readConfig(runId: string): StudioConfig {
  const row = getConfigStmt.get(runId) as { config_json: string | null } | undefined;
  let cfg: Partial<StudioConfig> & { mode?: string } = {};
  try {
    cfg = row?.config_json ? JSON.parse(row.config_json) : {};
  } catch {}
  const visualMode = (cfg.visualMode as StudioConfig["visualMode"]) || "mix";
  const realFromMode = visualMode === "ai" ? 0 : visualMode === "real" ? 100 : undefined;
  return {
    visualMode,
    secondsPerVisual: Number(cfg.secondsPerVisual) || Number(getSetting("SECONDS_PER_VISUAL") || "4.5"),
    avatarPercent: cfg.avatarPercent != null ? Number(cfg.avatarPercent) : Number(getSetting("AVATAR_FREQUENCY_PERCENT") || "15"),
    realPercent: realFromMode ?? (cfg.realPercent != null ? Number(cfg.realPercent) : Number(getSetting("REAL_RATIO_PERCENT") || "80")),
    aiVideoPercent:
      cfg.aiVideoPercent != null && Number.isFinite(Number(cfg.aiVideoPercent))
        ? Math.max(0, Math.min(100, Number(cfg.aiVideoPercent)))
        : undefined,
    aiStyle: typeof cfg.aiStyle === "string" && cfg.aiStyle.trim() ? cfg.aiStyle.trim() : undefined,
    format: typeof cfg.format === "string" && /^\d+\s*[x×]\s*\d+$/i.test(cfg.format) ? cfg.format.trim() : undefined,
    visualPrompt: typeof cfg.visualPrompt === "string" && cfg.visualPrompt.trim() ? cfg.visualPrompt.trim() : undefined,
    sceneTransitions: typeof cfg.sceneTransitions === "boolean" ? cfg.sceneTransitions : undefined,
    // Only "strict" opts in; anything else (missing, unknown, older runs) = today's AI fallback.
    realFallback: cfg.realFallback === "strict" ? "strict" : "ai",
    // Overlays default OFF: only an explicit `true` opts in. Missing/older runs → undefined,
    // which the pipeline treats exactly as OFF (byte-identical planning + assembly).
    overlays: cfg.overlays === true ? true : undefined,
    channelId: Number.isFinite(Number((cfg as { channelId?: unknown }).channelId))
      ? Number((cfg as { channelId?: unknown }).channelId)
      : undefined,
  };
}

/**
 * Establishes this run's channel overrides (API keys / voice provider / character
 * reference) for the REST of this async execution — see settings.ts's
 * setChannelSettingOverrides doc comment for how that propagates with zero changes to
 * every provider file that calls getSetting(). Called once, right after readConfig, on
 * BOTH the fresh-run and Resume paths — Resume re-enters the pipeline without going
 * through /api/studio, so it must re-establish the context itself, exactly like the
 * Avatar-V eligibility and avatar-existence checks already re-check live on Resume.
 * A run with no channel gets an explicit empty override map (never a stale one).
 */
function activateChannelOverrides(cfg: StudioConfig): void {
  const channel = cfg.channelId != null ? getChannel(cfg.channelId) : null;
  const overrides = channelSettingOverrides(channel);
  if (Object.keys(overrides).length) setChannelSettingOverrides(overrides);
  else clearChannelSettingOverrides();
}

/**
 * Real-footage-only is armed for a "real"- OR "mix"-mode run that asked for it. In mix it
 * governs ONLY the beats the planner assigned to real footage — acquireVisual gates on
 * `beat.source === "real"`, so the AI share of the mix is untouched and blending still works.
 * "ai" mode has no real beats to protect, so it can never arm.
 *
 * Mix is where this earns its keep: when a real-assigned beat finds nothing above the bar it
 * falls to AI, and if AI is unavailable (out of credits, no key) the beat ends up REUSING A
 * NEIGHBOURING SHOT. One operator shipped a video with a third of its scenes duplicated that
 * way while 65%-scoring real clips of the exact subject sat discarded. Strict spends those
 * instead — a slightly-off real shot beats the same picture three times in a row.
 */
function strictRealFor(cfg: StudioConfig): boolean {
  return (cfg.visualMode === "real" || cfg.visualMode === "mix") && cfg.realFallback === "strict";
}

/**
 * What the run delivered, as a stored code. NULL = as planned.
 *
 * `dropped >= planned` rather than `===`: the two are counted at different moments and
 * a future change could make dropped overshoot. "All of them failed" must not fall
 * through to the milder "some of them" just because a count drifted.
 */
export function degradeCode(dropped: number, planned: number): "avatar_all" | "avatar_partial" | null {
  if (dropped <= 0) return null;
  return dropped >= planned ? "avatar_all" : "avatar_partial";
}

/**
 * Everything this run failed to deliver, as the stored value.
 *
 * The avatar verdict above is one input, not the whole answer: a run can also come back
 * without the text cards the operator switched on (a client hit exactly that — their Gemini
 * key was out of quota, the plan produced no cards, and the run still reported a clean
 * "done"). The failures are independent, so they are collected rather than ranked.
 *
 * `overlaysMissing` is decided by the CALLER from the rendered beats, not guessed here — a
 * run that never asked for overlays must never be marked for not having them.
 */
export function degradeCodes(dropped: number, planned: number, overlaysMissing: boolean): string | null {
  const codes: DegradeCode[] = [];
  const avatar = degradeCode(dropped, planned);
  if (avatar) codes.push(avatar);
  if (overlaysMissing) codes.push("overlays_missing");
  return joinDegraded(codes);
}

/**
 * Did the operator ask for text cards and get none?
 *
 * Reads the SAME condition the assembler acts on (`beats.some(b => b.overlay)`), so the badge
 * can never disagree with the delivered file. Overlays off → always false.
 */
export function overlaysWereLost(overlaysRequested: boolean | undefined, beats: { overlay?: unknown }[]): boolean {
  return overlaysRequested === true && !beats.some((b) => b.overlay);
}

/**
 * Decode the snapshotted avatar TYPE.
 *
 * This used to be `x === "photo_avatar_group" ? … : "talking_photo"` — an `else` that
 * silently turned ANY unrecognized type into a talking photo, rendering (and billing)
 * on something nobody chose.
 *
 * So: fail loudly instead. A run that can't be rendered correctly must stop, not
 * improvise. (Avatar V is NOT a value here — it's the render ENGINE, and lives in
 * `avatar_api_engine`; see decodeApiEngine.)
 */
export function decodeEngine(raw: string | null): AvatarHandle["engine"] {
  if (raw === "talking_photo" || raw === "photo_avatar_group") return raw;
  throw new Error(`Unknown avatar engine "${raw}" on this run — refusing to guess how to render it.`);
}

function readAvatar(runId: string): (AvatarHandle & { dbId: number }) | null {
  const row = getAvatarSnapStmt.get(runId) as
    | {
        avatar_db_id: number | null;
        avatar_engine: string | null;
        avatar_heygen_id: string | null;
        avatar_image_key: string | null;
        avatar_use_iv: string | null;
        avatar_motion_prompt: string | null;
        avatar_api_engine: string | null;
      }
    | undefined;
  if (!row?.avatar_db_id || !row.avatar_heygen_id) return null;
  return {
    dbId: row.avatar_db_id,
    engine: decodeEngine(row.avatar_engine),
    heygenId: row.avatar_heygen_id,
    imageKey: row.avatar_image_key,
    useAvatarIv: row.avatar_use_iv === "1",
    motionPrompt: row.avatar_motion_prompt,
    apiEngine: decodeApiEngine(row.avatar_api_engine),
  };
}

/**
 * Decode the snapshotted render engine. Strict, like decodeEngine: an unrecognized
 * value must NOT quietly become "not Avatar V", because that renders on v2 — a
 * different engine, a different price, and exactly the silent substitution the whole
 * feature is built to avoid. NULL is the only legitimate "v2" answer.
 */
export function decodeApiEngine(raw: string | null): "avatar_v" | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw === "avatar_v") return "avatar_v";
  throw new Error(`Unknown avatar api_engine "${raw}" on this run — refusing to guess which engine to render with.`);
}

/** The engine this run bills at — the one it actually renders with. */
export function billingEngine(avatar: Pick<AvatarHandle, "apiEngine" | "useAvatarIv">): HeygenEngine {
  if (avatar.apiEngine === "avatar_v") return "avatar_v";
  return avatar.useAvatarIv ? "avatar_iv" : "unlimited";
}

/**
 * Upload a FINISHED studio run to Google Drive — the same `syncRunToDrive` the legacy
 * pipeline and the manual "Upload to Google Drive" button already use. No upload logic
 * lives here: the GDRIVE_SYNC_ENABLED gate, the Drive-client check, folder creation,
 * clips.json/description.md, the final-video upload, the Drive-id columns and the local
 * cleanup are all that function's, untouched.
 *
 * Studio runs previously never called it at all, so auto-upload was silently inert for
 * the pipeline that renders every video this product makes — the toggle could be on,
 * Drive connected, and nothing would ever appear.
 *
 * Two deliberate details:
 *
 *  - **Best-effort**, exactly like the legacy call sites: a Drive failure is logged and
 *    swallowed. The video is already rendered and marked `done`; a failed upload must
 *    never turn a successful render into a failed run. The local files are all still
 *    there, and the manual button can retry.
 *
 *  - `rebuildSceneAssetsFromDisk` is the SAME source of scene assets the manual
 *    `POST /api/runs/[id]/drive` route uses. For a studio run it returns `[]` today —
 *    it looks for the legacy `scenes.json` + `animations/`, and studio runs write
 *    `beats.json` + `broll/`. That is Bug #2 (studio raw clips), deliberately NOT fixed
 *    here. Calling it anyway rather than hardcoding `[]` means the auto and manual paths
 *    stay identical, and whenever that helper is taught the studio layout BOTH start
 *    uploading clips with no further change. With `[]` the upload is the final video +
 *    manifest, which is exactly what the manual button produces for a studio run today.
 */
export async function syncFinishedRunToDrive(runId: string, runDir: string, finalPath: string): Promise<void> {
  try {
    await syncRunToDrive(runId, rebuildSceneAssetsFromDisk(runDir), runDir, finalPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Drive sync failed (local files preserved): ${msg}`, { stage: "gdrive" });
  }
}

/**
 * One live Avatar V eligibility check, for an execution that did NOT come through
 * /api/studio (i.e. Resume). Throws — failing the run — rather than rendering on
 * another engine: an ineligible avatar would 400 on every beat anyway, and "fall back
 * to Avatar IV" would silently deliver a different engine at a different price.
 *
 * No-op for v2 runs, so the resume path is untouched for Avatar IV / Legacy.
 */
async function assertAvatarVStillEligible(runId: string, avatar: AvatarHandle | null): Promise<void> {
  if (avatar?.apiEngine !== "avatar_v") return;
  const cap = await checkAvatarVSupport(avatar.heygenId);
  if (cap.ok && cap.supported) {
    log(runId, "info", "Avatar V still supported for this avatar — resuming", { stage: "avatar_video" });
    return;
  }
  throw new Error(
    cap.ok
      ? "This avatar no longer supports Avatar V on your HeyGen account, so this run cannot be resumed as it was created. Nothing was regenerated. Create a new video with an eligible avatar."
      : `Could not verify Avatar V support before resuming (${cap.error}). Nothing was regenerated — try again.`
  );
}

/**
 * @param voiceoverUploadPath  When set, the operator supplied a finished narration and
 *   `script` is empty: the voiceover is INGESTED from this file instead of synthesized.
 *   That is the only difference between the two modes — planning, avatar rendering,
 *   visual acquisition and assembly below are shared verbatim. Omitted (script mode) every
 *   branch it guards is skipped, so the path through this function is unchanged.
 */
export async function runStudioPipeline(
  runId: string,
  script: string,
  voiceoverUploadPath?: string
): Promise<void> {
  const runDir = getRunDir(runId);
  const audioDir = path.join(runDir, "audio");
  const brollDir = path.join(runDir, "broll");
  const avatarDir = path.join(runDir, "avatar");
  for (const d of [runDir, audioDir, brollDir, avatarDir]) fs.mkdirSync(d, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);
    beginRun(runId); // claim ownership + take the in-process lock (blocks duplicate Resume)
    // Reset the PAID Storyblocks download budget. Must happen per run (including on
    // Resume), or a resumed run would inherit the previous run's spent counter — and,
    // worse, a process that never called this keeps the cap at 0 and the source stays
    // silently dead. No-op when Storyblocks isn't configured.
    beginStoryblocksRun();
    // Phase 0 — per-stage timing baseline (additive, observability only; no
    // behavior/concurrency change). Stage marks are taken at each stage boundary
    // and summarized in one PERF log line at the end.
    const tStart = Date.now();
    const cfg = readConfig(runId);
    activateChannelOverrides(cfg);
    const strictReal = strictRealFor(cfg);
    const avatar = readAvatar(runId);
    log(
      runId,
      "info",
      `Pipeline started (v${APP_VERSION}) · mode=${cfg.visualMode} · ${cfg.secondsPerVisual}s/visual · avatar=${avatar ? `${cfg.avatarPercent}%` : "none"} · real=${cfg.realPercent}%${strictReal ? " · real-footage-only (never AI)" : ""}`,
      { stage: "pipeline" }
    );

    // An uploaded voiceover legitimately has no script; otherwise this is the original guard.
    if (!voiceoverUploadPath && !script.trim()) {
      throw new Error("Script is empty — paste a script on the New Video page.");
    }

    // Preflight: ffmpeg must be usable BEFORE we spend on voiceover / HeyGen. Fails
    // fast with an actionable message instead of a cryptic mid-run "rc=null" crash
    // after credits are already burned. (No-op cost: a single `ffmpeg -version`.)
    assertFfmpegAvailable();

    // 1. Voiceover (+ word timings). THE ONLY POINT THE TWO MODES DIFFER: either we
    // synthesize the script, or we ingest the operator's recording. Both return the same
    // `Voiceover` { filePath, durationSec, words }, and everything below consumes only
    // that — so no planning, avatar or assembly logic is duplicated or branched.
    let voiceover;
    if (voiceoverUploadPath) {
      voiceover = await voiceoverFromFile(runId, voiceoverUploadPath, audioDir);
    } else {
      const voiceRow = getVoiceSnapStmt.get(runId) as
        | { preset_voice_id: string | null; voice_speed: number | null; voice_model: string | null }
        | undefined;
      voiceover = await synthesizeVoiceover(runId, script, audioDir, {
        voiceOverride: voiceRow?.preset_voice_id ?? null,
        speedOverride: voiceRow?.voice_speed ?? null,
        // NULL for every run made before per-video voices, and for any run that inherited
        // its voice from the channel or the settings — those keep reading the global model
        // live, exactly as they always have.
        modelOverride: voiceRow?.voice_model ?? null,
      });
    }
    const tVoice = Date.now();
    fs.writeFileSync(path.join(runDir, "words.json"), JSON.stringify(voiceover.words, null, 2), "utf-8");
    checkCancelled(runId);
    if (voiceover.words.length === 0) {
      // voiceoverFromFile already fails loudly on empty transcription, so this can only be
      // the TTS path — keep its original message rather than making it vaguer for both.
      throw new Error("ElevenLabs returned no word timings — cannot place visuals. Check the API key / model.");
    }

    // 2. Plan beats.
    const planTitleRow = getTitleStmt.get(runId) as { title: string | null } | undefined;
    let detectedStructure: VideoStructure | null = null;
    const beats = await planBeats(voiceover.words, {
      secondsPerVisual: cfg.secondsPerVisual,
      avatarPercent: cfg.avatarPercent,
      realPercent: cfg.realPercent,
      aiVideoPercent: cfg.aiVideoPercent,
      hasAvatar: !!avatar,
      runId,
      visualPrompt: cfg.visualPrompt,
      overlays: cfg.overlays === true,
      // Stage 2 — the title is the strongest "Top 10 / 5 Facts / …" signal; read only when
      // overlays are on (planBeats ignores it otherwise). Falls back to the script text.
      title: planTitleRow?.title ?? undefined,
      onStructure: (s) => { detectedStructure = s; }, // provenance snapshot, persisted below
    });
    if (beats.length === 0) throw new Error("No beats produced from the voiceover.");

    // Provenance snapshot (observability only — rendering/resume use beats.json, never this).
    // Fail-open: a snapshot write must never break a run.
    if (detectedStructure) {
      const s: VideoStructure = detectedStructure;
      try {
        setStructure.run(
          JSON.stringify({ v: 1, kind: s.kind, direction: s.direction, total: s.total ?? null, source: s.source ?? "title" }),
          runId
        );
      } catch { /* provenance only */ }
    }

    // TILE the beats across the whole timeline: each beat's end = the next
    // beat's start, first beat starts at 0, last ends at the audio end.
    //
    // Beats came from word timings as [firstWord.start, lastWord.end], leaving a
    // GAP between one beat's last word and the next beat's first word (the pause
    // between sentences). The compositor renders each beat back-to-back with no
    // gap, but the master narration KEEPS those pauses — so the video ran
    // progressively ahead of the audio: avatar lips matched on beat 0 and drifted
    // further out of sync on every later avatar beat (and b-roll showed "early").
    // Tiling removes the gaps from the model entirely → video length == audio
    // length, and every beat (its HeyGen audio slice AND its rendered frames)
    // is pinned to its true position on the narration timeline.
    const durMs = Math.round(voiceover.durationSec * 1000);
    beats[0].startMs = 0;
    for (let i = 0; i < beats.length - 1; i++) {
      beats[i].endMs = beats[i + 1].startMs;
    }
    beats[beats.length - 1].endMs = Math.max(beats[beats.length - 1].startMs + 200, durMs);
    fs.writeFileSync(path.join(runDir, "beats.json"), JSON.stringify(beats, null, 2), "utf-8");
    const tPlan = Date.now();

    // 3. Fetch visuals + generate avatar clips per beat (concurrency-limited).
    // Avatar slices are cut from a PCM WAV copy of the narration — MP3 input
    // seeking is approximate, which offset every slice except the first and
    // made later avatar lips drift from the master track.
    const voiceoverWav = decodeToWav(voiceover.filePath, path.join(runDir, "voiceover.wav"));
    const visualConc = visualConcurrency();
    const avatarConc = Math.max(1, Number(getSetting("AVATAR_CONCURRENCY") || "2"));
    const limitVisual = pLimit(visualConc);
    const limitAvatar = pLimit(avatarConc);
    const usedIds = new Set<string>();
    // Topic Pool Retrieval (P1) — one cache per run so beats sharing a topicKey reuse a single
    // provider gather. Passed to every acquireVisual call; a no-op unless TOPIC_POOL=1.
    const topicPool = createTopicPool();
    // One-line topic of the whole video — passed to the footage scorer so a clip
    // must fit the overall context, not just its own sentence.
    // One-line topic of the whole video. An uploaded voiceover has no script, so the
    // narration is rebuilt from the transcribed words — the same text, just recovered
    // rather than typed. In script mode `script` is non-empty (guarded above), so this
    // resolves to `script` and the expression is byte-identical to what it was.
    const contextSource = script.trim() ? script : voiceover.words.map((w) => w.word).join(" ");
    const videoContext = contextSource.replace(/\s+/g, " ").trim().slice(0, 400);

    // Observability only (Patch 2.0b): realized visual source per beat, keyed by
    // beat.index. "real" = stock/footage hit (res.kind !== "ai"), "ai" = generated
    // (res.kind === "ai"). Beats absent from the map either are avatar-only (no
    // visual) or failed retrieval and were filled from a neighbour (failed_or_reused).
    // Writing from the parallel .map callbacks is safe — JS is single-threaded.
    const actualSource = new Map<number, "real" | "ai">();
    /** Where each beat's visual came from — written to credits.json after the loop. */
    const credits = new Map<number, CreditEntry>();

    /**
     * Avatar beats the plan asked for, counted BEFORE the loop: a beat that fails is
     * rewritten to `layout = "broll"` in the catch below, so counting afterwards would
     * report zero avatar beats were ever wanted — the failure would erase its own
     * evidence. `avatarDropped` is what the final line reports on.
     */
    const avatarPlanned = beats.filter((b) => b.layout === "avatar" || b.layout === "split").length;
    let avatarDropped = 0;

    // Promise.allSettled (not Promise.all): when the run is cancelled mid-batch,
    // beats reject with CancelledError. allSettled awaits ALL of them so in-flight
    // beats wind down cleanly and no late rejection becomes an unhandledRejection
    // (Promise.all would reject on the first and orphan the siblings). We surface
    // the cancel via the explicit checkCancelled right after.
    const settledBeats = await Promise.allSettled(
      beats.map(async (beat): Promise<RenderBeat> => {
        let visualPath: string | null = null;
        let avatarClipPath: string | null = null;

        // B-roll for broll/split beats.
        if (beat.layout !== "avatar") {
          try {
            const out = path.join(brollDir, `beat_${String(beat.index).padStart(4, "0")}.mp4`);
            const res = await limitVisual(() => acquireVisual(runId, beat, out, usedIds, { aiStyle: cfg.aiStyle, resolution: cfg.format, videoContext, topicPool, strictReal }));
            visualPath = res.path;
            actualSource.set(beat.index, res.kind === "ai" ? "ai" : "real");
            credits.set(beat.index, creditFrom(beat.index, res));
          } catch (e) {
            if (e instanceof CancelledError) throw e; // cancel aborts the beat — never fall back to more work
            if (e instanceof FlowBrowserError && !isFlowBeatExhausted(e)) throw e; // strict Flow-only mode fails closed; never reuse an unrelated image
            log(runId, "warn", `Beat ${beat.index} visual failed (${(e as Error).message.slice(0, 120)}) — will reuse a neighbour`, {
              stage: "visual",
            });
            visualPath = null; // filled from the nearest good visual after all beats resolve
          }
        }

        // Avatar clip for avatar/split beats.
        if (avatar && (beat.layout === "avatar" || beat.layout === "split")) {
          try {
            const beatAudio = path.join(avatarDir, `beat_${String(beat.index).padStart(4, "0")}.mp3`);
            sliceAudio(voiceoverWav, beat.startMs, beat.endMs, beatAudio);
            const clip = path.join(avatarDir, `beat_${String(beat.index).padStart(4, "0")}.mp4`);
            await limitAvatar(() =>
              generateAvatarClip(runId, avatar, beatAudio, clip, { title: `beat ${beat.index}`, resolution: cfg.format })
            );
            // Cost Monitoring — HeyGen billed per generated clip-second (this beat slice),
            // at the rate of the engine this avatar actually renders with.
            recordHeygenEngine(runId, Math.max(0, (beat.endMs - beat.startMs) / 1000), billingEngine(avatar));
            avatarClipPath = clip;
          } catch (e) {
            if (e instanceof CancelledError) throw e; // cancel aborts the beat — never degrade to a new b-roll call
            // Surface undici's hidden `.cause.code` (ETIMEDOUT/ECONNRESET/EAI_AGAIN/…),
            // otherwise a network failure only ever shows as the opaque "fetch failed".
            const err = e as Error & { cause?: { code?: string; message?: string } };
            const cause = err.cause?.code || err.cause?.message;
            const detail = (cause ? `${err.message} [cause: ${cause}]` : err.message).slice(0, 180);
            log(runId, "warn", `Beat ${beat.index} avatar failed (${detail}) — using b-roll for it`, {
              stage: "avatar_video",
            });
            noteCreditExhausted(runId, "HeyGen", err.message, "avatar_video");
            avatarDropped++;
            // Degrade to b-roll: if there's no visual yet (was a full avatar beat), fetch one.
            if (!visualPath) {
              try {
                const out = path.join(brollDir, `beat_${String(beat.index).padStart(4, "0")}.mp4`);
                const res = await limitVisual(() => acquireVisual(runId, { ...beat, source: beat.source }, out, usedIds, { aiStyle: cfg.aiStyle, resolution: cfg.format, videoContext, topicPool, strictReal }));
                visualPath = res.path;
                actualSource.set(beat.index, res.kind === "ai" ? "ai" : "real");
                credits.set(beat.index, creditFrom(beat.index, res));
              } catch (e) {
                if (e instanceof CancelledError) throw e; // cancel aborts the beat
                if (e instanceof FlowBrowserError && !isFlowBeatExhausted(e)) throw e;
                visualPath = null; // filled from the nearest good visual after all beats resolve
              }
            }
            beat.layout = "broll";
          }
        }

        return { ...beat, visualPath, avatarClipPath };
      })
    );
    const tAcquire = Date.now();
    // If the run was cancelled, beats rejected with CancelledError — throw now
    // (caught below as a clean cancel) before touching any results.
    checkCancelled(runId);
    // Non-cancel runs never reject (every per-beat error is handled inline and
    // returns a RenderBeat). Surface any unexpected rejection as a real error.
    const renderBeats: RenderBeat[] = settledBeats.map((s) => {
      if (s.status === "fulfilled") return s.value;
      throw s.reason;
    });

    // 3b. No black screens: any non-avatar beat whose visual failed reuses the
    // NEAREST beat that has a visual (carry-over) instead of a dark placeholder.
    const goodIdx = renderBeats.map((b, i) => (b.visualPath ? i : -1)).filter((i) => i >= 0);
    let reused = 0;
    for (let i = 0; i < renderBeats.length; i++) {
      const b = renderBeats[i];
      if (b.layout === "avatar" || b.visualPath) continue; // avatar-only beats need no visual
      let best: string | null = null;
      let bestDist = Infinity;
      for (const gi of goodIdx) {
        const d = Math.abs(gi - i);
        if (d < bestDist) {
          bestDist = d;
          best = renderBeats[gi].visualPath;
        }
      }
      b.visualPath = best ?? placeholder(brollDir, b, cfg.format); // placeholder only if nothing else exists
      if (best) reused++;
    }
    if (reused > 0) {
      log(runId, "info", `${reused} beat(s) reused a neighbouring visual (no black screens)`, { stage: "visual" });
    }

    // Footage provenance, written AFTER the carry-over above so a beat showing a
    // neighbour's shot credits that shot rather than appearing as a gap. Beats with no
    // visual of their own and no neighbour to borrow from (the placeholder case) are
    // simply absent — an entry there would claim a source that does not exist.
    writeCredits(
      runDir,
      runId,
      renderBeats
        .filter((b) => b.layout !== "avatar")
        .map((b) => {
          const own = credits.get(b.index);
          if (own) return own;
          const from = renderBeats.find((o) => o.index !== b.index && o.visualPath === b.visualPath && credits.has(o.index));
          const src = from ? credits.get(from.index) : undefined;
          return src ? { ...src, beat: b.index, reusedFromBeat: from!.index } : null;
        })
        .filter((e): e is CreditEntry => e !== null)
    );

    // 3c. Observability only (Patch 2.0b): planned vs realized source split.
    // Denominator = the planner's exact non-avatar visual beats. failed_or_reused
    // counts visual beats with no directly-resolved source (retrieval threw → filled
    // from a neighbour). avatar→broll degrades can make actual_* exceed planned_*.
    const visualBeats = renderBeats.filter((b) => b.layout !== "avatar");
    const plannedReal = visualBeats.filter((b) => b.source === "real").length;
    const plannedAi = visualBeats.filter((b) => b.source === "ai").length;
    let actualReal = 0;
    let actualAi = 0;
    let fallbacksRealToAi = 0;
    let failedOrReused = 0;
    for (const b of visualBeats) {
      const got = actualSource.get(b.index);
      if (got === undefined) failedOrReused++;
      else if (got === "ai") {
        actualAi++;
        if (b.source === "real") fallbacksRealToAi++;
      } else actualReal++;
    }
    log(
      runId,
      "info",
      `FINAL SOURCE RATIO: planned_real=${plannedReal} planned_ai=${plannedAi} | ` +
        `actual_real=${actualReal} actual_ai=${actualAi} | ` +
        `fallbacks_real_to_ai=${fallbacksRealToAi} | failed_or_reused=${failedOrReused}`,
      { stage: "visual" }
    );

    // 4. Composite over the master voiceover.
    const finalPath = await assembleStudioVideo(runId, voiceover.filePath, renderBeats, runDir, cfg.format, cfg.sceneTransitions, cfg.overlays);
    const tAssemble = Date.now();
    try { setDuration.run(voiceover.durationSec, runId); } catch {} // Cost Monitoring — fail-open
    updateRun.run("done", finalPath, runId);

    // Phase 0 — per-stage timing baseline. One PERF summary line: per-stage
    // wall-clock + beat counts (realized real/AI source) + average acquisition
    // wall-time per beat. Observability only — no effect on the rendered output.
    const sec = (ms: number) => (ms / 1000).toFixed(1);
    const avgAcquire = renderBeats.length > 0 ? (tAcquire - tPlan) / renderBeats.length : 0;
    log(
      runId,
      "info",
      `PERF: Voiceover ${sec(tVoice - tStart)}s · Planning ${sec(tPlan - tVoice)}s · ` +
        `Acquire ${sec(tAcquire - tPlan)}s · Assemble ${sec(tAssemble - tAcquire)}s · ` +
        `Total ${sec(tAssemble - tStart)}s | beats=${renderBeats.length} ` +
        `real=${actualReal} ai=${actualAi} avg_acquire=${sec(avgAcquire)}s/beat`,
      { stage: "pipeline" }
    );
    /**
     * The outcome must say what was actually delivered.
     *
     * Degrading a failed avatar beat to b-roll is right for a transient hiccup — it saves
     * a long render whose voiceover is already paid for. But the run used to end on an
     * unqualified "Pipeline complete" even when EVERY avatar beat was dropped, so an
     * operator who picked an avatar got a faceless video and a green tick. The warnings
     * were in the log, but the outcome contradicted them, and the outcome is what people
     * read. The status stays "done" — a real video did render, and it is downloadable —
     * but the run no longer claims to be something it isn't.
     */
    setDegraded.run(degradeCodes(avatarDropped, avatarPlanned, overlaysWereLost(cfg.overlays, renderBeats)), runId);
    if (avatarDropped > 0) {
      const all = avatarDropped >= avatarPlanned;
      log(
        runId,
        "warn",
        `Pipeline complete — but WITHOUT the avatar on ${avatarDropped}/${avatarPlanned} avatar beat(s). ` +
          (all
            ? "The final video contains NO avatar footage — it was rendered faceless. Check the avatar still exists on your HeyGen account."
            : "Those beats show b-roll instead."),
        { stage: "pipeline", data: { finalPath, avatarDropped, avatarPlanned } }
      );
    } else {
      log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });
    }

    // Auto-upload to Drive. LAST thing in the try, so it runs only for a run that
    // actually completed: any throw above (including a cancel) skips it, and the run is
    // already marked `done` with its final video downloadable before the upload starts.
    await syncFinishedRunToDrive(runId, runDir, finalPath);
  } catch (e) {
    if (e instanceof CancelledError) {
      log(runId, "warn", "Pipeline cancelled by user", { stage: "pipeline" });
    } else {
      // Append the cause, not just e.message. Node's fetch surfaces every network fault as
      // a bare TypeError("fetch failed") and buries the real reason (ECONNRESET, ETIMEDOUT,
      // ENOTFOUND) in `cause` — which is how a real run's only error line came out as
      // literally "Pipeline crashed: fetch failed", naming no provider and no cause. Same
      // unwrapping the per-beat catch already does; an error with no cause is unchanged.
      const msg = e instanceof Error ? e.message : String(e);
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      const detail = cause?.code || cause?.message;
      log(runId, "error", `Pipeline crashed: ${detail ? `${msg} [cause: ${detail}]` : msg}`, { stage: "pipeline" });
      updateRun.run("error", null, runId);
    }
  } finally {
    endRun(runId); // release the in-process lock (run is terminal: done/error/cancelled)
  }
}

/** The run's pipeline mode from its config snapshot ("studio" = avatar documentary). */
export function getRunMode(runId: string): string | null {
  const row = getConfigStmt.get(runId) as { config_json: string | null } | undefined;
  try {
    return row?.config_json ? (JSON.parse(row.config_json).mode ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * A studio run can be resumed once its voiceover + beat plan are on disk. These
 * are the expensive front matter that must NOT be regenerated — regenerating the
 * voiceover/plan would shift beat indices + timings and orphan every clip that was
 * already rendered (clips are keyed by beat index).
 */
export function canResumeStudioRun(runId: string): boolean {
  const runDir = getRunDir(runId);
  return (
    fs.existsSync(path.join(runDir, "audio", "voiceover.mp3")) &&
    fs.existsSync(path.join(runDir, "beats.json"))
  );
}

/**
 * True if a beat clip on disk is complete and decodable. Guards against a file
 * that was half-written when the process died mid-encode (a size check alone would
 * accept a truncated mp4 that then breaks the concat).
 */
function isReusableClip(clipPath: string): boolean {
  try {
    if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size < 1024) return false;
    const r = spawnSync(
      resolveFfprobe(),
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", clipPath],
      { stdio: "pipe" }
    );
    if (r.status !== 0) return false;
    const dur = parseFloat(String(r.stdout).trim());
    return Number.isFinite(dur) && dur > 0;
  } catch {
    return false;
  }
}

/**
 * RESUME a studio run interrupted before final.mp4 (crash, server restart, cancel).
 *
 * Reuses the on-disk voiceover.mp3 + beats.json AS-IS and every beat clip already
 * rendered (broll/beat_XXXX.mp4, avatar/beat_XXXX.mp4). Only beats whose clip is
 * missing or corrupt are regenerated — so already-paid HeyGen/AI clips are never
 * re-billed — then the final video is reassembled.
 *
 * Intentionally self-contained (it does NOT share runStudioPipeline's per-beat body)
 * so the battle-tested first-run generation path stays untouched. The small overlap
 * (per-beat acquire, neighbour carry-over) mirrors that path deliberately.
 */
export async function resumeStudioPipeline(runId: string): Promise<void> {
  const runDir = getRunDir(runId);
  const audioDir = path.join(runDir, "audio");
  const brollDir = path.join(runDir, "broll");
  const avatarDir = path.join(runDir, "avatar");
  for (const d of [runDir, audioDir, brollDir, avatarDir]) fs.mkdirSync(d, { recursive: true });

  const voiceoverPath = path.join(audioDir, "voiceover.mp3");
  const beatsPath = path.join(runDir, "beats.json");
  if (!fs.existsSync(voiceoverPath) || !fs.existsSync(beatsPath)) {
    const missing = [
      !fs.existsSync(voiceoverPath) && "audio/voiceover.mp3",
      !fs.existsSync(beatsPath) && "beats.json",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Cannot resume this studio run — missing ${missing}. It failed before those were produced; start a fresh run instead.`
    );
  }

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);
    beginRun(runId); // claim ownership + take the in-process lock (blocks duplicate Resume)
    // Reset the PAID Storyblocks download budget. Must happen per run (including on
    // Resume), or a resumed run would inherit the previous run's spent counter — and,
    // worse, a process that never called this keeps the cap at 0 and the source stays
    // silently dead. No-op when Storyblocks isn't configured.
    beginStoryblocksRun();
    const tStart = Date.now();
    const cfg = readConfig(runId);
    activateChannelOverrides(cfg);
    // Resume replays the ORIGINAL run's config_json, so real-footage-only survives a
    // resume even if global settings changed in between.
    const strictReal = strictRealFor(cfg);
    const avatar = readAvatar(runId);
    // Resume re-enters here WITHOUT passing through /api/studio, so the route's Avatar V
    // eligibility check never ran for this execution. Re-check now: eligibility is
    // mutable and may have lapsed since the run was created (a resume can be days
    // later). Billable HeyGen work starts below, so this is the last free moment —
    // one live check per execution, exactly as on the fresh path.
    await assertAvatarVStillEligible(runId, avatar);
    const beats = JSON.parse(fs.readFileSync(beatsPath, "utf-8")) as Beat[];
    if (!Array.isArray(beats) || beats.length === 0) {
      throw new Error("beats.json is empty or invalid — start a fresh run instead.");
    }
    const titleRow = getTitleStmt.get(runId) as { title: string | null } | undefined;
    const videoContext = (titleRow?.title || "").replace(/\s+/g, " ").trim().slice(0, 400);
    log(
      runId,
      "info",
      `Resuming studio run (v${APP_VERSION}) — reusing voiceover + ${beats.length} planned beats; regenerating only missing/corrupt clips`,
      { stage: "pipeline" }
    );

    const voiceoverWav = decodeToWav(voiceoverPath, path.join(runDir, "voiceover.wav"));
    const visualConc = visualConcurrency();
    const avatarConc = Math.max(1, Number(getSetting("AVATAR_CONCURRENCY") || "2"));
    const limitVisual = pLimit(visualConc);
    const limitAvatar = pLimit(avatarConc);
    const usedIds = new Set<string>();
    const topicPool = createTopicPool();
    let reusedClips = 0;
    let regenVisual = 0;
    // Seeded from the previous execution: a resume that reuses an intact clip never learns
    // where it came from, so rebuilding this map from scratch would blank out provenance
    // for exactly the beats the resume did the least work on.
    const credits = readCredits(runDir);
    // Same accounting as the main path — a resumed run that drops the avatar must not
    // claim success either. Counted before the loop rewrites a failed beat to "broll".
    const avatarPlanned = beats.filter((b) => b.layout === "avatar" || b.layout === "split").length;
    let avatarDropped = 0;
    let regenAvatar = 0;

    const settled = await Promise.allSettled(
      beats.map(async (beat): Promise<RenderBeat> => {
        const pad = String(beat.index).padStart(4, "0");
        let visualPath: string | null = null;
        let avatarClipPath: string | null = null;

        // B-roll for broll/split beats — reuse the on-disk clip if it's intact.
        if (beat.layout !== "avatar") {
          const out = path.join(brollDir, `beat_${pad}.mp4`);
          if (isReusableClip(out)) {
            visualPath = out;
            reusedClips++;
          } else {
            try {
              const res = await limitVisual(() =>
                acquireVisual(runId, beat, out, usedIds, { aiStyle: cfg.aiStyle, resolution: cfg.format, videoContext, topicPool, strictReal })
              );
              visualPath = res.path;
              credits.set(beat.index, creditFrom(beat.index, res));
              regenVisual++;
            } catch (e) {
              if (e instanceof CancelledError) throw e;
              if (e instanceof FlowBrowserError && !isFlowBeatExhausted(e)) throw e;
              log(runId, "warn", `Beat ${beat.index} visual failed (${(e as Error).message.slice(0, 120)}) — will reuse a neighbour`, {
                stage: "visual",
              });
              visualPath = null;
            }
          }
        }

        // Avatar clip for avatar/split beats — reuse the on-disk clip if it's intact.
        if (avatar && (beat.layout === "avatar" || beat.layout === "split")) {
          const clip = path.join(avatarDir, `beat_${pad}.mp4`);
          if (isReusableClip(clip)) {
            avatarClipPath = clip;
            reusedClips++;
          } else {
            try {
              const beatAudio = path.join(avatarDir, `beat_${pad}.mp3`);
              sliceAudio(voiceoverWav, beat.startMs, beat.endMs, beatAudio);
              await limitAvatar(() =>
                generateAvatarClip(runId, avatar, beatAudio, clip, { title: `beat ${beat.index}`, resolution: cfg.format })
              );
              recordHeygenEngine(runId, Math.max(0, (beat.endMs - beat.startMs) / 1000), billingEngine(avatar));
              avatarClipPath = clip;
              regenAvatar++;
            } catch (e) {
              if (e instanceof CancelledError) throw e;
              const err = e as Error & { cause?: { code?: string; message?: string } };
              const cause = err.cause?.code || err.cause?.message;
              const detail = (cause ? `${err.message} [cause: ${cause}]` : err.message).slice(0, 180);
              log(runId, "warn", `Beat ${beat.index} avatar failed (${detail}) — using b-roll for it`, { stage: "avatar_video" });
              noteCreditExhausted(runId, "HeyGen", err.message, "avatar_video");
              avatarDropped++;
              if (!visualPath) {
                const out = path.join(brollDir, `beat_${pad}.mp4`);
                if (isReusableClip(out)) {
                  visualPath = out;
                  reusedClips++;
                } else {
                  try {
                    const res = await limitVisual(() =>
                      acquireVisual(runId, { ...beat, source: beat.source }, out, usedIds, { aiStyle: cfg.aiStyle, resolution: cfg.format, videoContext, topicPool, strictReal })
                    );
                    visualPath = res.path;
                    credits.set(beat.index, creditFrom(beat.index, res));
                    regenVisual++;
                  } catch (e2) {
                    if (e2 instanceof CancelledError) throw e2;
                    if (e2 instanceof FlowBrowserError && !isFlowBeatExhausted(e2)) throw e2;
                    visualPath = null;
                  }
                }
              }
              beat.layout = "broll";
            }
          }
        }

        return { ...beat, visualPath, avatarClipPath };
      })
    );
    checkCancelled(runId);
    const renderBeats: RenderBeat[] = settled.map((s) => {
      if (s.status === "fulfilled") return s.value;
      throw s.reason;
    });

    // No black screens — same neighbour carry-over as the first-run pipeline.
    const goodIdx = renderBeats.map((b, i) => (b.visualPath ? i : -1)).filter((i) => i >= 0);
    let reusedNeighbour = 0;
    for (let i = 0; i < renderBeats.length; i++) {
      const b = renderBeats[i];
      if (b.layout === "avatar" || b.visualPath) continue;
      let best: string | null = null;
      let bestDist = Infinity;
      for (const gi of goodIdx) {
        const d = Math.abs(gi - i);
        if (d < bestDist) {
          bestDist = d;
          best = renderBeats[gi].visualPath;
        }
      }
      b.visualPath = best ?? placeholder(brollDir, b, cfg.format);
      if (best) reusedNeighbour++;
    }

    // Same provenance write as a first execution, on the map seeded from the previous one.
    writeCredits(
      runDir,
      runId,
      renderBeats
        .filter((b) => b.layout !== "avatar")
        .map((b) => {
          const own = credits.get(b.index);
          if (own) return own;
          const from = renderBeats.find((o) => o.index !== b.index && o.visualPath === b.visualPath && credits.has(o.index));
          const src = from ? credits.get(from.index) : undefined;
          return src ? { ...src, beat: b.index, reusedFromBeat: from!.index } : null;
        })
        .filter((e): e is CreditEntry => e !== null)
    );

    log(
      runId,
      "info",
      `Resume plan: reused ${reusedClips} clip(s) from disk · regenerated ${regenVisual} b-roll + ${regenAvatar} avatar · ${reusedNeighbour} neighbour fill(s)`,
      { stage: "pipeline" }
    );

    const finalPath = await assembleStudioVideo(runId, voiceoverPath, renderBeats, runDir, cfg.format, cfg.sceneTransitions, cfg.overlays);
    const durationSec = Math.max(...beats.map((b) => b.endMs)) / 1000;
    try {
      setDuration.run(durationSec, runId);
    } catch {}
    updateRun.run("done", finalPath, runId);
    const took = `${((Date.now() - tStart) / 1000).toFixed(1)}s`;
    setDegraded.run(degradeCodes(avatarDropped, avatarPlanned, overlaysWereLost(cfg.overlays, renderBeats)), runId);
    if (avatarDropped > 0) {
      const all = avatarDropped >= avatarPlanned;
      log(
        runId,
        "warn",
        `Resume complete (${took}) — but WITHOUT the avatar on ${avatarDropped}/${avatarPlanned} avatar beat(s). ` +
          (all
            ? "The final video contains NO avatar footage — it was rendered faceless. Check the avatar still exists on your HeyGen account."
            : "Those beats show b-roll instead."),
        { stage: "pipeline", data: { finalPath, avatarDropped, avatarPlanned } }
      );
    } else {
      log(runId, "success", `Resume complete — reassembled in ${took}`, {
        stage: "pipeline",
        data: { finalPath },
      });
    }

    // Same as the fresh path: a resumed run that reaches here IS a completed run, and
    // it is exactly the case that most needs the upload — it finished late, often after
    // the operator stopped watching.
    await syncFinishedRunToDrive(runId, runDir, finalPath);
  } catch (e) {
    if (e instanceof CancelledError) {
      log(runId, "warn", "Resume cancelled by user", { stage: "pipeline" });
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Resume crashed: ${msg}`, { stage: "pipeline" });
      updateRun.run("error", null, runId);
    }
  } finally {
    endRun(runId); // release the in-process lock (run is terminal: done/error/cancelled)
  }
}

/** Solid-color filler clip so a failed beat still holds its slot in the timeline. */
function placeholder(dir: string, beat: Beat, resolution?: string): string {
  const out = path.join(dir, `ph_${String(beat.index).padStart(4, "0")}.mp4`);
  const res = resolution || getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Math.max(1, Number(getSetting("VIDEO_FPS") || "30"));
  const dur = Math.max(0.3, (beat.endMs - beat.startMs) / 1000).toFixed(3);
  const color = getSetting("AVATAR_BACKGROUND") || "#101418";
  const ff = resolveFfmpeg();
  const r = spawnSync(
    ff,
    [
      "-f", "lavfi",
      "-i", `color=c=${color}:s=${res.replace("×", "x")}:r=${fps}:d=${dur}`,
      "-t", dur,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-an",
      "-movflags", "+faststart", "-y", out,
    ],
    { stdio: "pipe" }
  );
  if (r.status !== 0) throw new Error(`placeholder clip failed: ${r.stderr?.toString().slice(-200)}`);
  return out;
}

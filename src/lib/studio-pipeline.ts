import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { resolveFfmpeg } from "./ffmpeg-bin";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { checkCancelled, clearCancelled, CancelledError } from "./cancellation";
import { APP_VERSION } from "./version";
import { synthesizeVoiceover } from "./services/elevenlabs-voiceover";
import { planBeats, type Beat } from "./services/studio-plan";
import { acquireVisual, createTopicPool, FOOTAGE_PROVIDER_KEYS } from "./services/visual-source";
import { generateAvatarClip, type AvatarHandle } from "./services/heygen-video";
import { assembleStudioVideo, sliceAudio, decodeToWav, type RenderBeat } from "./services/studio-assemble";
import { recordHeygen } from "./services/cost-ledger";

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
// Cost Monitoring — final video length, persisted once at completion (cost/min).
const setDuration = db.prepare("UPDATE runs SET duration_sec = ? WHERE id = ?");
const getConfigStmt = db.prepare("SELECT config_json FROM runs WHERE id = ?");
const getAvatarSnapStmt = db.prepare(
  "SELECT avatar_db_id, avatar_engine, avatar_heygen_id, avatar_image_key, avatar_use_iv, avatar_motion_prompt FROM runs WHERE id = ?"
);
const getVoiceSnapStmt = db.prepare("SELECT preset_voice_id FROM runs WHERE id = ?");

interface StudioConfig {
  visualMode: "ai" | "real" | "mix";
  secondsPerVisual: number;
  avatarPercent: number;
  realPercent: number;
  aiStyle: string | undefined;
  format: string | undefined;
  visualPrompt: string | undefined;
  /** Per-run dip-to-black toggle (Create Video → Advanced). undefined → global default. */
  sceneTransitions: boolean | undefined;
  /** Per-channel ordered b-roll source priority (from Channel.footage_source_tiers).
   * undefined → global FOOTAGE_SOURCES (today's behavior, all providers in parallel). */
  footageSourceTiers: string[][] | undefined;
}

/** Parses the raw `footage_source_tiers` JSON string (array of comma-joined
 * provider-key strings) into validated tiers. Unknown provider keys and
 * "youtube" (never part of a tier — it's the existing automatic last-resort)
 * are dropped; empty tiers are dropped. Any parse failure fails open to
 * undefined (today's global-FOOTAGE_SOURCES behavior). */
function parseFootageSourceTiers(raw: unknown): string[][] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return undefined;
    const tiers = arr
      .map((tier) =>
        String(tier)
          .split(/[\n,;]+/)
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s !== "youtube" && FOOTAGE_PROVIDER_KEYS.includes(s))
      )
      .filter((tier) => tier.length > 0);
    return tiers.length > 0 ? tiers : undefined;
  } catch {
    return undefined;
  }
}

function readConfig(runId: string): StudioConfig {
  const row = getConfigStmt.get(runId) as { config_json: string | null } | undefined;
  let cfg: Partial<StudioConfig> & { mode?: string; footageSourceTiers?: unknown } = {};
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
    aiStyle: typeof cfg.aiStyle === "string" && cfg.aiStyle.trim() ? cfg.aiStyle.trim() : undefined,
    format: typeof cfg.format === "string" && /^\d+\s*[x×]\s*\d+$/i.test(cfg.format) ? cfg.format.trim() : undefined,
    visualPrompt: typeof cfg.visualPrompt === "string" && cfg.visualPrompt.trim() ? cfg.visualPrompt.trim() : undefined,
    sceneTransitions: typeof cfg.sceneTransitions === "boolean" ? cfg.sceneTransitions : undefined,
    footageSourceTiers: parseFootageSourceTiers(cfg.footageSourceTiers),
  };
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
      }
    | undefined;
  if (!row?.avatar_db_id || !row.avatar_heygen_id) return null;
  return {
    dbId: row.avatar_db_id,
    engine: row.avatar_engine === "photo_avatar_group" ? "photo_avatar_group" : "talking_photo",
    heygenId: row.avatar_heygen_id,
    imageKey: row.avatar_image_key,
    useAvatarIv: row.avatar_use_iv === "1",
    motionPrompt: row.avatar_motion_prompt,
  };
}

export async function runStudioPipeline(runId: string, script: string): Promise<void> {
  const runDir = getRunDir(runId);
  const audioDir = path.join(runDir, "audio");
  const brollDir = path.join(runDir, "broll");
  const avatarDir = path.join(runDir, "avatar");
  for (const d of [runDir, audioDir, brollDir, avatarDir]) fs.mkdirSync(d, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);
    // Phase 0 — per-stage timing baseline (additive, observability only; no
    // behavior/concurrency change). Stage marks are taken at each stage boundary
    // and summarized in one PERF log line at the end.
    const tStart = Date.now();
    const cfg = readConfig(runId);
    const avatar = readAvatar(runId);
    log(
      runId,
      "info",
      `Pipeline started (v${APP_VERSION}) · mode=${cfg.visualMode} · ${cfg.secondsPerVisual}s/visual · avatar=${avatar ? `${cfg.avatarPercent}%` : "none"} · real=${cfg.realPercent}%`,
      { stage: "pipeline" }
    );

    if (!script.trim()) throw new Error("Script is empty — paste a script on the New Video page.");

    // 1. ElevenLabs voiceover (+ word timings).
    const voiceRow = getVoiceSnapStmt.get(runId) as { preset_voice_id: string | null } | undefined;
    const voiceover = await synthesizeVoiceover(runId, script, audioDir, {
      voiceOverride: voiceRow?.preset_voice_id ?? null,
    });
    const tVoice = Date.now();
    fs.writeFileSync(path.join(runDir, "words.json"), JSON.stringify(voiceover.words, null, 2), "utf-8");
    checkCancelled(runId);
    if (voiceover.words.length === 0) {
      throw new Error("ElevenLabs returned no word timings — cannot place visuals. Check the API key / model.");
    }

    // 2. Plan beats.
    const beats = await planBeats(voiceover.words, {
      secondsPerVisual: cfg.secondsPerVisual,
      avatarPercent: cfg.avatarPercent,
      realPercent: cfg.realPercent,
      hasAvatar: !!avatar,
      runId,
      visualPrompt: cfg.visualPrompt,
    });
    if (beats.length === 0) throw new Error("No beats produced from the voiceover.");

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
    const visualConc = Math.max(1, Number(getSetting("VISUAL_CONCURRENCY") || "3"));
    const avatarConc = Math.max(1, Number(getSetting("AVATAR_CONCURRENCY") || "2"));
    const limitVisual = pLimit(visualConc);
    const limitAvatar = pLimit(avatarConc);
    const usedIds = new Set<string>();
    // Topic Pool Retrieval (P1) — one cache per run so beats sharing a topicKey reuse a single
    // provider gather. Passed to every acquireVisual call; a no-op unless TOPIC_POOL=1.
    const topicPool = createTopicPool();
    // One-line topic of the whole video — passed to the footage scorer so a clip
    // must fit the overall context, not just its own sentence.
    const videoContext = script.replace(/\s+/g, " ").trim().slice(0, 400);

    // Observability only (Patch 2.0b): realized visual source per beat, keyed by
    // beat.index. "real" = stock/footage hit (res.kind !== "ai"), "ai" = generated
    // (res.kind === "ai"). Beats absent from the map either are avatar-only (no
    // visual) or failed retrieval and were filled from a neighbour (failed_or_reused).
    // Writing from the parallel .map callbacks is safe — JS is single-threaded.
    const actualSource = new Map<number, "real" | "ai">();

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
            const res = await limitVisual(() => acquireVisual(runId, beat, out, usedIds, { aiStyle: cfg.aiStyle, resolution: cfg.format, videoContext, topicPool, sourceTiers: cfg.footageSourceTiers }));
            visualPath = res.path;
            actualSource.set(beat.index, res.kind === "ai" ? "ai" : "real");
          } catch (e) {
            if (e instanceof CancelledError) throw e; // cancel aborts the beat — never fall back to more work
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
            // Cost Monitoring — HeyGen billed per generated clip-second (this beat slice).
            recordHeygen(runId, Math.max(0, (beat.endMs - beat.startMs) / 1000));
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
            // Degrade to b-roll: if there's no visual yet (was a full avatar beat), fetch one.
            if (!visualPath) {
              try {
                const out = path.join(brollDir, `beat_${String(beat.index).padStart(4, "0")}.mp4`);
                const res = await limitVisual(() => acquireVisual(runId, { ...beat, source: beat.source }, out, usedIds, { aiStyle: cfg.aiStyle, resolution: cfg.format, videoContext, topicPool, sourceTiers: cfg.footageSourceTiers }));
                visualPath = res.path;
                actualSource.set(beat.index, res.kind === "ai" ? "ai" : "real");
              } catch (e) {
                if (e instanceof CancelledError) throw e; // cancel aborts the beat
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
    const finalPath = await assembleStudioVideo(runId, voiceover.filePath, renderBeats, runDir, cfg.format, cfg.sceneTransitions);
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
    log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });
  } catch (e) {
    if (e instanceof CancelledError) {
      log(runId, "warn", "Pipeline cancelled by user", { stage: "pipeline" });
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Pipeline crashed: ${msg}`, { stage: "pipeline" });
      updateRun.run("error", null, runId);
    }
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

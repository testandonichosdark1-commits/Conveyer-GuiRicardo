import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { resolveFfmpeg } from "../ffmpeg-bin";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createTtsJob, pollJob, downloadJob } from "./labs69";
import { probeDurationSafe } from "./video-assemble";
import { isVoiceRejection, classifyVoiceError } from "./elevenlabs-voices";
import { recordAi33, recordAi84, recordFishAudio, recordHume, recordTtsChars, recordElevenlabs } from "./cost-ledger";
import { requestWithPolicy, errorChainText } from "./http";
import { describeProviderVoiceRejection, ai84VoiceModelMismatch, ai33VoiceIdUnqualified, ai33LooksLikeVoiceRejection } from "./voice-errors";
import { ai84Backend } from "../providers";
import { pickTaskId, readTaskState, describeUnparsed } from "./ai33-response";
import { noteCreditExhausted } from "./credit-exhaustion";
import { CancelledError } from "../cancellation";
import { AI33_DEFAULT_BASE } from "./ai33-voices";
import {
  buildAi84ElevenCreate,
  buildAi84MinimaxCreate,
  type Ai84CreateRequest,
  type ElevenVoiceSettings,
} from "./ai84-request";

export interface TtsResult {
  /** Path to the mp3 file. */
  filePath: string;
  /** Audio duration in seconds, measured via ffprobe. */
  durationSec: number;
}

/**
 * Routes `text` to the currently-configured TTS provider, writing the audio
 * to `outPath`. Shared by per-scene (synthesizeScene) and single-shot
 * (synthesizeFullScript) synthesis so adding a provider is a one-place change.
 */
async function dispatchTts(
  runId: string,
  text: string,
  outPath: string,
  options: {
    voiceOverride?: string | null;
    provider?: string;
    speedOverride?: number | null;
    /** Per-run TTS model. Only AI84 understands one today; the other branches ignore it. */
    modelOverride?: string | null;
  }
): Promise<void> {
  const provider = (options.provider || getSetting("TTS_PROVIDER") || "heygen").toLowerCase();
  if (provider === "heygen") {
    await heygenTts(runId, text, outPath, options.voiceOverride, options.speedOverride);
    // Cost Monitoring. Metered HERE rather than inside each provider function: this is
    // the one seam every branch passes through, and the five providers below share a
    // unit (characters). Only reached on success, so a failed synthesis isn't billed.
    //
    // Known undercount: heygenTts falls back from /v3 to /v1 on a 4xx, which is a
    // SECOND billable synthesis of the same text; this records one. Same shape as the
    // provider-internal retries elsewhere in the pipeline.
    recordTtsChars(runId, text.length, "heygen:tts");
  } else if (provider === "69labs") {
    await labs69Tts(runId, text, outPath, options.speedOverride);
    recordTtsChars(runId, text.length, "69labs:tts");
  } else if (provider === "elevenlabs") {
    await elevenLabs(text, outPath);
    // The direct ElevenLabs branch was unmetered, so only voiceovers going through
    // elevenlabs-voiceover.ts ever counted toward the plan's quota bar.
    recordElevenlabs(runId, text.length);
  } else if (provider === "openai") {
    await openaiTts(text, outPath);
    recordTtsChars(runId, text.length, "openai:tts");
  } else if (provider === "minimax") {
    await minimaxTts(runId, text, outPath, options.voiceOverride, options.speedOverride);
    recordTtsChars(runId, text.length, "minimax:tts");
  } else if (provider === "genaipro") {
    await genaiproTts(runId, text, outPath, options.voiceOverride, options.speedOverride);
    recordTtsChars(runId, text.length, "genaipro:tts");
  } else if (provider === "ai84") {
    await ai84Tts(runId, text, outPath, options.voiceOverride, options.speedOverride, options.modelOverride);
  } else if (provider === "ai33") {
    // Metered inside, like AI84: ai33 bills in CREDITS it reports back, not in characters,
    // so there is nothing to record from here.
    await ai33Tts(runId, text, outPath, options.voiceOverride, options.speedOverride);
  } else if (provider === "fishaudio") {
    await fishAudioTts(runId, text, outPath, options.voiceOverride, options.speedOverride);
  } else if (provider === "hume") {
    await humeTts(runId, text, outPath, options.voiceOverride, options.speedOverride);
  } else {
    throw new Error(`Unknown TTS provider: ${provider}`);
  }
}

/**
 * Synthesizes one scene. Supports HeyGen (default for Conveyer Grok), 69labs,
 * ElevenLabs (direct), OpenAI TTS, MiniMax. Each file is sceneN.mp3 in the
 * scene directory.
 *
 * `options.voiceOverride` — when a channel profile sets its own HeyGen voice_id,
 * the pipeline passes it here so that channel's runs use that voice instead of
 * the global HEYGEN_VOICE_ID setting. Empty/null → use the global setting.
 */
export async function synthesizeScene(
  runId: string,
  scene: Scene,
  outDir: string,
  options: { voiceOverride?: string | null } = {}
): Promise<TtsResult> {
  const provider = (getSetting("TTS_PROVIDER") || "heygen").toLowerCase();
  const fileName = `scene_${String(scene.index).padStart(3, "0")}.mp3`;
  const filePath = path.join(outDir, fileName);

  log(runId, "info", `TTS scene #${scene.index} (${provider})`, {
    stage: "tts",
    data: { provider, text: scene.text.slice(0, 80) },
  });

  await dispatchTts(runId, scene.text, filePath, options);

  // Real audio duration via ffprobe (falls back to a file-size estimate if
  // ffprobe is unavailable). This value feeds the run log and library manifest.
  const durationSec = await probeDurationSafe(filePath);

  log(runId, "success", `TTS done: ${fileName} (${durationSec.toFixed(1)}s)`, {
    stage: "tts",
  });
  return { filePath, durationSec };
}

/**
 * Single-shot: synthesize the WHOLE concatenated script in one TTS call.
 *
 * Used by single-shot TTS mode (tts-align.ts) so the voiceover flows as one
 * continuous performance — no per-scene intonation arcs to stitch and no
 * audible boundaries every 4-6 seconds. Bull Network's reproduction showed
 * that a single full-script call sounds fluid where 14 per-scene calls
 * stitched together sound choppy.
 */
export async function synthesizeFullScript(
  runId: string,
  text: string,
  outPath: string,
  options: {
    voiceOverride?: string | null;
    provider?: string;
    speedOverride?: number | null;
    modelOverride?: string | null;
  } = {}
): Promise<TtsResult> {
  const provider = (options.provider || getSetting("TTS_PROVIDER") || "heygen").toLowerCase();
  log(runId, "info", `TTS full script (${provider}, ${text.length} chars)`, {
    stage: "tts",
  });

  // MiniMax T2A v2 has a per-call character cap (~10K). For long scripts we
  // chunk at sentence boundaries, synthesise each chunk separately, then
  // concat the mp3s with ffmpeg. The voice stays the same across chunks
  // (same voice_id), so the perceived intonation arcs are merely 4-5 instead
  // of N-scenes — still vastly more fluid than per-scene TTS.
  const MAX_CHARS = 4500;
  if (text.length > MAX_CHARS) {
    const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text];
    const chunks: string[] = [];
    let cur = "";
    for (const s of sentences) {
      if ((cur + s).length > MAX_CHARS && cur) {
        chunks.push(cur);
        cur = s;
      } else {
        cur += s;
      }
    }
    if (cur) chunks.push(cur);

    log(runId, "info", `Long script — chunking into ${chunks.length} TTS calls`, {
      stage: "tts",
    });

    const chunkPaths: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = outPath.replace(/\.mp3$/i, `__chunk${String(i).padStart(2, "0")}.mp3`);
      log(runId, "info", `TTS chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`, {
        stage: "tts",
      });
      await dispatchTts(runId, chunks[i], chunkPath, options);
      chunkPaths.push(chunkPath);
      // Throttle between chunks to stay under MiniMax TPM (tokens-per-minute).
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }

    // Concat with ffmpeg concat demuxer + stream copy (no re-encode).
    const concatListPath = outPath.replace(/\.mp3$/i, `__concat.txt`);
    const listLines = chunkPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    fs.writeFileSync(concatListPath, listLines + "\n", "utf-8");
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(
      resolveFfmpeg(),
      ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", outPath],
      { stdio: "pipe" }
    );
    if (r.status !== 0) {
      throw new Error(
        `ffmpeg concat failed (rc=${r.status}): ${r.stderr?.toString().slice(-300)}`
      );
    }
    for (const p of chunkPaths) {
      try { fs.unlinkSync(p); } catch {}
    }
    try { fs.unlinkSync(concatListPath); } catch {}
  } else {
    await dispatchTts(runId, text, outPath, options);
  }

  const durationSec = await probeDurationSafe(outPath);
  log(
    runId,
    "success",
    `TTS full script done: ${path.basename(outPath)} (${durationSec.toFixed(1)}s)`,
    { stage: "tts" }
  );
  return { filePath: outPath, durationSec };
}

async function labs69Tts(runId: string, text: string, outPath: string, speedOverride?: number | null) {
  const voiceId = getSetting("TTS_VOICE_ID") || "en-US-GuyNeural";
  const voiceProviderRaw = (getSetting("TTS_VOICE_PROVIDER") || "edgetts").toLowerCase();
  const voiceProvider =
    voiceProviderRaw === "elevenlabs" || voiceProviderRaw === "edgetts" || voiceProviderRaw === "voice-clone"
      ? (voiceProviderRaw as "elevenlabs" | "edgetts" | "voice-clone")
      : "edgetts";
  const modelId = getSetting("TTS_MODEL") || undefined;
  const splitTypeRaw = (getSetting("TTS_SPLIT_TYPE") || "smart").toLowerCase();
  const splitType =
    splitTypeRaw === "paragraphs" || splitTypeRaw === "max_length"
      ? (splitTypeRaw as "smart" | "paragraphs" | "max_length")
      : "smart";

  // ElevenLabs-specific fine-tuning
  const voiceSettings: {
    stability?: number;
    similarityBoost?: number;
    speed?: number;
    style?: number;
    useSpeakerBoost?: boolean;
  } = {};
  if (voiceProvider === "elevenlabs") {
    const stability = parseFloatOr(getSetting("TTS_STABILITY"), NaN);
    const similarity = parseFloatOr(getSetting("TTS_SIMILARITY_BOOST"), NaN);
    const speed = speedOverride ?? parseFloatOr(getSetting("TTS_SPEED"), NaN);
    const style = parseFloatOr(getSetting("TTS_STYLE"), NaN);
    const speakerBoost = getSetting("TTS_USE_SPEAKER_BOOST");

    if (!Number.isNaN(stability)) voiceSettings.stability = clamp(stability, 0, 1);
    if (!Number.isNaN(similarity)) voiceSettings.similarityBoost = clamp(similarity, 0, 1);
    if (!Number.isNaN(speed)) voiceSettings.speed = clamp(speed, 0.7, 1.2);
    if (!Number.isNaN(style)) voiceSettings.style = clamp(style, 0, 1);
    if (speakerBoost === "1") voiceSettings.useSpeakerBoost = true;
    else if (speakerBoost === "0") voiceSettings.useSpeakerBoost = false;
  }

  // Auto-pause — stops TTS from rushing through sentence ends
  const autoPauseEnabled = getSetting("TTS_AUTO_PAUSE") === "1";
  const autoPauseDuration = parseFloatOr(getSetting("TTS_PAUSE_DURATION"), NaN);
  const autoPauseFrequency = parseFloatOr(getSetting("TTS_PAUSE_FREQUENCY"), NaN);

  const jobId = await createTtsJob({
    text,
    voiceId,
    voiceProvider,
    modelId,
    splitType,
    voiceSettings,
    autoPauseEnabled,
    autoPauseDuration: !Number.isNaN(autoPauseDuration) ? clamp(autoPauseDuration, 0.1, 30) : undefined,
    autoPauseFrequency: !Number.isNaN(autoPauseFrequency) ? clamp(autoPauseFrequency, 1, 100) : undefined,
    runId,
  });
  log(runId, "debug", `69labs TTS job ${jobId.slice(0, 8)}… (${voiceProvider}/${voiceId}, speed=${voiceSettings.speed ?? "default"}, pause=${autoPauseEnabled ? `${autoPauseDuration}s` : "off"})`, { stage: "tts" });
  await pollJob("tts", jobId, runId, "tts");
  await downloadJob("tts", jobId, outPath);
}

function parseFloatOr(s: string, fallback: number): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * HeyGen TTS — primary provider for Conveyer Grok.
 *
 * The VA picks (or clones) a voice once in the HeyGen dashboard → gets a
 * voice_id → user pastes it into /settings (HEYGEN_VOICE_ID). For every scene
 * the pipeline calls HeyGen with text + voice_id → gets back an mp3.
 *
 * Endpoint: `POST https://api.heygen.com/v3/voices/speech` (current v3 API)
 *   Body: { voice_id, text, locale?, speed?, pitch? }
 *   Auth: X-Api-Key header
 *   Response: may return either direct audio bytes (Content-Type: audio/*) OR
 *             JSON like { data: { audio_url: "..." } } — we handle both.
 *
 * Fallback: if v3 returns 404 on the user's plan, we retry on the legacy
 * `POST /v1/audio/text_to_speech` endpoint with the same body shape.
 * (HeyGen has shuffled this across API versions; both endpoints currently exist.)
 */
async function heygenTts(
  runId: string,
  text: string,
  outPath: string,
  voiceOverride?: string | null,
  speedOverride?: number | null
) {
  const apiKey = getSetting("HEYGEN_API_KEY");
  if (!apiKey) throw new Error("HEYGEN_API_KEY is not set — paste it in /settings");
  // A channel profile's voice_id (voiceOverride) wins over the global setting.
  const voiceId =
    voiceOverride && voiceOverride.trim().length > 0
      ? voiceOverride.trim()
      : getSetting("HEYGEN_VOICE_ID");
  if (!voiceId)
    throw new Error(
      "No HeyGen voice_id available — set HEYGEN_VOICE_ID in /settings, or add a voice_id to the channel profile in /prompts"
    );

  // Optional speed control — a per-channel speed override (studio) wins over the global TTS_SPEED (clamped to HeyGen's 0.5–1.5).
  const speedSetting = speedOverride ?? parseFloat(getSetting("TTS_SPEED"));
  const speed = Number.isFinite(speedSetting)
    ? Math.max(0.5, Math.min(1.5, speedSetting))
    : undefined;

  const body: Record<string, unknown> = { voice_id: voiceId, text };
  if (speed !== undefined) body.speed = speed;

  const tryEndpoint = async (url: string): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
        // Hint that we'd happily take raw audio back if the server prefers streaming
        Accept: "audio/mpeg, audio/wav, application/json",
      },
      body: JSON.stringify(body),
    });

  // Primary: v3. Fall back to legacy v1 if v3 fails for any of the known
  // "voice engine mismatch" reasons:
  //   - 404 (endpoint not enabled on the user's plan)
  //   - 400 with "VoiceProvider.STARFISH" / "not supported" (the voice_id is
  //     bound to an engine that /v3/voices/speech can't serve — common for
  //     stock or cloned voices that only legacy /v1 supports)
  let resp = await tryEndpoint("https://api.heygen.com/v3/voices/speech");

  if (!resp.ok) {
    // Peek at the error message without consuming the stream
    const errBodyV3 = await resp.text();
    const shouldFallback =
      resp.status === 404 ||
      (resp.status === 400 &&
        /voiceprovider|voice engine|not supported|invalid voice/i.test(errBodyV3));
    if (shouldFallback) {
      log(
        runId,
        "debug",
        `HeyGen v3 returned ${resp.status} (${errBodyV3.slice(0, 120)}) — falling back to /v1/audio/text_to_speech`,
        { stage: "tts" }
      );
      resp = await tryEndpoint("https://api.heygen.com/v1/audio/text_to_speech");
    } else {
      throw new Error(`HeyGen TTS ${resp.status}: ${errBodyV3.slice(0, 300)}`);
    }
  }

  if (!resp.ok) {
    const errBody = await resp.text();
    // Specifically diagnose the STARFISH avatar-voice case so the user knows
    // they need a different voice_id, not a code fix.
    if (
      resp.status === 400 &&
      /VoiceProvider\.STARFISH|starfish/i.test(errBody)
    ) {
      throw new Error(
        `HeyGen TTS rejected your voice_id — it appears to be a STARFISH (avatar / streaming-only) voice, not a standalone TTS voice. ` +
          `Open HeyGen dashboard → Voices (NOT Avatars / Streaming Avatars), pick a voice powered by ElevenLabs or Panda engine, copy that voice_id into /settings → HEYGEN_VOICE_ID, and re-run. ` +
          `Raw error: ${errBody.slice(0, 200)}`
      );
    }
    throw new Error(`HeyGen TTS ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  // Two response shapes possible:
  // (a) raw audio bytes (Content-Type: audio/mpeg or audio/wav) — write to disk directly
  // (b) JSON wrapper { data: { audio_url } } — download from the URL
  const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("audio/") || contentType === "application/octet-stream") {
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(outPath, buf);
    log(runId, "debug", `HeyGen TTS (raw audio, ${buf.length} bytes, voice=${voiceId.slice(0, 8)}…)`, {
      stage: "tts",
    });
    return;
  }

  // JSON path — try common audio_url field names
  const json = (await resp.json()) as {
    data?: { audio_url?: string; url?: string; audioUrl?: string };
    audio_url?: string;
    audioUrl?: string;
    url?: string;
  };
  const audioUrl =
    json.data?.audio_url ?? json.data?.url ?? json.data?.audioUrl ?? json.audio_url ?? json.audioUrl ?? json.url;
  if (!audioUrl) {
    throw new Error(
      `HeyGen TTS returned no audio_url. Payload: ${JSON.stringify(json).slice(0, 300)}`
    );
  }

  log(runId, "debug", `HeyGen TTS audio_url ready (voice=${voiceId.slice(0, 8)}…) — downloading`, { stage: "tts" });

  const audioResp = await fetch(audioUrl);
  if (!audioResp.ok) {
    throw new Error(`Failed to download HeyGen audio: ${audioResp.status} ${audioResp.statusText}`);
  }
  fs.writeFileSync(outPath, Buffer.from(await audioResp.arrayBuffer()));
}

async function elevenLabs(text: string, outPath: string) {
  const apiKey = getSetting("ELEVENLABS_API_KEY");
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  const voiceId = getSetting("TTS_VOICE_ID") || "21m00Tcm4TlvDq8ikWAM";
  const model = getSetting("TTS_MODEL") || "eleven_multilingual_v2";

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, model_id: model }),
    }
  );

  if (!resp.ok) {
    const raw = `ElevenLabs ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
    // Same classification as the studio path: never emit a bare voice_not_found —
    // say whether it's a HeyGen id, a wrong-account/stale key, or otherwise invalid.
    if (isVoiceRejection(raw)) throw new Error(await classifyVoiceError(raw, voiceId, apiKey));
    throw new Error(raw);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

/**
 * MiniMax T2A v2 — cheap, high-quality TTS provider.
 *
 * Endpoint: POST https://api.minimax.io/v1/t2a_v2?GroupId={group_id}
 *   Headers: Authorization: Bearer {api_key}, Content-Type: application/json
 *   Body: { model, text, voice_setting: { voice_id, speed, vol, pitch },
 *           audio_setting: { sample_rate, bitrate, format } }
 *   Response: { data: { audio: "<hex_string>", ... }, base_resp: {...} }
 *
 * The audio comes back as a HEX-encoded string in the JSON response — we
 * decode it to bytes and write directly to disk.
 *
 * voiceOverride: per-channel voice_id from the channel profile (wins over
 * the global MINIMAX_VOICE_ID setting).
 */
async function minimaxTts(
  runId: string,
  text: string,
  outPath: string,
  voiceOverride?: string | null,
  speedOverride?: number | null
) {
  const apiKey = getSetting("MINIMAX_API_KEY");
  if (!apiKey) throw new Error("MINIMAX_API_KEY is not set — paste it in /settings");
  const groupId = getSetting("MINIMAX_GROUP_ID");
  if (!groupId) throw new Error("MINIMAX_GROUP_ID is not set — paste it in /settings");
  const voiceId =
    voiceOverride && voiceOverride.trim().length > 0
      ? voiceOverride.trim()
      : getSetting("MINIMAX_VOICE_ID");
  if (!voiceId)
    throw new Error(
      "No MiniMax voice_id available — set MINIMAX_VOICE_ID in /settings, or add a voice_id to the channel profile in /prompts"
    );
  const model = getSetting("MINIMAX_MODEL") || "speech-02-hd";

  // Optional speed control — a per-channel speed override (studio) wins over the global TTS_SPEED (MiniMax accepts 0.5–2.0).
  const speedSetting = speedOverride ?? parseFloat(getSetting("TTS_SPEED"));
  const speed = Number.isFinite(speedSetting)
    ? Math.max(0.5, Math.min(2.0, speedSetting))
    : 1.0;

  const url = `https://api.minimax.io/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;
  const body = {
    model,
    text,
    stream: false,
    voice_setting: {
      voice_id: voiceId,
      speed,
      vol: 1.0,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: "mp3",
      channel: 1,
    },
  };

  // Retry transparently on MiniMax rate-limit / transient errors.
  // 1039 = TPM (tokens-per-minute) exceeded — common when sending consecutive
  // chunks of a long script. Wait 60s and retry, up to 8 attempts (~8 min).
  const RETRYABLE_CODES = [1039, 1027, 1042, 2049];
  const MAX_RETRIES = 8;
  let audioHex: string | undefined;
  let lastErr: string = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      // HTTP 429 from MiniMax = also rate limit, retry
      if (resp.status === 429 && attempt < MAX_RETRIES) {
        const waitMs = Math.min(60_000 * attempt, 180_000);
        log(runId, "warn", `MiniMax HTTP 429 — waiting ${Math.round(waitMs/1000)}s then retrying (${attempt}/${MAX_RETRIES})`, { stage: "tts" });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`MiniMax TTS ${resp.status}: ${errBody.slice(0, 300)}`);
    }

    const json = (await resp.json()) as {
      data?: { audio?: string; status?: number };
      base_resp?: { status_code?: number; status_msg?: string };
    };

    const code = json.base_resp?.status_code;
    if (code && code !== 0) {
      lastErr = `MiniMax TTS error ${code}: ${json.base_resp?.status_msg ?? "unknown"}`;
      if (RETRYABLE_CODES.includes(code) && attempt < MAX_RETRIES) {
        const waitMs = Math.min(60_000 * attempt, 180_000);
        log(runId, "warn", `${lastErr} — waiting ${Math.round(waitMs/1000)}s then retrying (${attempt}/${MAX_RETRIES})`, { stage: "tts" });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(lastErr);
    }

    audioHex = json.data?.audio;
    if (!audioHex) {
      throw new Error(`MiniMax TTS returned no audio. Payload: ${JSON.stringify(json).slice(0, 300)}`);
    }
    break;
  }

  if (!audioHex) throw new Error(lastErr || "MiniMax TTS exhausted retries");

  const buf = Buffer.from(audioHex, "hex");
  fs.writeFileSync(outPath, buf);

  log(runId, "debug", `MiniMax TTS (${buf.length} bytes, voice=${voiceId.slice(0, 16)}…)`, {
    stage: "tts",
  });
}

// Dead-socket ceilings for the two async task-API providers below (GenAIPro and AI84,
// which was copied from it). Detectors, not perf caps — see services/http.ts.
const GENAIPRO_CREATE_TIMEOUT_MS = 60_000; // billable create POST
const GENAIPRO_POLL_TIMEOUT_MS = 30_000; // single status GET
const GENAIPRO_DOWNLOAD_TIMEOUT_MS = 120_000; // finished mp3 download
const AI84_CREATE_TIMEOUT_MS = 60_000; // billable create POST
const AI84_POLL_TIMEOUT_MS = 30_000; // single status GET
const AI84_DOWNLOAD_TIMEOUT_MS = 120_000; // signed-URL mp3 download

// Same three windows for ai33 — separately named because they are separately tunable and
// the two providers have nothing to do with each other beyond both being task APIs.
const AI33_CREATE_TIMEOUT_MS = 60_000; // billable create POST
const AI33_POLL_TIMEOUT_MS = 30_000; // single status GET
const AI33_DOWNLOAD_TIMEOUT_MS = 120_000; // finished-audio download

/**
 * GenAIPro Labs TTS — an ElevenLabs reseller exposed through an ASYNC task API.
 *
 * Flow mirrors the 69labs create→poll→download shape, but against GenAIPro's own
 * base URL + bearer auth (the labs69 client is hardwired to 69labs, so this is
 * self-contained here):
 *   1. POST /labs/task           → { task_id }
 *   2. GET  /labs/task/{task_id} → poll until status === "completed"; `result`
 *                                  is an HTTPS mp3 URL
 *   3. download that URL to outPath
 *
 * `model_id` values are ElevenLabs model names (eleven_multilingual_v2, etc.).
 * Voice tuning reuses the shared TTS_* settings (speed/style/similarity/
 * stability/speaker-boost) — same knobs the 69labs ElevenLabs path uses — so no
 * GenAIPro-specific tuning UI is needed. No word timestamps are returned here;
 * the voiceover lane recovers them via Groq Whisper / proportional split.
 *
 * voiceOverride: per-channel voice_id from the channel profile (wins over the
 * global GENAIPRO_VOICE_ID setting).
 */
async function genaiproTts(
  runId: string,
  text: string,
  outPath: string,
  voiceOverride?: string | null,
  speedOverride?: number | null
) {
  const apiKey = getSetting("GENAIPRO_API_KEY");
  if (!apiKey) throw new Error("GENAIPRO_API_KEY is not set — paste it in /settings");
  const voiceId =
    voiceOverride && voiceOverride.trim().length > 0
      ? voiceOverride.trim()
      : getSetting("GENAIPRO_VOICE_ID");
  if (!voiceId)
    throw new Error(
      "No GenAIPro voice_id available — set GENAIPRO_VOICE_ID in /settings, or add a voice_id to the channel profile in /prompts"
    );
  const modelId = getSetting("GENAIPRO_MODEL") || "eleven_multilingual_v2";

  const BASE = "https://genaipro.io/api/v1";
  const authHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // Build the request body. Voice tuning reuses the shared TTS_* settings (the
  // same fine-tuning the ElevenLabs paths read), each only sent when set.
  // `speed` is MANDATORY for GenAIPro and must be in 0.7–1.2 — the API rejects a
  // missing/out-of-range value ("Speed must be between 0.7 and 1.2"), so we
  // always send one, defaulting to a neutral 1.0 when TTS_SPEED is unset.
  const body: Record<string, unknown> = { input: text, voice_id: voiceId, model_id: modelId };
  body.speed = clamp(speedOverride ?? parseFloatOr(getSetting("TTS_SPEED"), 1.0), 0.7, 1.2);
  const style = parseFloatOr(getSetting("TTS_STYLE"), NaN);
  if (!Number.isNaN(style)) body.style = clamp(style, 0, 1);
  const similarity = parseFloatOr(getSetting("TTS_SIMILARITY_BOOST"), NaN);
  if (!Number.isNaN(similarity)) body.similarity = clamp(similarity, 0, 1);
  const stability = parseFloatOr(getSetting("TTS_STABILITY"), NaN);
  if (!Number.isNaN(stability)) body.stability = clamp(stability, 0, 1);
  const speakerBoost = getSetting("TTS_USE_SPEAKER_BOOST");
  if (speakerBoost === "1") body.use_speaker_boost = true;
  else if (speakerBoost === "0") body.use_speaker_boost = false;

  // 1) Create the task. Billable → retryOnTimeout:false (an aborted POST may already have
  // created and charged the task). Same policy split as AI84, which was copied from here.
  const createResp = await requestWithPolicy(
    `${BASE}/labs/task`,
    { method: "POST", headers: authHeaders, body: JSON.stringify(body) },
    "GenAIPro create",
    { timeoutMs: GENAIPRO_CREATE_TIMEOUT_MS, retryOnTimeout: false, maxAttempts: 2 }
  );
  if (!createResp.ok) {
    throw new Error(`GenAIPro create ${createResp.status}: ${(await createResp.text()).slice(0, 300)}`);
  }
  const created = (await createResp.json()) as {
    task_id?: string;
    id?: string;
    data?: { task_id?: string; id?: string };
  };
  const taskId = created.task_id ?? created.id ?? created.data?.task_id ?? created.data?.id;
  if (!taskId) {
    throw new Error(`GenAIPro create returned no task_id. Payload: ${JSON.stringify(created).slice(0, 300)}`);
  }
  log(runId, "debug", `GenAIPro TTS task ${String(taskId).slice(0, 8)}… (${modelId}/${voiceId.slice(0, 8)}…)`, {
    stage: "tts",
  });

  // 2) Poll until completed. 8-min ceiling matches the 69labs poller.
  const POLL_INTERVAL_MS = 2500;
  const POLL_MAX_MS = 8 * 60 * 1000;
  const start = Date.now();
  let audioUrl: string | undefined;
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    // Free + idempotent → retryOnTimeout:true. A transport fault must not destroy a task
    // that is already created and billed; keep polling to the deadline (anchored to `start`).
    let pollResp: Response;
    try {
      pollResp = await requestWithPolicy(
        `${BASE}/labs/task/${encodeURIComponent(String(taskId))}`,
        { headers: authHeaders },
        `GenAIPro poll ${taskId}`,
        { timeoutMs: GENAIPRO_POLL_TIMEOUT_MS, retryOnTimeout: true, retryStatus: false }
      );
    } catch (e) {
      if (Date.now() - start > POLL_MAX_MS) throw e;
      log(runId, "warn", `GenAIPro poll transport error (${errorChainText(e)}) — task ${taskId} still running, retrying`, {
        stage: "tts",
      });
      continue;
    }
    if (!pollResp.ok) {
      if (pollResp.status === 429) continue; // transient — keep polling
      throw new Error(`GenAIPro poll ${pollResp.status}: ${(await pollResp.text()).slice(0, 200)}`);
    }
    const j = (await pollResp.json()) as {
      status?: string;
      result?: string;
      url?: string;
      error?: string;
      message?: string;
      data?: { status?: string; result?: string; url?: string };
    };
    const status = (j.status ?? j.data?.status ?? "").toLowerCase();
    if (status === "completed" || status === "success" || status === "done") {
      audioUrl = j.result ?? j.url ?? j.data?.result ?? j.data?.url;
      if (!audioUrl) {
        throw new Error(`GenAIPro task completed but returned no audio URL. Payload: ${JSON.stringify(j).slice(0, 300)}`);
      }
      break;
    }
    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`GenAIPro task ${taskId} ${status}${j.error || j.message ? `: ${j.error ?? j.message}` : ""}`);
    }
    if (Date.now() - start > POLL_MAX_MS) {
      throw new Error(`GenAIPro task ${taskId} exceeded ${POLL_MAX_MS / 1000}s polling timeout`);
    }
  }

  // 3) Download the finished mp3. Free + idempotent, and already paid for.
  const audioResp = await requestWithPolicy(
    audioUrl,
    { redirect: "follow" },
    `GenAIPro download ${taskId}`,
    { timeoutMs: GENAIPRO_DOWNLOAD_TIMEOUT_MS, retryOnTimeout: true, retryStatus: true }
  );
  if (!audioResp.ok) {
    throw new Error(`GenAIPro download failed for task ${taskId}: ${audioResp.status} ${audioResp.statusText}`);
  }
  const buf = Buffer.from(await audioResp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  log(runId, "debug", `GenAIPro TTS (${buf.length} bytes, voice=${voiceId.slice(0, 8)}…)`, { stage: "tts" });
}

/**
 * AI84 (api.ai84.pro) — an ElevenLabs/MiniMax reseller with an async TTS task API.
 * Same async create→poll→download shape as GenAIPro, but with the AI84-specific
 * differences from the audit baked in:
 *   1. auth via `xi-api-key` (NOT a Bearer token),
 *   2. /v2/text-to-speech/async endpoints,
 *   3. nested `voice_settings` body (`similarity_boost` naming; speed range 0.5–2),
 *   4. audio URL is `job.audioUrl`,
 *   5/8. status vocab queued/processing/done/failed — HTTP 200 does NOT imply success,
 *   6. a 5xx (or 429) DURING polling means "still running" → keep polling, do not fail,
 *   7. the credit-consuming create POST is rate-limited (60/min) → honor Retry-After on 429,
 *   9. record the billed credits (this non-ElevenLabs lane is otherwise unmetered),
 *   10. audio URLs are short-lived signed URLs → download immediately.
 * Produces audio only; word timings are recovered downstream by alignWords() exactly
 * as for every other non-ElevenLabs provider.
 *
 * Every request goes through requestWithPolicy (services/http.ts). A naked fetch() has
 * no timeout and no transport-error handling at all, which is what killed a real run:
 * the job was created and ~950 credits were billed, then a transient `fetch failed`
 * 78s into polling destroyed the run. See the per-call-site policies below.
 */
async function ai84Tts(
  runId: string,
  text: string,
  outPath: string,
  voiceOverride?: string | null,
  speedOverride?: number | null,
  modelOverride?: string | null
) {
  const apiKey = getSetting("AI84_API_KEY");
  if (!apiKey) throw new Error("AI84_API_KEY is not set — paste it in /settings");
  const fromOverride = !!(voiceOverride && voiceOverride.trim().length > 0);
  const voiceId = fromOverride ? voiceOverride!.trim() : getSetting("AI84_VOICE_ID");
  // A per-run model (snapshotted when the operator picked a voice for THIS video) wins
  // over the global setting — that is what lets two runs use different engines at the same
  // time. Absent, this is exactly the previous behaviour.
  const modelId = modelOverride?.trim() || getSetting("AI84_MODEL") || "eleven_multilingual_v2";
  // AI84 fronts two engines and the MODEL picks one. Empty/legacy value → elevenlabs, so
  // every pre-existing install behaves exactly as before (see providers.ts).
  const backend = ai84Backend(modelId);
  // Every AI84 voice rejection gets the same actionable treatment: the full id, the field
  // that holds it, and the provider's own words.
  //
  // `expectsElevenLabsShape` MUST follow the engine. On MiniMax a cloned id like
  // `user_7744_voice_1786013694967` is perfectly valid, so telling the operator it "doesn't
  // look like an ElevenLabs id" would be confidently wrong — the same mistake, in the same
  // message, that sent a real client to check the wrong account.
  const rejection = (rawMsg: string) =>
    new Error(
      describeProviderVoiceRejection({
        providerLabel: "AI84",
        voiceId,
        voiceIdKey: "AI84_VOICE_ID",
        fromOverride,
        rawMsg,
        expectsElevenLabsShape: backend === "elevenlabs",
        // On MiniMax the voice is rejected at create, before anything is billed — worth
        // saying, because the operator's first fear is that the failed attempt cost money.
        chargedForThisAttempt: backend === "elevenlabs",
        suggestion: ai84VoiceModelMismatch(voiceId, modelId),
      })
    );
  if (!voiceId)
    throw new Error(
      "No AI84 voice_id available — set AI84_VOICE_ID in /settings, or add a voice_id to the channel profile in /prompts"
    );

  const BASE = "https://api.ai84.pro";
  // AI84 auth is ElevenLabs-shaped: the key travels in `xi-api-key`, not a Bearer token.
  const authHeaders = { "xi-api-key": apiKey, "Content-Type": "application/json" };

  // Speed is the ONLY tuning both engines understand, and the only one with a per-channel
  // override. Range 0.5–2 is verified for the ElevenLabs engine; for MiniMax it matches
  // what our own direct MiniMax client (minimaxTts) clamps to, but is NOT confirmed
  // against this proxy — if a 400 ever comes back, fix it from the response, not by guess.
  const speed = clamp(speedOverride ?? parseFloatOr(getSetting("TTS_SPEED"), 1.0), 0.5, 2);

  // Two engines, two request builders, no shared body — see services/ai84-request.ts.
  let create: Ai84CreateRequest;
  if (backend === "minimax") {
    create = buildAi84MinimaxCreate({ text, voiceId, modelId, speed });
  } else {
    // ElevenLabs tuning stays nested and complete; only set values are sent.
    const voiceSettings: ElevenVoiceSettings = { speed };
    const style = parseFloatOr(getSetting("TTS_STYLE"), NaN);
    if (!Number.isNaN(style)) voiceSettings.style = clamp(style, 0, 1);
    const similarity = parseFloatOr(getSetting("TTS_SIMILARITY_BOOST"), NaN);
    if (!Number.isNaN(similarity)) voiceSettings.similarity_boost = clamp(similarity, 0, 1);
    const stability = parseFloatOr(getSetting("TTS_STABILITY"), NaN);
    if (!Number.isNaN(stability)) voiceSettings.stability = clamp(stability, 0, 1);
    const speakerBoost = getSetting("TTS_USE_SPEAKER_BOOST");
    if (speakerBoost === "1") voiceSettings.use_speaker_boost = true;
    else if (speakerBoost === "0") voiceSettings.use_speaker_boost = false;
    create = buildAi84ElevenCreate({ text, voiceId, modelId, voiceSettings });
  }
  const body = create.body;

  // 1) Create the job. This credit-consuming POST is rate-limited (60/min per IP);
  // on 429 honor Retry-After and retry rather than failing the run.
  //
  // BILLABLE → retryOnTimeout:false. An aborted POST may already have created (and
  // charged for) the job; re-sending would bill a second one. retryStatus:false keeps
  // the 429 loop below in charge — it honors Retry-After and logs a heartbeat, neither
  // of which the generic policy does. maxAttempts:2 (not the default 3) because
  // `provesRequestNeverArrived` matches /fetch failed/, which Node also emits for an
  // ECONNRESET *after* the bytes went out: allow one re-send, not two.
  let jobId: string | undefined;
  let credits = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const createResp = await requestWithPolicy(
      `${BASE}${create.path}`,
      { method: "POST", headers: authHeaders, body: JSON.stringify(body) },
      "AI84 create",
      { timeoutMs: AI84_CREATE_TIMEOUT_MS, retryOnTimeout: false, retryStatus: false, maxAttempts: 2 }
    );
    if (createResp.status === 429) {
      const retryAfter = Math.min(60, Math.max(1, parseInt(createResp.headers.get("Retry-After") || "5", 10) || 5));
      log(runId, "warn", `AI84 create rate-limited (429) — waiting ${retryAfter}s`, { stage: "tts" });
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!createResp.ok) {
      const raw = `AI84 create ${createResp.status}: ${(await createResp.text()).slice(0, 300)}`;
      throw isVoiceRejection(raw) ? rejection(raw) : new Error(raw);
    }
    const created = (await createResp.json()) as {
      job_id?: string;
      task_id?: string;
      status?: string;
      credit_cost?: number;
    };
    jobId = created.job_id ?? created.task_id;
    credits = created.credit_cost ?? 0;
    if (!jobId) {
      throw new Error(`AI84 create returned no job_id. Payload: ${JSON.stringify(created).slice(0, 300)}`);
    }
    break;
  }
  if (!jobId) throw new Error("AI84 create failed after repeated rate-limit (429) retries");
  // Log the FULL voice id and WHERE it came from, as the ElevenLabs path does. The old
  // line truncated it to 8 chars, so a real failed run told us only "user_774…" — not
  // enough to see that a leftover channel override had been sent to AI84.
  //
  // "this run's voice", not "channel override": the override arrives here identically
  // whether it was picked for this video or set on its channel, and the pipeline has no way
  // to tell them apart. Naming one would be a guess printed as a fact.
  //
  // The engine is spelled out with the global model beside it, because "the setting says
  // ElevenLabs but this video ran on MiniMax" is the whole behaviour of this feature and an
  // operator has no other way to confirm it happened.
  const engineNote = modelOverride?.trim()
    ? `engine chosen by this voice; AI84_MODEL is ${getSetting("AI84_MODEL") || "unset"}`
    : "engine from AI84_MODEL";
  log(
    runId,
    "debug",
    `AI84 TTS job ${jobId} · ${backend} · model ${modelId} · voice ${voiceId} (${
      fromOverride ? "this run's voice" : "global AI84_VOICE_ID"
    } · ${engineNote}) · ~${credits} credits`,
    { stage: "tts" }
  );

  // Meter the spend HERE, at the moment it happens — not after the download. AI84 bills
  // on create, so a job that is created and then fails (bad voice) or whose download
  // never happens (network fault) has still cost real credits. Recording only on success
  // made /costs silently understate AI84 by every failed run.
  let recorded = 0;
  if (credits > 0) {
    recordAi84(runId, credits);
    recorded = credits;
  }

  // 2) Poll until terminal. Per AI84 docs: HTTP 200 does NOT mean success (read
  // job.status), and a 5xx (or 429) during polling means the job is still
  // running — keep polling. `done` = success; `failed`/`error` = failure;
  // anything else (queued/processing/waiting_retry/unknown) is non-terminal.
  const POLL_INTERVAL_MS = 3000;
  const POLL_MAX_MS = 10 * 60 * 1000;
  const start = Date.now();
  let audioUrl: string | undefined;
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    // FREE + IDEMPOTENT → retryOnTimeout:true (re-asking a dead socket is the rescue).
    // retryStatus:false so the 5xx/429 = "still running" rule below stays in charge.
    let pollResp: Response;
    try {
      pollResp = await requestWithPolicy(
        `${BASE}/v2/text-to-speech/async/${encodeURIComponent(jobId)}`,
        { headers: { "xi-api-key": apiKey } },
        `AI84 poll ${jobId}`,
        { timeoutMs: AI84_POLL_TIMEOUT_MS, retryOnTimeout: true, retryStatus: false }
      );
    } catch (e) {
      // A transport fault on a FREE, IDEMPOTENT status read must never destroy a job we
      // have already paid for — the job keeps running on AI84's side regardless. Treat it
      // exactly like a 5xx: keep polling until the deadline, which stays anchored to
      // `start` so a retry can never extend it.
      if (Date.now() - start > POLL_MAX_MS) throw e;
      log(runId, "warn", `AI84 poll transport error (${errorChainText(e)}) — job ${jobId} still running, retrying`, {
        stage: "tts",
      });
      continue;
    }
    if (!pollResp.ok) {
      // 5xx / 429 during polling are transient (the job keeps running) — keep polling to the deadline.
      if (pollResp.status >= 500 || pollResp.status === 429) {
        if (Date.now() - start > POLL_MAX_MS) throw new Error(`AI84 job ${jobId} exceeded ${POLL_MAX_MS / 1000}s (last poll ${pollResp.status})`);
        continue;
      }
      throw new Error(`AI84 poll ${pollResp.status}: ${(await pollResp.text()).slice(0, 200)}`);
    }
    const j = (await pollResp.json()) as {
      job?: {
        status?: string;
        audioUrl?: string;
        credit_cost?: number;
        errorMessage?: string;
        errorMessageKey?: string;
      };
    };
    const job = j.job ?? {};
    const status = (job.status ?? "").toLowerCase();
    // The job may settle on a final credit_cost that differs from the create estimate.
    // Record only a POSITIVE delta: the create charge is already in the ledger, and a
    // lower final figure is not a credit-back we're entitled to invent.
    if (typeof job.credit_cost === "number") {
      credits = job.credit_cost;
      if (credits > recorded) {
        recordAi84(runId, credits - recorded);
        recorded = credits;
      }
    }
    if (status === "done") {
      audioUrl = job.audioUrl;
      if (!audioUrl) throw new Error(`AI84 job ${jobId} done but returned no audioUrl. Payload: ${JSON.stringify(j).slice(0, 300)}`);
      break;
    }
    if (status === "failed" || status === "error") {
      const key = job.errorMessageKey ? ` [${job.errorMessageKey}]` : "";
      const raw = `AI84 job ${jobId} ${status}${key}: ${job.errorMessage ?? "unknown error"}`;
      // A voice rejection is the one failure the operator can actually fix, so say which
      // voice and which field instead of passing AI84's "choose another one" through bare.
      throw isVoiceRejection(raw) ? rejection(raw) : new Error(raw);
    }
    if (Date.now() - start > POLL_MAX_MS) {
      throw new Error(`AI84 job ${jobId} exceeded ${POLL_MAX_MS / 1000}s polling timeout (last status: ${status || "unknown"})`);
    }
  }

  // 3) Download the finished mp3 immediately — AI84 audio URLs are short-lived signed URLs.
  // FREE + IDEMPOTENT, and the audio is already paid for → retry both our own timeout and
  // a transient 5xx from the signing CDN. The job id goes in the error because it is the
  // only evidence the operator can take to AI84 for a job they were billed for.
  const audioResp = await requestWithPolicy(
    audioUrl,
    { redirect: "follow" },
    `AI84 download ${jobId}`,
    { timeoutMs: AI84_DOWNLOAD_TIMEOUT_MS, retryOnTimeout: true, retryStatus: true }
  );
  if (!audioResp.ok) {
    throw new Error(`AI84 download failed for job ${jobId}: ${audioResp.status} ${audioResp.statusText}`);
  }
  const buf = Buffer.from(await audioResp.arrayBuffer());
  fs.writeFileSync(outPath, buf);

  log(runId, "debug", `AI84 TTS (${buf.length} bytes, voice=${voiceId.slice(0, 8)}…, ${credits} credits)`, { stage: "tts" });
}

/**
 * Runs that have already been told ai33 reported no credit figure. Once per run, not per
 * chunk: a long script is synthesized in several calls and a line each would bury the fact
 * rather than surface it. Same shape as gemini-quota.ts / vision-qc.ts.
 */
const ai33UnbilledNotified = new Set<string>();
/** Test seam — forget a run's notice so the once-per-run behaviour can be exercised. */
export function __resetAi33UnbilledNotice(runId?: string): void {
  if (runId) ai33UnbilledNotified.delete(runId);
  else ai33UnbilledNotified.clear();
}

/**
 * ai33.pro (product name: OpenSpeaker) — an async TTS task API fronting SIX engines
 * (clone / elevenlabs / minimax / fishaudio / edge / vbee) behind one key and one credit
 * balance.
 *
 * WHY THERE IS NO ENGINE SETTING, AND MUST NOT BE: an ai33 voice id is `"<engine>:<id>"`,
 * so the engine travels inside the voice and this function never has to decide one. That
 * is the whole reason ai33 needs none of AI84's engine-resolution machinery
 * (`resolveAi84Backend`, the catalogue cache, the per-run `voice_model` snapshot): the
 * state those exist to prevent — engine and voice disagreeing — cannot be expressed here.
 *
 * THE CONTRACT IS NOT LIVE-VERIFIED, unlike every other provider in this file. ai33 issues
 * API keys only on donation and puts its real API document behind Cloudflare + a login, so
 * no probe was possible. Concretely that means the exact spelling of the task-id, status,
 * audio-URL and credit fields is unknown, and it is read tolerantly instead of guessed —
 * see the header of ai33-response.ts, which also explains why an unreadable payload is
 * quoted back verbatim in the error rather than summarised.
 *
 * What is NOT hedged is the money. Credits are recorded the moment a figure appears,
 * wherever it appears, and only ever as a POSITIVE delta. That covers both possible
 * billing moments (at create, as AI84 does, or on completion) without having to know which
 * one ai33 uses, and without a lower late figure inventing a refund we are not owed.
 */
async function ai33Tts(
  runId: string,
  text: string,
  outPath: string,
  voiceOverride?: string | null,
  speedOverride?: number | null
) {
  const apiKey = getSetting("AI33_API_KEY");
  if (!apiKey) throw new Error("AI33_API_KEY is not set — paste it in /settings");
  const fromOverride = !!(voiceOverride && voiceOverride.trim().length > 0);
  const voiceId = fromOverride ? voiceOverride!.trim() : getSetting("AI33_VOICE_ID");
  if (!voiceId)
    throw new Error(
      "No ai33 voice_id available — set AI33_VOICE_ID in /settings (use “Load voices”, which writes the full “<engine>:<id>” form), or add a voice_id to the channel profile in /channels"
    );
  // Host is a setting because ai33.pro and openspeaker.ai are the same product served from
  // two names, and which one an account is issued against could not be verified. Blank =
  // the documented default, so nobody has to fill it in.
  const BASE = (getSetting("AI33_BASE_URL") || AI33_DEFAULT_BASE).replace(/\/+$/, "");
  // Auth is ElevenLabs-SHAPED (`xi-api-key`) and that is all it is. ai33 states that
  // synthesis runs through its own bridge, so nothing ElevenLabs-specific may be inferred:
  // in particular classifyVoiceError stays away from here, since it would send this key to
  // api.elevenlabs.io and then name ELEVENLABS_VOICE_ID. Same trap as AI84.
  const authHeaders = { "xi-api-key": apiKey, "Content-Type": "application/json" };

  // Every ai33 voice rejection gets the full id, the field holding it, and ai33's own words.
  // `expectsElevenLabsShape` is deliberately OFF: ai33's six engines take six different id
  // forms (an Edge voice is `en-US-GuyNeural`), so calling one "not ElevenLabs-shaped" would
  // be confidently wrong in the one message the operator is relying on.
  const rejection = (rawMsg: string) =>
    new Error(
      describeProviderVoiceRejection({
        providerLabel: "ai33.pro",
        voiceId,
        voiceIdKey: "AI33_VOICE_ID",
        fromOverride,
        rawMsg,
        suggestion: ai33VoiceIdUnqualified(voiceId),
      })
    );

  // Documented range is 0.5–1.5 — narrower than AI84's, so it is clamped separately rather
  // than sharing a constant that would silently send an out-of-range value to one of them.
  const speed = clamp(speedOverride ?? parseFloatOr(getSetting("TTS_SPEED"), 1.0), 0.5, 1.5);
  const body = { text, voice_id: voiceId, speed };

  // 1) Create the job. BILLABLE → retryOnTimeout:false: an aborted POST may already have
  // created (and charged for) the job, and re-sending would bill a second one.
  // retryStatus:false keeps the 429 loop below in charge — it honors Retry-After, which the
  // generic policy does not. maxAttempts:2 because `provesRequestNeverArrived` matches
  // /fetch failed/, which Node also emits for an ECONNRESET *after* the bytes went out.
  let taskId: string | undefined;
  let credits = 0;
  let recorded = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const createResp = await requestWithPolicy(
      `${BASE}/v3/text-to-speech`,
      { method: "POST", headers: authHeaders, body: JSON.stringify(body) },
      "ai33 create",
      { timeoutMs: AI33_CREATE_TIMEOUT_MS, retryOnTimeout: false, retryStatus: false, maxAttempts: 2 }
    );
    if (createResp.status === 429) {
      const retryAfter = Math.min(60, Math.max(1, parseInt(createResp.headers.get("Retry-After") || "5", 10) || 5));
      log(runId, "warn", `ai33 create rate-limited (429) — waiting ${retryAfter}s`, { stage: "tts" });
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!createResp.ok) {
      const raw = `ai33 create ${createResp.status}: ${(await createResp.text()).slice(0, 300)}`;
      // A credit wall PAUSES the run (pauseRunForOperator marks it cancelled/resumable) —
      // but this call sits outside any per-beat loop, with no later checkCancelled()
      // checkpoint downstream to convert that into a CancelledError before it reaches the
      // top-level pipeline catch. Throwing a plain Error here raced right past the pause:
      // studio-pipeline's catch only spares CancelledError from overwriting the run back to
      // 'error' (unresumable) — confirmed live, a real run logged "pausing this run now...
      // click Resume" and then landed as status=error, canResume=false anyway.
      if (noteCreditExhausted(runId, "ai33", raw, "tts")) throw new CancelledError(raw);
      throw isVoiceRejection(raw) || ai33LooksLikeVoiceRejection(raw) ? rejection(raw) : new Error(raw);
    }
    const created: unknown = await createResp.json();
    taskId = pickTaskId(created) ?? undefined;
    if (!taskId) {
      // The payload goes into the message on purpose — see describeUnparsed. This is the
      // one line that turns an unverifiable contract into a verified one.
      throw new Error(describeUnparsed("create returned no task id", created));
    }
    // Credits may be reported here (AI84 bills at create) or only on completion. Take
    // whichever arrives first; the poll loop records any further increase.
    const atCreate = readTaskState(created).credits;
    if (atCreate && atCreate > 0) {
      recordAi33(runId, atCreate);
      credits = atCreate;
      recorded = atCreate;
    }
    break;
  }
  if (!taskId) throw new Error("ai33 create failed after repeated rate-limit (429) retries");

  // The FULL voice id and where it came from — truncating it is how a real AI84 failure
  // told us only "user_774…", which was not enough to see that a leftover channel override
  // had been sent. "this run's voice", not "channel override": the override arrives here
  // identically whether it was picked for this video or set on its channel.
  log(
    runId,
    "debug",
    `ai33 TTS task ${taskId} · voice ${voiceId} (${fromOverride ? "this run's voice" : "global AI33_VOICE_ID"})`,
    { stage: "tts" }
  );

  // 2) Poll until terminal. A 5xx/429 or a transport fault means the job is STILL RUNNING,
  // not that the run died — a naked fetch in this position destroyed a real AI84 run 78s
  // after ~950 credits had already been spent. The deadline stays anchored to `start`, so
  // no retry can extend it.
  const POLL_INTERVAL_MS = 3000;
  const POLL_MAX_MS = 10 * 60 * 1000;
  const start = Date.now();
  let audioUrl: string | undefined;
  let lastPayload: unknown = null;
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let pollResp: Response;
    try {
      // FREE + IDEMPOTENT → retryOnTimeout:true (re-asking a dead socket is the rescue).
      // retryStatus:false so the "5xx = still running" rule below stays in charge.
      pollResp = await requestWithPolicy(
        `${BASE}/v1/task/${encodeURIComponent(taskId)}`,
        { headers: { "xi-api-key": apiKey } },
        `ai33 poll ${taskId}`,
        { timeoutMs: AI33_POLL_TIMEOUT_MS, retryOnTimeout: true, retryStatus: false }
      );
    } catch (e) {
      if (Date.now() - start > POLL_MAX_MS) throw e;
      log(runId, "warn", `ai33 poll transport error (${errorChainText(e)}) — task ${taskId} still running, retrying`, {
        stage: "tts",
      });
      continue;
    }
    if (!pollResp.ok) {
      if (pollResp.status >= 500 || pollResp.status === 429) {
        if (Date.now() - start > POLL_MAX_MS)
          throw new Error(`ai33 task ${taskId} exceeded ${POLL_MAX_MS / 1000}s (last poll ${pollResp.status})`);
        continue;
      }
      throw new Error(`ai33 poll ${pollResp.status}: ${(await pollResp.text()).slice(0, 200)}`);
    }
    lastPayload = await pollResp.json();
    const state = readTaskState(lastPayload);
    // Record only a POSITIVE delta: any create-time charge is already in the ledger, and a
    // lower late figure is not a credit-back we are entitled to invent.
    if (state.credits !== null && state.credits > recorded) {
      recordAi33(runId, state.credits - recorded);
      credits = state.credits;
      recorded = state.credits;
    }
    if (state.phase === "done") {
      audioUrl = state.audioUrl ?? undefined;
      if (!audioUrl) throw new Error(describeUnparsed(`task ${taskId} finished but returned no audio URL`, lastPayload));
      break;
    }
    if (state.phase === "failed") {
      const raw = `ai33 task ${taskId} ${state.rawStatus || "failed"}: ${state.error ?? "unknown error"}`;
      // See the create-time credit wall above for why this must be a CancelledError, not a
      // plain one, when noteCreditExhausted just paused the run.
      if (noteCreditExhausted(runId, "ai33", raw, "tts")) throw new CancelledError(raw);
      // The shared predicate needs a 400/404 or the literal `voice_not_found` token, and a
      // failed TASK carries neither — so a bad voice id, by far the likeliest failure here,
      // would otherwise arrive with no hint of which field to change.
      throw isVoiceRejection(raw) || ai33LooksLikeVoiceRejection(raw) ? rejection(raw) : new Error(raw);
    }
    if (Date.now() - start > POLL_MAX_MS) {
      // The last payload is quoted because an unrecognised status word is the most likely
      // reason a healthy job never looked finished — and it is one line to fix once seen.
      throw new Error(
        describeUnparsed(`task ${taskId} exceeded ${POLL_MAX_MS / 1000}s polling (last status "${state.rawStatus || "unknown"}")`, lastPayload)
      );
    }
  }

  // 3) Download the finished audio. FREE + IDEMPOTENT, and already paid for → retry both
  // our own timeout and a transient 5xx. The task id goes in the error because it is the
  // only evidence the operator can take to ai33 for a job they were billed for.
  const audioResp = await requestWithPolicy(
    audioUrl,
    { redirect: "follow" },
    `ai33 download ${taskId}`,
    { timeoutMs: AI33_DOWNLOAD_TIMEOUT_MS, retryOnTimeout: true, retryStatus: true }
  );
  if (!audioResp.ok) {
    throw new Error(`ai33 download failed for task ${taskId}: ${audioResp.status} ${audioResp.statusText}`);
  }
  // A page or a JSON error served with a 200 must never be written to disk as "audio".
  // This guard is what makes the tolerant URL reading in ai33-response.ts safe: the last
  // alias it accepts is a bare `url`, which on an unknown payload shape could just as well
  // be a self-link to the task. A wrong file here would not fail loudly — it would become a
  // silently wrong duration, and every beat timing in the video derives from that number.
  const ctype = (audioResp.headers.get("content-type") || "").toLowerCase();
  if (/^(text\/|application\/(json|xml))/.test(ctype)) {
    throw new Error(describeUnparsed(`task ${taskId} audio URL served "${ctype}" instead of audio (${audioUrl})`, lastPayload));
  }
  const ai33Buf = Buffer.from(await audioResp.arrayBuffer());
  if (ai33Buf.length === 0) throw new Error(`ai33 returned an empty audio file for task ${taskId}`);
  fs.writeFileSync(outPath, ai33Buf);

  // Spend that was never reported must not read as free. /costs would otherwise show ai33
  // at €0.00 over a whole run — the "confident zero" this codebase treats as its worst
  // reporting failure. Say it once, name the consequence, and keep the run going.
  if (recorded === 0 && !ai33UnbilledNotified.has(runId)) {
    ai33UnbilledNotified.add(runId);
    log(
      runId,
      "warn",
      `ai33 reported no credit figure for this narration, so its spend is NOT on the Costs page — ` +
        `the video is fine, only the cost is unrecorded. Check the balance on ai33.pro, and send ` +
        `support this task id so the field can be pinned: ${taskId}`,
      { stage: "tts" }
    );
  }

  log(runId, "debug", `ai33 TTS (${ai33Buf.length} bytes, voice=${voiceId}, ${credits} credits)`, { stage: "tts" });
}

/**
 * Shared "POST text → get mp3 bytes back" transport for the SYNCHRONOUS TTS providers
 * (Fish Audio, Hume). The async task-API providers (69labs / GenAIPro / AI84) keep their
 * own create→poll→download loops; this covers only the one-shot shape, so neither family
 * duplicates the other's control flow.
 *
 * It exists to make the failure modes uniform and NAMED, because the thing this replaces
 * is a bare "Generate failed":
 *   - our own timeout (a hung connection can't stall a run forever),
 *   - 429 / 5xx retried with backoff, honoring Retry-After,
 *   - non-OK responses handed to the caller's `describeError` so the message says which
 *     provider failed and why (bad key vs no balance vs bad voice), not just a status,
 *   - a 200 that is actually JSON/text — i.e. an error served with the wrong status —
 *     surfaced with its payload instead of being written to disk as "audio",
 *   - an empty body, and a body that isn't an MP3 at all, rejected here rather than
 *     becoming a silently wrong duration (every beat timing derives from that number).
 */
async function fetchTtsAudio(opts: {
  runId: string;
  provider: string;
  url: string;
  init: RequestInit;
  /** Provider-specific reading of a non-OK response. Return null to use the generic message. */
  describeError?: (status: number, body: string) => string | null;
}): Promise<Buffer> {
  const { runId, provider, url, init, describeError } = opts;
  const TIMEOUT_MS = 300_000;
  const MAX_ATTEMPTS = 4;
  let lastErr = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      // Abort = our timeout; anything else = a genuine network fault. Both are transient.
      const err = e as Error;
      lastErr =
        err.name === "AbortError"
          ? `${provider} TTS timed out after ${TIMEOUT_MS / 1000}s`
          : `${provider} TTS network error: ${err.message}`;
      if (attempt === MAX_ATTEMPTS) throw new Error(lastErr);
      const waitMs = 2000 * Math.pow(2, attempt - 1);
      log(runId, "warn", `${lastErr} — retrying in ${waitMs / 1000}s (${attempt}/${MAX_ATTEMPTS})`, { stage: "tts" });
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 400);
      // Rate limit / server-side blip → back off and retry rather than failing the run.
      if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_ATTEMPTS) {
        const retryAfter = parseInt(resp.headers.get("Retry-After") || "", 10);
        const waitMs = Number.isFinite(retryAfter)
          ? Math.min(60_000, Math.max(1000, retryAfter * 1000))
          : 2000 * Math.pow(2, attempt - 1);
        log(
          runId,
          "warn",
          `${provider} TTS ${resp.status} — waiting ${Math.round(waitMs / 1000)}s then retrying (${attempt}/${MAX_ATTEMPTS})`,
          { stage: "tts" }
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(describeError?.(resp.status, body) ?? `${provider} TTS ${resp.status}: ${body}`);
    }

    // A 200 whose body is JSON/text is an error served with the wrong status — never audio.
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("json") || ct.startsWith("text/")) {
      throw new Error(
        `${provider} TTS returned ${ct || "a non-audio response"} instead of audio: ${(await resp.text()).slice(0, 300)}`
      );
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) throw new Error(`${provider} TTS returned an empty audio response (0 bytes)`);
    // MP3 starts with an ID3 tag or an 0xFF frame sync. Anything else would still be
    // written to disk, then probed — and probeDurationSafe ESTIMATES from file size when
    // ffprobe can't read it, so a corrupt body would become a plausible-looking duration
    // and a silently desynced video. Fail loudly here instead.
    const isMp3 = buf.subarray(0, 3).toString("ascii") === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    if (!isMp3) {
      throw new Error(
        `${provider} TTS returned ${buf.length} bytes that are not valid MP3 audio (starts with ${buf.subarray(0, 4).toString("hex")})`
      );
    }
    return buf;
  }
  throw new Error(lastErr || `${provider} TTS failed`);
}

/**
 * Fish Audio (api.fish.audio) — synchronous TTS returning raw audio bytes.
 *
 * Verified against the official API reference:
 *   - `POST /v1/tts`, auth `Authorization: Bearer <key>`
 *   - the BACKEND MODEL travels in the `model` HTTP HEADER (s2.1-pro default), NOT the body
 *   - the VOICE is `reference_id` in the body — a Fish "model" id (`_id` from GET /model),
 *     which is why the voice picker lists models
 *   - `format: "mp3"` + `mp3_bitrate` choose the container; the response is raw bytes
 *   - 401 "No permission" (bad key) and 402 "No payment" (no balance) are the documented
 *     failures, both as JSON `{status, message}`
 *
 * Audio only — word timings come from the shared Groq Whisper path (alignWords), exactly
 * like every other non-ElevenLabs provider.
 */
async function fishAudioTts(
  runId: string,
  text: string,
  outPath: string,
  voiceOverride?: string | null,
  speedOverride?: number | null
) {
  const apiKey = getSetting("FISHAUDIO_API_KEY");
  if (!apiKey) throw new Error("FISHAUDIO_API_KEY is not set — paste it in /settings");
  // A channel profile's voice_id wins over the global setting, like every other provider.
  const voiceId =
    voiceOverride && voiceOverride.trim().length > 0 ? voiceOverride.trim() : getSetting("FISHAUDIO_VOICE_ID");
  if (!voiceId)
    throw new Error(
      "No Fish Audio voice available — set FISHAUDIO_VOICE_ID in /settings (use “Load voices”), or add a voice_id to the channel profile in /prompts"
    );
  const model = getSetting("FISHAUDIO_MODEL") || "s2.1-pro";

  const body: Record<string, unknown> = {
    text,
    reference_id: voiceId,
    format: "mp3",
    mp3_bitrate: 128,
  };
  // Fish exposes rate under `prosody`. Only sent when a speed is actually configured, so
  // an unset TTS_SPEED leaves the provider on its own default.
  const speed = speedOverride ?? parseFloatOr(getSetting("TTS_SPEED"), NaN);
  if (!Number.isNaN(speed)) body.prosody = { speed: clamp(speed, 0.5, 2.0) };

  const buf = await fetchTtsAudio({
    runId,
    provider: "Fish Audio",
    url: "https://api.fish.audio/v1/tts",
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Model selection is a HEADER for this API — putting it in the body silently
        // leaves the account on the default model.
        model,
      },
      body: JSON.stringify(body),
    },
    describeError: (status, raw) => {
      // Fish returns {status, message}; prefer the message over the raw envelope.
      let detail = raw;
      try {
        const j = JSON.parse(raw) as { message?: string; detail?: string };
        detail = j.message ?? j.detail ?? raw;
      } catch {}
      if (status === 401)
        return `Fish Audio rejected the API key (401: ${detail}) — check FISHAUDIO_API_KEY in /settings.`;
      if (status === 402)
        return `Fish Audio has no credit left (402: ${detail}) — top up the account at fish.audio, then re-run.`;
      if (status === 404 || /reference|model.*not.*found/i.test(detail))
        return `Fish Audio could not find the voice "${voiceId}" (${status}: ${detail}) — it may have been deleted or belong to another account. Pick one again with “Load voices” in /settings.`;
      return null;
    },
  });

  fs.writeFileSync(outPath, buf);
  // Cost: Fish bills per MILLION UTF-8 BYTES, so meter BYTES, not characters — a Cyrillic
  // or CJK script costs 2–3x its character count and `text.length` would under-report it.
  recordFishAudio(runId, Buffer.byteLength(text, "utf8"));
  log(runId, "debug", `Fish Audio TTS (${buf.length} bytes, model=${model}, voice=${voiceId.slice(0, 8)}…)`, {
    stage: "tts",
  });
}

/**
 * Hume AI Octave (api.hume.ai) — synchronous TTS returning a downloadable audio file.
 *
 * Verified against the official API reference:
 *   - `POST /v0/tts/file`, auth `X-Hume-Api-Key` header
 *   - the voice lives on the FIRST utterance and applies to the rest; referencing it by
 *     `id` needs NO `provider`, which is why we store a bare UUID and it resolves against
 *     both the shared Voice Library (HUME_AI) and the account's own voices (CUSTOM_VOICE)
 *   - `speed` is per-utterance (0.75–1.5 recommended), `format: {type:"mp3"}`
 *   - `version` picks the Octave generation; Octave-1 voices work on both, Octave-2 voices
 *     REQUIRE version 2, so an unset value is left off entirely and Hume's default applies
 *
 * Audio only — word timings come from the shared Groq Whisper path (alignWords).
 */
async function humeTts(
  runId: string,
  text: string,
  outPath: string,
  voiceOverride?: string | null,
  speedOverride?: number | null
) {
  const apiKey = getSetting("HUME_API_KEY");
  if (!apiKey) throw new Error("HUME_API_KEY is not set — paste it in /settings");
  const voiceId =
    voiceOverride && voiceOverride.trim().length > 0 ? voiceOverride.trim() : getSetting("HUME_VOICE_ID");
  if (!voiceId)
    throw new Error(
      "No Hume voice available — set HUME_VOICE_ID in /settings (use “Load voices”), or add a voice_id to the channel profile in /prompts"
    );

  const utterance: Record<string, unknown> = { text, voice: { id: voiceId } };
  const speed = speedOverride ?? parseFloatOr(getSetting("TTS_SPEED"), NaN);
  if (!Number.isNaN(speed)) utterance.speed = clamp(speed, 0.75, 1.5);

  const body: Record<string, unknown> = {
    utterances: [utterance],
    format: { type: "mp3" },
    num_generations: 1,
  };
  // Only sent when the operator pinned a version — otherwise Hume picks, and an
  // Octave-2-only voice keeps working without them having to know why.
  const version = getSetting("HUME_VERSION").trim();
  if (version === "1" || version === "2") body.version = version;

  const buf = await fetchTtsAudio({
    runId,
    provider: "Hume",
    url: "https://api.hume.ai/v0/tts/file",
    init: {
      method: "POST",
      headers: { "X-Hume-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    describeError: (status, raw) => {
      let detail = raw;
      try {
        const j = JSON.parse(raw) as { message?: string; error?: string; detail?: string };
        detail = j.message ?? j.error ?? j.detail ?? raw;
      } catch {}
      if (status === 401 || status === 403)
        return `Hume rejected the API key (${status}: ${detail}) — check HUME_API_KEY in /settings.`;
      if (status === 402)
        return `Hume reports the account is out of credit (402: ${detail}) — check your plan at hume.ai, then re-run.`;
      if (status === 404 || /voice.*not.*found|unknown voice/i.test(detail))
        return `Hume could not find the voice "${voiceId}" (${status}: ${detail}) — it may have been deleted. Pick one again with “Load voices” in /settings.`;
      // The one genuinely confusing failure: an Octave-2 voice sent to an Octave-1 request.
      if (/octave|version|not compatible|incompatible/i.test(detail))
        return `Hume rejected this voice for the selected Octave version (${status}: ${detail}) — Octave-2 voices only work with HUME_VERSION = 2. Set HUME_VERSION to 2 in Settings, or pick an Octave-1 voice.`;
      return null;
    },
  });

  fs.writeFileSync(outPath, buf);
  // Cost: Hume bills per 1,000 CHARACTERS of input text.
  recordHume(runId, text.length);
  log(runId, "debug", `Hume TTS (${buf.length} bytes, voice=${voiceId.slice(0, 8)}…, version=${version || "default"})`, {
    stage: "tts",
  });
}

async function openaiTts(text: string, outPath: string) {
  const apiKey = getSetting("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = getSetting("TTS_MODEL") || "gpt-4o-mini-tts";
  const voice = getSetting("TTS_VOICE_ID") || "alloy";

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, voice, input: text, format: "mp3" }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI TTS ${resp.status}: ${body.slice(0, 300)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { resolveFfmpeg } from "../ffmpeg-bin";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createTtsJob, pollJob, downloadJob } from "./labs69";
import { probeDurationSafe } from "./video-assemble";
import { isVoiceRejection, classifyVoiceError } from "./elevenlabs-voices";

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
  options: { voiceOverride?: string | null; provider?: string }
): Promise<void> {
  const provider = (options.provider || getSetting("TTS_PROVIDER") || "heygen").toLowerCase();
  if (provider === "heygen") {
    await heygenTts(runId, text, outPath, options.voiceOverride);
  } else if (provider === "69labs") {
    await labs69Tts(runId, text, outPath);
  } else if (provider === "elevenlabs") {
    await elevenLabs(text, outPath);
  } else if (provider === "openai") {
    await openaiTts(text, outPath);
  } else if (provider === "minimax") {
    await minimaxTts(runId, text, outPath, options.voiceOverride);
  } else if (provider === "genaipro") {
    await genaiproTts(runId, text, outPath, options.voiceOverride);
  } else if (provider === "ai33pro") {
    await ai33proTts(runId, text, outPath, options.voiceOverride);
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
  options: { voiceOverride?: string | null; provider?: string } = {}
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

async function labs69Tts(runId: string, text: string, outPath: string) {
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
    const speed = parseFloatOr(getSetting("TTS_SPEED"), NaN);
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
  voiceOverride?: string | null
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

  // Optional speed control — reuse the global TTS_SPEED setting (clamped to HeyGen's 0.5–1.5).
  const speedSetting = parseFloat(getSetting("TTS_SPEED"));
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
  voiceOverride?: string | null
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

  // Optional speed control — reuse the global TTS_SPEED setting (MiniMax accepts 0.5–2.0).
  const speedSetting = parseFloat(getSetting("TTS_SPEED"));
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
  voiceOverride?: string | null
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
  body.speed = clamp(parseFloatOr(getSetting("TTS_SPEED"), 1.0), 0.7, 1.2);
  const style = parseFloatOr(getSetting("TTS_STYLE"), NaN);
  if (!Number.isNaN(style)) body.style = clamp(style, 0, 1);
  const similarity = parseFloatOr(getSetting("TTS_SIMILARITY_BOOST"), NaN);
  if (!Number.isNaN(similarity)) body.similarity = clamp(similarity, 0, 1);
  const stability = parseFloatOr(getSetting("TTS_STABILITY"), NaN);
  if (!Number.isNaN(stability)) body.stability = clamp(stability, 0, 1);
  const speakerBoost = getSetting("TTS_USE_SPEAKER_BOOST");
  if (speakerBoost === "1") body.use_speaker_boost = true;
  else if (speakerBoost === "0") body.use_speaker_boost = false;

  // 1) Create the task.
  const createResp = await fetch(`${BASE}/labs/task`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
  });
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
    const pollResp = await fetch(`${BASE}/labs/task/${encodeURIComponent(String(taskId))}`, {
      headers: authHeaders,
    });
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

  // 3) Download the finished mp3.
  const audioResp = await fetch(audioUrl, { redirect: "follow" });
  if (!audioResp.ok) {
    throw new Error(`GenAIPro download failed: ${audioResp.status} ${audioResp.statusText}`);
  }
  const buf = Buffer.from(await audioResp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  log(runId, "debug", `GenAIPro TTS (${buf.length} bytes, voice=${voiceId.slice(0, 8)}…)`, { stage: "tts" });
}

/**
 * ai33pro TTS — a unified proxy in front of ElevenLabs / MiniMax / voice-clone /
 * Edge TTS / Kokoro / Vbee / FishAudio (voice_id carries the provider prefix,
 * e.g. `elevenlabs_...`, `minimax_...`, `edge_...`).
 *
 * Async task API, same shape as the 69labs/GenAIPro paths:
 *   1. POST /v3/text-to-speech (FormData: text, voice_id, speed, with_transcript)
 *      → { success, task_id }
 *   2. GET  /v1/task/{task_id} (poll — documented common-task endpoint, shared
 *      across ai33pro's TTS/Suno/Imagen task types) → { status: "doing"|"done"|"error",
 *      error_message, metadata: { audio_url, ... }, progress }
 *   3. download metadata.audio_url to outPath
 *
 * Auth: `xi-api-key` header (same header name ElevenLabs uses — ai33pro is
 * ElevenLabs-API-compatible). voiceOverride: per-channel voice_id from the
 * channel profile (wins over the global AI33PRO_VOICE_ID setting).
 */
async function ai33proTts(
  runId: string,
  text: string,
  outPath: string,
  voiceOverride?: string | null
) {
  const apiKey = getSetting("AI33PRO_API_KEY");
  if (!apiKey) throw new Error("AI33PRO_API_KEY is not set — paste it in /settings");
  const voiceId =
    voiceOverride && voiceOverride.trim().length > 0
      ? voiceOverride.trim()
      : getSetting("AI33PRO_VOICE_ID");
  if (!voiceId)
    throw new Error(
      "No ai33pro voice_id available — set AI33PRO_VOICE_ID in /settings (must be prefixed, e.g. elevenlabs_..., minimax_..., edge_...), or add a voice_id to the channel profile in /prompts"
    );

  const BASE = "https://api.ai33.pro";

  // speed: ai33pro accepts 0.5–1.5, same range HeyGen uses — reuse the shared knob.
  const speedSetting = parseFloat(getSetting("TTS_SPEED"));
  const speed = Number.isFinite(speedSetting) ? clamp(speedSetting, 0.5, 1.5) : 1;

  const form = new FormData();
  form.append("text", text);
  form.append("voice_id", voiceId);
  form.append("speed", String(speed));
  form.append("with_transcript", "false");

  // Same resilience as the poll loop: a stalled connection makes fetch() throw
  // (no HTTP response ever arrives) rather than resolve with a bad status, so
  // that has to be caught separately from the 429/5xx branch below. 3 attempts
  // total with short backoff — this call isn't inside a long-running poll loop,
  // so it needs its own retry instead of relying on an outer one.
  const CREATE_MAX_ATTEMPTS = 3;
  let createResp: Response | undefined;
  let createErrText = "";
  for (let attempt = 1; attempt <= CREATE_MAX_ATTEMPTS; attempt++) {
    try {
      createResp = await fetch(`${BASE}/v3/text-to-speech`, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
      });
    } catch (err) {
      createErrText = err instanceof Error ? err.message : String(err);
      if (attempt < CREATE_MAX_ATTEMPTS) {
        const waitMs = 3000 * attempt;
        log(runId, "warn", `ai33pro create network error: ${createErrText} — retrying in ${waitMs / 1000}s (${attempt}/${CREATE_MAX_ATTEMPTS})`, { stage: "tts" });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`ai33pro create failed after ${CREATE_MAX_ATTEMPTS} attempts (network error): ${createErrText}`);
    }
    if (!createResp.ok) {
      const retryableStatus = [429, 502, 503, 504].includes(createResp.status);
      createErrText = await createResp.text();
      if (retryableStatus && attempt < CREATE_MAX_ATTEMPTS) {
        const waitMs = 3000 * attempt;
        log(runId, "warn", `ai33pro create transient ${createResp.status}: ${createErrText.slice(0, 150)} — retrying in ${waitMs / 1000}s (${attempt}/${CREATE_MAX_ATTEMPTS})`, { stage: "tts" });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`ai33pro create ${createResp.status}: ${createErrText.slice(0, 300)}`);
    }
    break;
  }
  const created = (await createResp!.json()) as { success?: boolean; task_id?: string };
  const taskId = created.task_id;
  if (!taskId) {
    throw new Error(`ai33pro create returned no task_id. Payload: ${JSON.stringify(created).slice(0, 300)}`);
  }
  log(runId, "debug", `ai33pro TTS task ${taskId.slice(0, 8)}… (voice=${voiceId.slice(0, 16)}…, speed=${speed})`, {
    stage: "tts",
  });

  // Poll GET /v1/task/{task_id} until status is "done" or "error".
  const POLL_INTERVAL_MS = 2500;
  const POLL_MAX_MS = 8 * 60 * 1000;
  const start = Date.now();
  let audioUrl: string | undefined;
  while (true) {
    // Checked unconditionally on every iteration so a server that keeps returning
    // transient errors (503/network failures) still gets cut off at the ceiling,
    // instead of the "continue" branches below skipping past this check forever.
    if (Date.now() - start > POLL_MAX_MS) {
      throw new Error(`ai33pro task ${taskId} exceeded ${POLL_MAX_MS / 1000}s polling timeout`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let pollResp: Response;
    try {
      pollResp = await fetch(`${BASE}/v1/task/${encodeURIComponent(taskId)}`, {
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      });
    } catch (err) {
      // fetch() throws (ECONNRESET/timeout/DNS/socket hang up) when the
      // connection fails before any HTTP response comes back — treat this the
      // same as a transient 503, not a fatal crash.
      const msg = err instanceof Error ? err.message : String(err);
      log(runId, "warn", `ai33pro poll network error: ${msg} — retrying`, { stage: "tts" });
      continue;
    }
    if (!pollResp.ok) {
      if (pollResp.status === 429 || pollResp.status === 503 || pollResp.status === 502 || pollResp.status === 504) {
        const errText = await pollResp.text();
        log(runId, "warn", `ai33pro poll transient ${pollResp.status}: ${errText.slice(0, 150)} — retrying`, { stage: "tts" });
        continue; // transient — keep polling
      }
      throw new Error(`ai33pro poll ${pollResp.status}: ${(await pollResp.text()).slice(0, 200)}`);
    }
    const j = (await pollResp.json()) as {
      status?: string;
      error_message?: string | null;
      message?: string | null;
      metadata?: { audio_url?: string };
      data?: {
        status?: string;
        error_message?: string | null;
        message?: string | null;
        metadata?: { audio_url?: string };
      };
    };
    const dataObj = j.data || j;
    const status = (dataObj.status ?? "").toLowerCase();
    if (status === "done" || status === "completed" || status === "success") {
      audioUrl = dataObj.metadata?.audio_url;
      if (!audioUrl) {
        throw new Error(`ai33pro task completed but returned no audio_url. Payload: ${JSON.stringify(j).slice(0, 300)}`);
      }
      break;
    }
    if (status === "error" || status === "failed") {
      const errMsg = dataObj.error_message || dataObj.message || j.message || j.error_message || "unknown";
      throw new Error(`ai33pro task ${taskId} failed: ${errMsg}`);
    }
    // status is "doing"/queued/unrecognized — loop back; the timeout check at
    // the top of the loop is what eventually cuts this off.
  }

  const audioResp = await fetch(audioUrl, { redirect: "follow" });
  if (!audioResp.ok) {
    throw new Error(`ai33pro download failed: ${audioResp.status} ${audioResp.statusText}`);
  }
  const buf = Buffer.from(await audioResp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  log(runId, "debug", `ai33pro TTS (${buf.length} bytes, voice=${voiceId.slice(0, 16)}…)`, { stage: "tts" });
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

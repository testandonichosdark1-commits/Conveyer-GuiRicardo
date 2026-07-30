import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { resolveFfmpeg } from "../ffmpeg-bin";
import { log } from "../logger";
import { probeDurationSafe } from "./video-assemble";
import { synthesizeFullScript } from "./tts";
import { recordElevenlabs } from "./cost-ledger";
import { pLimit } from "../plimit";
import {
  keyFingerprint,
  resolveElevenLabsVoiceId,
  listElevenLabsVoices,
  isVoiceRejection,
  classifyVoiceError,
} from "./elevenlabs-voices";
import { checkCancelled } from "../cancellation";

/**
 * ElevenLabs full-script voiceover WITH word timings.
 *
 * The narration is one continuous ElevenLabs performance over the whole
 * script. We use the `/with-timestamps` endpoint so we get per-character timing
 * in the SAME call — no separate Whisper pass — and fold characters into words.
 * Long scripts are chunked at sentence boundaries (model char limit) and each
 * chunk's timings are offset by the cumulative audio duration so the word list
 * is one global timeline. See docs/DESIGN.md.
 */

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface Voiceover {
  /** Path to the full voiceover MP3. */
  filePath: string;
  durationSec: number;
  /** Words on a single global timeline (ms from start of the full audio). */
  words: WordTiming[];
}

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}
interface TimestampsResponse {
  audio_base64: string;
  alignment: Alignment | null;
  normalized_alignment: Alignment | null;
}

function modelCharLimit(model: string): number {
  if (/flash|turbo/i.test(model)) return 38000; // 40k cap, leave headroom
  if (/v3/i.test(model)) return 2800; // 3k cap
  return 9500; // multilingual_v2: 10k cap
}

/** Split text into chunks under `limit` chars, never breaking a sentence. */
function chunkScript(text: string, limit: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > limit && cur) {
      chunks.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.length > 0 ? chunks : [text];
}

/** Group an alignment's characters into words, offset by `offsetMs`. */
function alignmentToWords(a: Alignment, offsetMs: number): WordTiming[] {
  const words: WordTiming[] = [];
  let cur: WordTiming | null = null;
  for (let i = 0; i < a.characters.length; i++) {
    const c = a.characters[i];
    const startMs = Math.round(a.character_start_times_seconds[i] * 1000) + offsetMs;
    const endMs = Math.round(a.character_end_times_seconds[i] * 1000) + offsetMs;
    if (/\s/.test(c)) {
      if (cur) {
        words.push(cur);
        cur = null;
      }
    } else {
      if (!cur) cur = { word: "", startMs, endMs };
      cur.word += c;
      cur.endMs = endMs;
    }
  }
  if (cur) words.push(cur);
  return words;
}

function voiceSettings(): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  const num = (k: string) => {
    const n = parseFloat(getSetting(k as Parameters<typeof getSetting>[0]));
    return Number.isFinite(n) ? n : NaN;
  };
  const stability = num("TTS_STABILITY");
  const similarity = num("TTS_SIMILARITY_BOOST");
  const style = num("TTS_STYLE");
  const speed = num("TTS_SPEED");
  const boost = getSetting("TTS_USE_SPEAKER_BOOST");
  if (!Number.isNaN(stability)) out.stability = Math.max(0, Math.min(1, stability));
  if (!Number.isNaN(similarity)) out.similarity_boost = Math.max(0, Math.min(1, similarity));
  if (!Number.isNaN(style)) out.style = Math.max(0, Math.min(1, style));
  if (!Number.isNaN(speed)) out.speed = Math.max(0.7, Math.min(1.2, speed));
  if (boost === "1") out.use_speaker_boost = true;
  else if (boost === "0") out.use_speaker_boost = false;
  return out;
}

/**
 * Voiceover router. ElevenLabs (direct) is the default and gives native per-word
 * timestamps. Other providers (69labs / HeyGen / MiniMax via the shared TTS
 * engine) return audio only, so we recover word timings with Groq Whisper, and
 * fall back to a proportional split if no Groq key is configured.
 */
export async function synthesizeVoiceover(
  runId: string,
  script: string,
  outDir: string,
  opts: { voiceOverride?: string | null } = {}
): Promise<Voiceover> {
  const provider = (getSetting("VOICEOVER_PROVIDER") || "elevenlabs").toLowerCase();
  if (provider === "elevenlabs") {
    return synthesizeElevenLabs(runId, script, outDir, opts);
  }
  return synthesizeViaProvider(runId, script, outDir, provider, opts);
}

/**
 * Non-ElevenLabs voiceover: synthesize one continuous mp3 through the shared TTS
 * engine (69labs / heygen / minimax / openai), then align word timings.
 */
async function synthesizeViaProvider(
  runId: string,
  script: string,
  outDir: string,
  provider: string,
  opts: { voiceOverride?: string | null }
): Promise<Voiceover> {
  log(runId, "info", `Voiceover via ${provider} (timing via Groq Whisper)`, { stage: "voiceover" });
  const outPath = path.join(outDir, "voiceover.mp3");
  const { durationSec } = await synthesizeFullScript(runId, script.trim(), outPath, {
    voiceOverride: opts.voiceOverride,
    provider,
  });
  const words = await alignWords(runId, outPath, script, durationSec);
  log(runId, "success", `Voiceover ready: ${durationSec.toFixed(1)}s, ${words.length} words timed`, {
    stage: "voiceover",
  });
  return { filePath: outPath, durationSec, words };
}

/**
 * Recover per-word timings for an mp3. Prefers Groq Whisper word timestamps;
 * falls back to a proportional even split (so a run never fails just because no
 * Groq key is set).
 */
async function alignWords(runId: string, mp3Path: string, script: string, durationSec: number): Promise<WordTiming[]> {
  const groqKey = getSetting("GROQ_API_KEY");
  if (groqKey) {
    try {
      const w = await whisperWords(mp3Path, groqKey);
      if (w.length > 0) return w;
    } catch (e) {
      log(runId, "warn", `Whisper alignment failed (${(e as Error).message.slice(0, 120)}) — using proportional timing`, {
        stage: "voiceover",
      });
    }
  } else {
    log(runId, "warn", "No GROQ_API_KEY — using proportional word timing (add a free Groq key for accurate sync)", {
      stage: "voiceover",
    });
  }
  return proportionalWords(script, durationSec);
}

/** Groq Whisper (whisper-large-v3) word-level timestamps. */
async function whisperWords(mp3Path: string, groqKey: string): Promise<WordTiming[]> {
  const ff = resolveFfmpeg();
  const wav = path.join(os.tmpdir(), `vo-align-${process.pid}-${Date.now()}.mp3`);
  const ex = spawnSync(ff, ["-y", "-i", mp3Path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", wav], { stdio: "pipe" });
  if (ex.status !== 0) throw new Error("ffmpeg audio extract for alignment failed");
  try {
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(wav)], { type: "audio/mpeg" }), "audio.mp3");
    fd.append("model", "whisper-large-v3");
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "word");
    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}` },
      body: fd,
    });
    if (!r.ok) throw new Error(`Groq Whisper ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { words?: { word: string; start: number; end: number }[] };
    return (j.words ?? [])
      .map((w) => ({ word: (w.word || "").trim(), startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000) }))
      .filter((w) => w.word.length > 0);
  } finally {
    try {
      fs.unlinkSync(wav);
    } catch {}
  }
}

/** Even split of the script's words across the audio duration (no API needed). */
function proportionalWords(script: string, durationSec: number): WordTiming[] {
  const tokens = script.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const totalMs = Math.max(1, Math.round(durationSec * 1000));
  const per = totalMs / tokens.length;
  return tokens.map((word, i) => ({
    word,
    startMs: Math.round(i * per),
    endMs: Math.round((i + 1) * per),
  }));
}

// ── ElevenLabs request resilience ───────────────────────────────────────────
// A transient ElevenLabs blip (500 service_unavailable / 503 / 429 concurrency
// cap / network drop / timeout) used to throw on the first try and crash the
// whole run at the voiceover stage. We now retry transient failures with
// exponential backoff, and cap concurrent ElevenLabs requests PROCESS-WIDE so
// several simultaneous runs don't exceed the account's per-plan concurrency
// limit. Mirrors the Gemini resilience layer (gemini-models.ts) and the yt-dlp
// limiter (visual-source.ts).

/** Process-global ElevenLabs concurrency cap (shared across ALL concurrent runs).
 *  Memoized; rebuilt only if the setting changes (safe: only changes between runs). */
let elevenlabsLimit: ReturnType<typeof pLimit> | undefined;
let elevenlabsLimitN = -1;
function elevenlabsLimiter(): ReturnType<typeof pLimit> {
  const n = Math.max(1, Math.min(15, Number(getSetting("ELEVENLABS_CONCURRENCY") || "2")));
  if (!elevenlabsLimit || elevenlabsLimitN !== n) {
    elevenlabsLimit = pLimit(n);
    elevenlabsLimitN = n;
  }
  return elevenlabsLimit;
}
/** Requests submitted to the limiter and not yet finished. Counted SYNCHRONOUSLY at
 *  submit time (the limiter runs its callback on a later microtask), so we can tell
 *  up front whether a new request will have to WAIT for a slot. Diagnostic only. */
let elevenlabsSubmitted = 0;
/** Only log queue waits above this — sub-100ms scheduling jitter isn't worth a line. */
const ELEVENLABS_QUEUE_LOG_MS = 100;

/** A 429 (concurrency cap) or any 5xx, plus timeouts / network drops, are worth a
 *  retry; other 4xx (bad key/voice/request, real quota-exhausted) are permanent. */
export function isTransientElevenLabsError(message: string): boolean {
  const status = Number(message.match(/ElevenLabs (\d{3})/)?.[1] ?? 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (status >= 400 && status < 500) return false;
  return /timeout|aborted|fetch failed|network|ECONNRESET|ETIMEDOUT|terminated/i.test(message);
}

const ELEVENLABS_TIMEOUT_MS = 120_000; // voiceover synthesis is slower than a text call

/** ONE /with-timestamps request, bounded by the global limiter + a hard timeout.
 *  Throws `ElevenLabs <status>: <body>` on a non-OK response. Runs the whole
 *  request lifecycle (incl. body read) inside the limiter slot so the slot maps
 *  to a genuinely in-flight ElevenLabs request; backoff sleeps stay OUTSIDE it. */
async function elevenlabsRequestOnce(url: string, body: string, apiKey: string, runId: string): Promise<TimestampsResponse> {
  const limiter = elevenlabsLimiter();
  // Diagnostic: distinguish "ElevenLabs is slow" from "the request was just waiting
  // its turn". If every slot is already taken this request WILL queue — say so up
  // front (counted synchronously so it's accurate), then report how long it actually
  // waited once a slot frees.
  const enqueuedAt = Date.now();
  if (elevenlabsSubmitted >= elevenlabsLimitN) {
    log(runId, "info", "ElevenLabs queue: waiting for available slot...", { stage: "voiceover" });
  }
  elevenlabsSubmitted++;
  try {
    return await limiter(async () => {
      const waitedMs = Date.now() - enqueuedAt;
      if (waitedMs >= ELEVENLABS_QUEUE_LOG_MS) {
        log(runId, "info", `ElevenLabs queue: waited ${(waitedMs / 1000).toFixed(1)}s before sending request.`, { stage: "voiceover" });
      }
      const ctrl = new AbortController();
      const tt = setTimeout(() => ctrl.abort(), ELEVENLABS_TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
          body,
          signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(`ElevenLabs ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
        return (await resp.json()) as TimestampsResponse;
      } catch (e) {
        throw e instanceof Error && e.name === "AbortError" ? new Error(`ElevenLabs timeout after ${ELEVENLABS_TIMEOUT_MS / 1000}s`) : e;
      } finally {
        clearTimeout(tt);
      }
    });
  } finally {
    elevenlabsSubmitted--;
  }
}

/** Retry an ElevenLabs voiceover request on TRANSIENT failures with exponential
 *  backoff + jitter (ELEVENLABS_RETRIES attempts). Permanent errors fail fast with
 *  the original clear message. Returns the parsed response, or throws the last error. */
export async function elevenlabsSynthesize(url: string, body: string, apiKey: string, runId: string, label: string): Promise<TimestampsResponse> {
  const retries = Math.max(0, Math.min(8, Number(getSetting("ELEVENLABS_RETRIES") || "3")));
  const maxAttempts = retries + 1;
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await elevenlabsRequestOnce(url, body, apiKey, runId);
    } catch (e) {
      lastErr = (e as Error).message;
      if (!isTransientElevenLabsError(lastErr) || attempt === maxAttempts) throw e;
      const backoffMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400); // ~2s, 4s, 8s (+jitter)
      log(runId, "warn", `${label} attempt ${attempt}/${maxAttempts} failed (${lastErr.slice(0, 80)}) — retrying in ${Math.round(backoffMs / 1000)}s`, { stage: "voiceover" });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw new Error(lastErr || "ElevenLabs request failed");
}

async function synthesizeElevenLabs(
  runId: string,
  script: string,
  outDir: string,
  opts: { voiceOverride?: string | null } = {}
): Promise<Voiceover> {
  const apiKey = getSetting("ELEVENLABS_API_KEY");
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set — paste it in /settings.");
  const voiceId = resolveElevenLabsVoiceId(opts.voiceOverride);
  if (!voiceId) throw new Error("No ElevenLabs voice — set ELEVENLABS_VOICE_ID in /settings.");
  const model = getSetting("ELEVENLABS_MODEL") || "eleven_multilingual_v2";

  const chunks = chunkScript(script.trim(), modelCharLimit(model));
  // Log the FULL voice id, where it came from, and which key (fingerprint) is
  // active — "my voice didn't apply" / voice_not_found is only diagnosable if the
  // log says exactly which voice + key actually went to ElevenLabs.
  const voiceSrc = opts.voiceOverride?.trim() ? "run/channel voice" : "global ELEVENLABS_VOICE_ID";
  const keyFp = keyFingerprint(apiKey);
  log(runId, "info", `ElevenLabs voiceover: ${chunks.length} chunk(s), model ${model}, voice ${voiceId} (${voiceSrc}), key ${keyFp}`, { stage: "voiceover" });

  // Preflight ownership check (non-blocking): does the active key's account own this
  // voice? Logged so a wrong-account/HeyGen-id is obvious before the request result.
  const accountVoices = await listElevenLabsVoices(apiKey);
  if (accountVoices) {
    const owned = accountVoices.some((v) => v.id === voiceId);
    log(runId, owned ? "info" : "warn",
      owned
        ? `Voice ${voiceId} is owned by the active ElevenLabs account (${accountVoices.length} voices, key ${keyFp}).`
        : `Voice ${voiceId} is NOT in the active ElevenLabs account's first ${accountVoices.length} voices (key ${keyFp}) — if the request fails, it's a wrong-account or HeyGen id.`,
      { stage: "voiceover" });
  }

  const settings = voiceSettings();
  const chunkPaths: string[] = [];
  const allWords: WordTiming[] = [];
  let offsetMs = 0;

  for (let i = 0; i < chunks.length; i++) {
    checkCancelled(runId); // stop synthesizing further billable chunks once cancelled
    const text = chunks[i].trim();
    if (!text) continue;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`;
    const reqBody = JSON.stringify({
      text,
      model_id: model,
      ...(Object.keys(settings).length ? { voice_settings: settings } : {}),
    });
    // Retries transient blips (500/503/429/timeout) with backoff and throttles
    // concurrent requests process-wide — a single ElevenLabs hiccup no longer
    // crashes the run, and simultaneous runs queue instead of tripping the plan's
    // concurrency cap. Only the failing chunk retries, so timing/offset and cost
    // metering (below) are untouched.
    let json;
    try {
      json = await elevenlabsSynthesize(url, reqBody, apiKey, runId, `Voiceover chunk ${i + 1}/${chunks.length}`);
    } catch (e) {
      const msg = (e as Error).message;
      // Fail fast with a clear, classified reason on a voice-id rejection.
      if (isVoiceRejection(msg)) throw new Error(await classifyVoiceError(msg, voiceId, apiKey, accountVoices));
      throw e;
    }
    if (!json.audio_base64) throw new Error("ElevenLabs returned no audio");
    // Cost Monitoring — billed per character of synthesized text.
    recordElevenlabs(runId, text.length);

    const chunkPath = path.join(outDir, `voiceover_${String(i).padStart(2, "0")}.mp3`);
    fs.writeFileSync(chunkPath, Buffer.from(json.audio_base64, "base64"));
    chunkPaths.push(chunkPath);

    const align = json.alignment ?? json.normalized_alignment;
    if (align && align.characters?.length) {
      allWords.push(...alignmentToWords(align, offsetMs));
      const lastEnd = align.character_end_times_seconds[align.character_end_times_seconds.length - 1] || 0;
      offsetMs += Math.round(lastEnd * 1000);
    } else {
      // No alignment came back — offset by measured chunk duration so later
      // chunks stay on the global timeline (words for this chunk are lost).
      offsetMs += Math.round((await probeDurationSafe(chunkPath)) * 1000);
      log(runId, "warn", `Chunk ${i} returned no alignment — word timing for it is unavailable`, { stage: "voiceover" });
    }
    log(runId, "info", `Voiceover chunk ${i + 1}/${chunks.length} ok`, { stage: "voiceover" });
  }

  if (chunkPaths.length === 0) throw new Error("ElevenLabs produced no audio");

  // Concatenate chunk MP3s into one voiceover.mp3 (stream copy).
  const outPath = path.join(outDir, "voiceover.mp3");
  if (chunkPaths.length === 1) {
    fs.copyFileSync(chunkPaths[0], outPath);
  } else {
    const listPath = path.join(outDir, "voiceover_concat.txt");
    fs.writeFileSync(
      listPath,
      chunkPaths.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
      "utf-8"
    );
    const ff = resolveFfmpeg();
    const r = spawnSync(ff, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath], {
      stdio: "pipe",
    });
    if (r.status !== 0) throw new Error(`ffmpeg voiceover concat failed: ${r.stderr?.toString().slice(-300)}`);
    try {
      fs.unlinkSync(listPath);
    } catch {}
  }
  for (const p of chunkPaths) {
    if (p !== outPath) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  }

  const durationSec = await probeDurationSafe(outPath);
  log(runId, "success", `Voiceover ready: ${durationSec.toFixed(1)}s, ${allWords.length} words timed`, {
    stage: "voiceover",
  });
  return { filePath: outPath, durationSec, words: allWords };
}

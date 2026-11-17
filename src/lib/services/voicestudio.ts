/**
 * VoiceStudio — the operator's own LOCAL text-to-speech app (voicestudio.sh,
 * github.com/debpalash/VoiceStudio, AGPL). Free: no account, no key, nothing billed.
 *
 * Contract, probed live against VoiceStudio 0.5.6 on Apple Silicon (2026-11-17):
 *   GET  {base}/health                → {"status":"ok"|"starting", …}
 *   POST {base}/v1/audio/speech       → raw audio bytes (OpenAI-shaped request)
 *        {model, voice, input (≤ 4096 chars), response_format:"mp3", speed?}
 *   Base = http://127.0.0.1:3900. Any non-empty Bearer token works on localhost.
 *
 * Measured on that machine: the default OmniVoice engine stalled past VoiceStudio's own
 * 300 s sidecar deadline on a 936-char paragraph (and its pretrained model is
 * non-commercial), while `mlx-audio` (Kokoro on Apple MLX) rendered 50 s of audio in 15 s
 * once warm. Hence the default model here is "mlx-audio" and the default voice a Kokoro
 * preset ("am_michael"). An unknown voice comes back as a JSON error, which we surface.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { log } from "../logger";
import { resolveFfmpeg } from "../ffmpeg-bin";

const DEFAULT_BASE = "http://127.0.0.1:3900";
/** VoiceStudio rejects input over 4096 chars; stay well under it at sentence boundaries. */
export const VOICESTUDIO_MAX_CHARS = 3500;

export function voicestudioBaseUrl(): string {
  return (getSetting("VOICESTUDIO_URL") || DEFAULT_BASE).replace(/\/+$/, "");
}

/** Split at sentence boundaries into pieces ≤ limit (a single over-long sentence is cut at spaces). */
export function splitForVoiceStudio(text: string, limit = VOICESTUDIO_MAX_CHARS): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  const push = (s: string) => {
    if (s.trim()) out.push(s.trim());
  };
  for (let s of sentences) {
    while (s.length > limit) {
      const cut = s.lastIndexOf(" ", limit) > 0 ? s.lastIndexOf(" ", limit) : limit;
      push(cur);
      cur = "";
      push(s.slice(0, cut));
      s = s.slice(cut);
    }
    if ((cur + s).length > limit && cur) {
      push(cur);
      cur = s;
    } else cur += s;
  }
  push(cur);
  return out.length ? out : [text];
}

function unreachable(base: string, e: unknown): string {
  return `VoiceStudio is not reachable at ${base} (${(e as Error)?.message ?? e}). Open the VoiceStudio app and wait until it finishes starting, then resume the run.`;
}

class VoiceStudioUnreachable extends Error {}

async function health(base: string): Promise<"ok" | "starting" | "down"> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    const j = (await r.json().catch(() => ({}))) as { status?: string };
    return j.status === "ok" ? "ok" : "starting";
  } catch {
    return "down";
  }
}

/**
 * Make sure the app is up. Observed live: VoiceStudio can exit in the middle of a long
 * narration, which used to kill the run. On macOS with a local address we reopen the app
 * (`open -a VoiceStudio`) and wait for /health to say "ok" (model reload included).
 */
async function ensureVoiceStudio(runId: string, base: string): Promise<void> {
  let state = await health(base);
  if (state === "ok") return;
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base);
  const canReopen = local && process.platform === "darwin";
  const reopen = () => spawnSync("open", ["-a", process.env.VOICESTUDIO_APP || "VoiceStudio"], { stdio: "ignore" });
  if (state === "down" && canReopen) {
    log(runId, "warn", "VoiceStudio is not running — reopening the app and waiting for it to start", { stage: "tts" });
    reopen();
  }
  // Observed: one `open` issued while the crashed app was still shutting down did nothing, and the
  // run waited out the full 5 minutes. While the server stays DOWN, ask again every 30 s.
  const deadline = Date.now() + 5 * 60_000;
  let lastOpen = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    state = await health(base);
    if (state === "ok") return;
    if (state === "down" && canReopen && Date.now() - lastOpen > 30_000) {
      reopen();
      lastOpen = Date.now();
    }
  }
  throw new VoiceStudioUnreachable(unreachable(base, new Error(`still ${state} after 5 min`)));
}

async function speak(base: string, text: string, model: string, voice: string, speed: number | null): Promise<Buffer> {
  let resp: Response;
  try {
    resp = await fetch(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: { Authorization: "Bearer local", "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        response_format: "mp3",
        ...(speed && Number.isFinite(speed) ? { speed } : {}),
      }),
      // Local synthesis; the first call also loads the model. VoiceStudio has its own 300 s
      // per-engine deadline, so this only guards against a hung connection.
      signal: AbortSignal.timeout(15 * 60_000),
    });
  } catch (e) {
    throw new VoiceStudioUnreachable(unreachable(base, e));
  }
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (!resp.ok || ct.includes("json") || ct.startsWith("text/")) {
    const body = await resp.text().catch(() => "");
    let msg = body.slice(0, 400);
    try {
      const j = JSON.parse(body) as { error?: { message?: string }; detail?: string };
      msg = (j.error?.message ?? j.detail ?? msg).slice(0, 400);
    } catch {}
    // 503 = "still starting"; treat like unreachable so we wait instead of failing.
    if (resp.status === 503) throw new VoiceStudioUnreachable(`VoiceStudio 503: ${msg}`);
    throw new Error(`VoiceStudio ${resp.status}: ${msg}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length === 0) throw new Error("VoiceStudio returned an empty audio file (0 bytes)");
  return buf;
}

/** Fingerprint of what a file was made from, so a reused piece is never stale. */
function fingerprint(text: string, model: string, voice: string, speed: number | null): string {
  return createHash("sha1").update(`${model}\u0000${voice}\u0000${speed ?? ""}\u0000${text}`).digest("hex");
}

function readyFile(file: string, fp: string): boolean {
  try {
    return fs.statSync(file).size > 0 && fs.readFileSync(`${file}.vsok`, "utf8") === fp;
  } catch {
    return false;
  }
}

function markReady(file: string, fp: string) {
  fs.writeFileSync(`${file}.vsok`, fp);
}

/**
 * Synthesizes `text` to an MP3 at `outPath`. Texts over VOICESTUDIO_MAX_CHARS are split
 * at sentence boundaries, synthesized piece by piece and joined, then everything is
 * normalized to the libmp3lame 192k/44.1 kHz the rest of the pipeline expects.
 *
 * Resumable: every finished piece (and the finished output) carries a `.vsok` fingerprint
 * of its text/model/voice/speed, so a retry or a Resume after VoiceStudio went away only
 * narrates what is missing.
 */
export async function voicestudioTts(
  runId: string,
  text: string,
  outPath: string,
  voiceOverride?: string | null,
  speedOverride?: number | null
): Promise<void> {
  const base = voicestudioBaseUrl();
  const model = getSetting("VOICESTUDIO_MODEL") || "mlx-audio";
  // /api/studio never snapshots a channel's voice onto a VoiceStudio run, so an override
  // here was chosen for this video. Ids shaped like another provider's ("<engine>:<id>",
  // ai33's "elevenlabs_…") are still refused, defensively, in favour of our own setting.
  const override = voiceOverride?.trim();
  const foreign = !!override && (override.includes(":") || /^(elevenlabs|minimax|fishaudio|edge|vbee|clone)_/i.test(override));
  const voice = override && !foreign ? override : getSetting("VOICESTUDIO_VOICE_ID") || "am_michael";
  const speed = speedOverride ?? (Number(getSetting("TTS_SPEED")) || null);

  const wholeFp = fingerprint(text, model, voice, speed);
  if (readyFile(outPath, wholeFp)) {
    log(runId, "info", "VoiceStudio: reusing narration already rendered for this text", { stage: "tts" });
    return;
  }

  const pieces = splitForVoiceStudio(text);
  const parts: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = `${outPath}.vs${String(i).padStart(2, "0")}.mp3`;
    const fp = fingerprint(pieces[i], model, voice, speed);
    parts.push(p);
    if (readyFile(p, fp)) continue;
    let buf: Buffer | null = null;
    for (let attempt = 1; !buf; attempt++) {
      try {
        buf = await speak(base, pieces[i], model, voice, speed);
      } catch (e) {
        if (!(e instanceof VoiceStudioUnreachable) || attempt >= 3) throw e;
        await ensureVoiceStudio(runId, base);
      }
    }
    fs.writeFileSync(p, buf);
    markReady(p, fp);
  }
  const listPath = `${outPath}.vs-list.txt`;
  fs.writeFileSync(listPath, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const r = spawnSync(
    resolveFfmpeg(),
    ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-vn", "-codec:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", outPath],
    { stdio: "pipe" }
  );
  fs.rmSync(listPath, { force: true });
  if (r.status !== 0)
    throw new Error(`VoiceStudio audio could not be joined/transcoded (ffmpeg rc=${r.status}): ${r.stderr?.toString().slice(-300)}`);
  markReady(outPath, wholeFp);
  for (const p of parts) {
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}.vsok`, { force: true });
  }
  log(runId, "debug", `VoiceStudio TTS (${pieces.length} piece(s), model=${model}, voice=${voice})`, { stage: "tts" });
}

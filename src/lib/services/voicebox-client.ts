import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { getSetting } from "../settings";
import { DATA_DIR } from "../run-paths";
import { resolveFfmpeg } from "../ffmpeg-bin";

/**
 * Client for a locally-running Voicebox backend (github.com/jamiepine/voicebox) —
 * a free, open-source local TTS + voice-cloning studio (FastAPI on :17493).
 *
 * We spawn only the FastAPI backend (`uvicorn backend.main:app`), never the Tauri
 * desktop app — this is a headless server integration. One-time setup:
 * `npm run setup:voicebox` (see scripts/setup-voicebox.mjs).
 */

const PORT = 17493;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function voiceboxDir(): string {
  const dir = getSetting("VOICEBOX_DIR");
  if (!dir) {
    throw new Error(
      "VOICEBOX_DIR is not set — set it to your Voicebox checkout path in /settings, then run `npm run setup:voicebox` once."
    );
  }
  return dir;
}

function pythonBin(): string {
  const dir = voiceboxDir();
  return process.platform === "win32"
    ? path.join(dir, "backend", "venv", "Scripts", "python.exe")
    : path.join(dir, "backend", "venv", "bin", "python");
}

let serverProcess: ChildProcess | null = null;
let serverReady: Promise<void> | null = null;

async function pingServer(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/profiles`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Spawn the Voicebox backend if it isn't already answering, and wait until it is. */
export async function ensureVoiceboxServer(): Promise<void> {
  if (await pingServer()) return; // already up (this process or a manually-started one)
  if (serverReady) return serverReady;

  const py = pythonBin();
  if (!fs.existsSync(py)) {
    throw new Error(`Voicebox venv not found at ${py} — run \`npm run setup:voicebox\` once first.`);
  }
  const dir = voiceboxDir();

  serverReady = new Promise<void>((resolve, reject) => {
    const child = spawn(py, ["-m", "uvicorn", "backend.main:app", "--port", String(PORT)], {
      cwd: dir,
      stdio: "pipe",
    });
    serverProcess = child;
    let stderrTail = "";
    let settled = false;
    child.stderr?.on("data", (b: Buffer) => {
      stderrTail = (stderrTail + b.toString("utf8")).slice(-4000);
    });
    child.on("exit", () => {
      if (serverProcess === child) serverProcess = null;
      serverReady = null;
      if (settled) return;
      settled = true;
      // Winsock 10048 / "address already in use" is locale-dependent text on
      // Windows, but the numeric code isn't — a STALE process (crashed/hung but
      // still bound to the port) is the common cause, not a code bug.
      const boundElsewhere = /10048|address already in use|EADDRINUSE/i.test(stderrTail);
      reject(
        new Error(
          boundElsewhere
            ? `Voicebox exited immediately — port ${PORT} is already held by another (likely stuck/unresponsive) process. ` +
              `Find and stop it (Windows: find the PID with \`netstat -ano | findstr :${PORT}\`, then \`taskkill /F /PID <pid>\`) and try again.`
            : `Voicebox server exited before it was ready. Last stderr: ${stderrTail.slice(-500)}`
        )
      );
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    const deadline = Date.now() + 3 * 60 * 1000; // first model load can be slow
    const poll = async () => {
      if (settled) return; // the exit handler already rejected
      if (await pingServer()) {
        settled = true;
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        settled = true;
        reject(new Error(`Voicebox server did not become ready in time. Last stderr: ${stderrTail.slice(-500)}`));
        return;
      }
      setTimeout(poll, 1500);
    };
    setTimeout(poll, 1500);
  });

  return serverReady;
}

process.once("exit", () => {
  if (serverProcess) {
    try {
      serverProcess.kill();
    } catch {}
  }
});

export interface VoiceProfile {
  id: string;
  name: string;
  description: string | null;
  voice_type: string;
  default_engine: string | null;
  preset_engine: string | null;
  preset_voice_id: string | null;
  sample_count: number;
}

export interface PresetVoice {
  voice_id: string;
  name: string;
  gender: string;
  language: string;
}

export async function listVoiceProfiles(): Promise<VoiceProfile[]> {
  await ensureVoiceboxServer();
  const r = await fetch(`${BASE_URL}/profiles`);
  if (!r.ok) throw new Error(`Voicebox /profiles ${r.status}`);
  return r.json();
}

export async function listPresetVoices(engine: string): Promise<PresetVoice[]> {
  await ensureVoiceboxServer();
  const r = await fetch(`${BASE_URL}/profiles/presets/${encodeURIComponent(engine)}`);
  if (!r.ok) throw new Error(`Voicebox presets ${r.status}`);
  const j = (await r.json()) as { voices?: PresetVoice[] };
  return j.voices ?? [];
}

export async function createPresetProfile(name: string, engine: string, voiceId: string): Promise<string> {
  await ensureVoiceboxServer();
  const r = await fetch(`${BASE_URL}/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      voice_type: "preset",
      preset_engine: engine,
      preset_voice_id: voiceId,
      default_engine: engine,
    }),
  });
  if (!r.ok) throw new Error(`Voicebox create preset profile ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { id: string };
  return j.id;
}

export async function createClonedProfile(
  name: string,
  engine: string,
  sampleFilePath: string,
  referenceText: string
): Promise<string> {
  await ensureVoiceboxServer();
  const createR = await fetch(`${BASE_URL}/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, voice_type: "cloned", default_engine: engine }),
  });
  if (!createR.ok) throw new Error(`Voicebox create profile ${createR.status}: ${(await createR.text()).slice(0, 300)}`);
  const profile = (await createR.json()) as { id: string };

  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(fs.readFileSync(sampleFilePath))]), path.basename(sampleFilePath));
  fd.append("reference_text", referenceText);
  const sampleR = await fetch(`${BASE_URL}/profiles/${encodeURIComponent(profile.id)}/samples`, {
    method: "POST",
    body: fd,
  });
  if (!sampleR.ok) throw new Error(`Voicebox add sample ${sampleR.status}: ${(await sampleR.text()).slice(0, 300)}`);
  return profile.id;
}

export async function deleteVoiceProfile(id: string): Promise<void> {
  await ensureVoiceboxServer();
  await fetch(`${BASE_URL}/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

const GENERATE_TIMEOUT_MS = 10 * 60 * 1000; // full-script generation can take a while
const POLL_INTERVAL_MS = 1000;

/**
 * Generate speech for `text` using `profileId` and write the result to `outPath`.
 *
 * POST /generate is ASYNC — it returns immediately with {id, status:"generating",
 * audio_path:""} and does the actual synthesis on a background task queue. We poll
 * GET /history/{id} (plain JSON, unlike the SSE-only /generate/{id}/status which
 * never carries audio_path) until status is "completed" or "failed".
 */
export async function generateSpeech(profileId: string, text: string, outPath: string): Promise<{ durationSec: number }> {
  await ensureVoiceboxServer();
  const r = await fetch(`${BASE_URL}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // engine MUST be explicit null, not omitted — the GenerationRequest schema
    // defaults an omitted `engine` field to "qwen" (a real value, not None), which
    // overrides the profile's own default_engine (Kokoro/Chatterbox/etc). Sending
    // null lets the backend fall through to profile.default_engine as intended.
    body: JSON.stringify({ profile_id: profileId, text, engine: null }),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Voicebox /generate ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const created = (await r.json()) as { id: string; status: string };

  const deadline = Date.now() + GENERATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
    const hr = await fetch(`${BASE_URL}/history/${encodeURIComponent(created.id)}`);
    if (!hr.ok) continue; // transient — keep polling until the deadline
    const h = (await hr.json()) as { status: string; audio_path: string | null; duration: number | null; error: string | null };
    if (h.status === "completed" && h.audio_path) {
      // audio_path is relative to Voicebox's internal data dir — `<VOICEBOX_DIR>/data`
      // by default (backend/config.py: `_data_dir = Path("data").resolve()`, CWD-relative
      // since we run the bare backend, not the Tauri app that overrides it) — NOT
      // relative to VOICEBOX_DIR itself.
      const abs = path.isAbsolute(h.audio_path) ? h.audio_path : path.join(voiceboxDir(), "data", h.audio_path);
      // Voicebox's engines commonly emit WAV — re-encode to real MP3 at outPath so
      // callers (which always name the file .mp3) get bytes that actually match,
      // regardless of what the source engine produced.
      const ff = spawnSync(resolveFfmpeg(), ["-i", abs, "-c:a", "libmp3lame", "-b:a", "192k", "-y", outPath], { stdio: "pipe" });
      if (ff.status !== 0) throw new Error(`ffmpeg (voicebox output) failed: ${(ff.stderr?.toString() ?? "").slice(-300)}`);
      return { durationSec: h.duration ?? 0 };
    }
    if (h.status === "failed") {
      throw new Error(`Voicebox generation failed: ${h.error || "unknown error"}`);
    }
  }
  throw new Error(`Voicebox generation timed out after ${GENERATE_TIMEOUT_MS / 1000}s`);
}

// ── Local word-level alignment (Voicebox itself returns none) ───────────────

export interface VoiceboxWordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

function alignScriptPath(): string {
  return path.join(DATA_DIR, "local-engines", "voicebox", "align.py");
}

/** Word-level timestamps for `audioPath` via a local faster-whisper pass. Returns
 *  null (never throws) if the alignment script/venv isn't set up — callers fall
 *  back to Groq Whisper or a proportional split. */
export async function alignLocally(audioPath: string): Promise<VoiceboxWordTiming[] | null> {
  let py: string;
  try {
    py = pythonBin();
  } catch {
    return null;
  }
  const script = alignScriptPath();
  if (!fs.existsSync(py) || !fs.existsSync(script)) return null;

  return new Promise((resolve) => {
    const child = spawn(py, [script, audioPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const j = JSON.parse(out) as { words?: { word: string; start: number; end: number }[] };
        const words = (j.words ?? [])
          .map((w) => ({
            word: String(w.word || "").trim(),
            startMs: Math.round(Number(w.start) * 1000),
            endMs: Math.round(Number(w.end) * 1000),
          }))
          .filter((w) => w.word.length > 0);
        resolve(words.length > 0 ? words : null);
      } catch {
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}

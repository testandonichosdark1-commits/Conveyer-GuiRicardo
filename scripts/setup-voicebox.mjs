// One-time setup for the FREE local voice engine (Voicebox): installs
// Voicebox's backend (github.com/jamiepine/voicebox, must be checked out
// locally first) into its own Python 3.10 venv, plus a faster-whisper
// alignment script (Voicebox's /generate returns no word-level timestamps).
//
// Run manually (NOT automatic — heavy download, needs visible progress):
//   npm run setup:voicebox -- "/path/to/voicebox-checkout"
//   (or: node scripts/setup-voicebox.mjs "/path/to/voicebox-checkout")
//
// Safe to re-run: every step skips work that's already done.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

// Matches src/lib/run-paths.ts's DATA_DIR exactly — voicebox-client.ts's
// alignLocally() looks for the alignment script under THIS same DATA_DIR, so
// the two must never drift apart.
const DATA_DIR = process.env.FACELESS_STUDIO_DATA_DIR ?? path.join(os.homedir(), ".faceless-studio");
const ALIGN_DIR = path.join(DATA_DIR, "local-engines", "voicebox");

function log(msg) {
  console.log(`[setup-voicebox] ${msg}`);
}
function die(msg) {
  console.error(`[setup-voicebox] ERROR: ${msg}`);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) die(`failed to run ${cmd}: ${r.error.message}`);
  return r.status === 0;
}

function resolveVoiceboxDir() {
  const candidates = [
    process.argv[2],
    process.env.VOICEBOX_DIR,
    path.join(DATA_DIR, "local-engines", "voicebox", "repo"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "backend", "main.py"))) return c;
  }
  die(
    "Couldn't find a Voicebox checkout (looked for backend/main.py). Clone " +
    "github.com/jamiepine/voicebox first, then pass the path explicitly:\n" +
    "  npm run setup:voicebox -- \"/path/to/voicebox\""
  );
}

function findPython() {
  const candidates = process.platform === "win32"
    ? [["py", ["-3.10"]], ["py", ["-3.11"]], ["py", ["-3.12"]], ["python", []]]
    : [["python3.10", []], ["python3.11", []], ["python3.12", []], ["python3", []]];
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, [...args, "--version"], { encoding: "utf8" });
    if (r.status === 0) {
      log(`Using ${cmd} ${args.join(" ")} → ${(r.stdout || r.stderr || "").trim()}`);
      return { cmd, args };
    }
  }
  die("No usable Python 3.10–3.12 found. Install Python 3.10 (matches Voicebox/Chatterbox's tested pins) and re-run.");
}

function hasNvidiaGpu() {
  return spawnSync("nvidia-smi", [], { encoding: "utf8" }).status === 0;
}

function venvPython(voiceboxDir) {
  return process.platform === "win32"
    ? path.join(voiceboxDir, "backend", "venv", "Scripts", "python.exe")
    : path.join(voiceboxDir, "backend", "venv", "bin", "python");
}

const ALIGN_PY = `import sys
import json

from faster_whisper import WhisperModel

def main():
    audio_path = sys.argv[1]
    model = WhisperModel("small.en", device="auto", compute_type="auto")
    segments, _info = model.transcribe(audio_path, word_timestamps=True, language="en")
    words = []
    for seg in segments:
        for w in (seg.words or []):
            words.append({"word": w.word, "start": w.start, "end": w.end})
    print(json.dumps({"words": words}))

if __name__ == "__main__":
    main()
`;

async function main() {
  const voiceboxDir = resolveVoiceboxDir();
  log(`Using Voicebox checkout at ${voiceboxDir}`);

  const py = findPython();
  const vpy = venvPython(voiceboxDir);
  const venvDir = path.join(voiceboxDir, "backend", "venv");

  // 1. Venv.
  if (!fs.existsSync(vpy)) {
    if (!run(py.cmd, [...py.args, "-m", "venv", venvDir])) die("venv creation failed");
  } else {
    log("Venv already present — skipping.");
  }
  run(vpy, ["-m", "pip", "install", "--upgrade", "pip"]);

  // 2. Torch — GPU build if an NVIDIA GPU is present, else CPU.
  const gpu = hasNvidiaGpu();
  log(`NVIDIA GPU detected: ${gpu}`);
  const torchIndex = gpu ? "https://download.pytorch.org/whl/cu124" : "https://download.pytorch.org/whl/cpu";
  if (!run(vpy, ["-m", "pip", "install", "torch", "torchvision", "torchaudio", "--index-url", torchIndex])) {
    log("WARNING: torch install failed — see the error above.");
  }

  // 3. Backend requirements (Kokoro, LuxTTS, Qwen3-TTS deps, etc.).
  // misaki[en,ja,zh] pulls in pyopenjtalk (Japanese phonemizer), which needs a
  // Cython/C++ build (Visual Studio Build Tools) most machines don't have and
  // don't need for English-only narration — drop the ja/zh extras.
  const reqPath = path.join(voiceboxDir, "backend", "requirements.txt");
  if (fs.existsSync(reqPath)) {
    const filtered = fs
      .readFileSync(reqPath, "utf8")
      .replace(/misaki\[en,ja,zh\]/g, "misaki[en]");
    const filteredPath = path.join(ALIGN_DIR, "requirements.filtered.txt");
    fs.mkdirSync(ALIGN_DIR, { recursive: true });
    fs.writeFileSync(filteredPath, filtered, "utf8");
    if (!run(vpy, ["-m", "pip", "install", "-r", filteredPath])) {
      die(
        "backend/requirements.txt install failed. This usually means a pinned version has no wheel " +
        "for this Python — Voicebox's own docs recommend Python 3.10-3.12; see the error above for which package failed."
      );
    }
  } else {
    log("WARNING: backend/requirements.txt not found — is the Voicebox checkout path correct?");
  }

  // 4. Chatterbox + TADA — installed --no-deps deliberately (their pins conflict
  // with the modern torch we just installed above).
  run(vpy, ["-m", "pip", "install", "--no-deps", "chatterbox-tts"]);
  run(vpy, ["-m", "pip", "install", "--no-deps", "hume-tada"]);
  // Qwen3-TTS from source — the PyPI qwen-tts package in requirements.txt can lag
  // actual model support; Voicebox's own justfile installs straight from GitHub too.
  if (!run(vpy, ["-m", "pip", "install", "git+https://github.com/QwenLM/Qwen3-TTS.git"])) {
    log("WARNING: Qwen3-TTS git install failed — the 'qwen' engine may not work, but Kokoro/Chatterbox are unaffected.");
  }

  // 5. Local word-level alignment (Voicebox's own /generate and /transcribe
  // return no word timestamps).
  if (!run(vpy, ["-m", "pip", "install", "faster-whisper"])) {
    log("WARNING: faster-whisper install failed — voiceover word timing will fall back to Groq/proportional.");
  }
  fs.mkdirSync(ALIGN_DIR, { recursive: true });
  fs.writeFileSync(path.join(ALIGN_DIR, "align.py"), ALIGN_PY, "utf8");
  log(`Wrote alignment script to ${path.join(ALIGN_DIR, "align.py")}`);

  // 6. Smoke test — start the backend, confirm it answers, confirm at least the
  // lightweight Kokoro preset engine is reachable, then stop it.
  log("Running a smoke test (starting the backend)…");
  const server = spawn(vpy, ["-m", "uvicorn", "backend.main:app", "--port", "17493"], {
    cwd: voiceboxDir,
    stdio: "pipe",
  });
  let stderrTail = "";
  server.stderr.on("data", (b) => { stderrTail = (stderrTail + b.toString()).slice(-3000); });

  const deadline = Date.now() + 3 * 60 * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const resp = await fetch("http://127.0.0.1:17493/profiles");
      if (resp.ok) { ok = true; break; }
    } catch {}
  }
  if (ok) {
    try {
      const presets = await (await fetch("http://127.0.0.1:17493/profiles/presets/kokoro")).json();
      log(`SUCCESS — backend answered, Kokoro presets: ${(presets.voices || []).length} voice(s) available.`);
    } catch {
      log("SUCCESS — backend answered (Kokoro presets check failed, non-fatal).");
    }
  } else {
    log(`Smoke test FAILED — backend never answered on :17493. Last stderr:\n${stderrTail}`);
  }
  server.kill();

  log("Done. Next steps:");
  log(`  1. In /settings (or /parametres), set Voicebox — checkout folder = ${voiceboxDir}`);
  log("  2. Create a preset (Kokoro, no sample needed) or clone your own voice on /voices.");
  log("  3. Pick it as the default on /settings (VOICEBOX_PROFILE_ID), or pass voiceOverride per run/channel.");
  log("  4. Set Voice provider = Voicebox on /parametres.");
}

main().catch((e) => die(e.stack || e.message));

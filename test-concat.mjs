#!/usr/bin/env node
// Confirm the audio-cutoff root cause: does `-c copy` mp3 concat under-report
// duration vs a re-encode? Synthesize 2 MiniMax chunks, concat both ways,
// ffprobe all. Scratch file — delete after.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const keysPath = "C:\\Users\\cupak\\Downloads\\Telegram Desktop\\conveyer-bullnet-API-KEYS.txt";
const keys = {};
for (const line of fs.readFileSync(keysPath, "utf-8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.+)$/);
  if (m) keys[m[1]] = m[2].trim();
}

async function minimax(text, outPath) {
  const url = `https://api.minimax.io/v1/t2a_v2?GroupId=${encodeURIComponent(keys.MINIMAX_GROUP_ID)}`;
  const body = {
    model: keys.MINIMAX_MODEL || "speech-02-hd",
    text,
    stream: false,
    voice_setting: { voice_id: keys.MINIMAX_VOICE_ID, speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.MINIMAX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  const hex = j.data?.audio;
  if (!hex) throw new Error(`no audio: ${JSON.stringify(j).slice(0, 200)}`);
  fs.writeFileSync(outPath, Buffer.from(hex, "hex"));
}

function dur(p) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", p],
    { encoding: "utf-8" }
  );
  return parseFloat((r.stdout || "").trim()) || 0;
}

const tmp = os.tmpdir();
const a = path.join(tmp, "cc_a.mp3");
const b = path.join(tmp, "cc_b.mp3");
const list = path.join(tmp, "cc_list.txt");
const copyOut = path.join(tmp, "cc_copy.mp3");
const reencOut = path.join(tmp, "cc_reenc.mp3");

console.log("Synthesizing 2 MiniMax chunks…");
await minimax(
  "Hello, this is the first chunk of audio used for a concatenation test of the pipeline.",
  a
);
await minimax(
  "And this is the second chunk, which adds several more seconds so we can measure the total duration accurately and reliably.",
  b
);
const da = dur(a);
const db = dur(b);
console.log(`chunk A: ${da.toFixed(2)}s · chunk B: ${db.toFixed(2)}s · SUM: ${(da + db).toFixed(2)}s`);

fs.writeFileSync(list, `file '${a.replace(/\\/g, "/")}'\nfile '${b.replace(/\\/g, "/")}'\n`);

spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", copyOut], {
  stdio: "pipe",
});
spawnSync(
  "ffmpeg",
  ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "libmp3lame", "-b:a", "128k", reencOut],
  { stdio: "pipe" }
);

console.log("\n=== RESULT ===");
console.log(`-c copy  concat duration: ${dur(copyOut).toFixed(2)}s   (should be ~${(da + db).toFixed(2)})`);
console.log(`re-encode concat duration: ${dur(reencOut).toFixed(2)}s   (should be ~${(da + db).toFixed(2)})`);

for (const f of [a, b, list, copyOut, reencOut]) {
  try { fs.unlinkSync(f); } catch {}
}

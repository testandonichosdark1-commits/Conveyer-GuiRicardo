#!/usr/bin/env node
// Prove the avatar-mode "brain" end-to-end on real API calls, BEFORE we have a
// HeyGen MP4: synthesize a short sample narration (stands in for the avatar's
// speech), transcribe it (Groq Whisper → segments), then plan per-segment
// layouts (Gemini → avatar/split/broll + visual query). Mirrors the logic in
// src/lib/services/transcribe.ts + avatar-plan.ts. Scratch file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const keysPath = "C:/Users/cupak/Downloads/Telegram Desktop/conveyer-bullnet-API-KEYS.txt";
const keys = {};
for (const line of fs.readFileSync(keysPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.+)$/);
  if (m) keys[m[1]] = m[2].trim();
}

// A few sentences that SHOULD trigger a mix of layouts: hook (avatar),
// concrete things (broll/split), abstract line (avatar).
const SCRIPT =
  "Let me tell you something most people never realize. " +
  "My grandfather built this entire barn with his own hands back in 1952. " +
  "Every morning he would walk out to the chicken coop and collect the eggs. " +
  "Down at the limestone quarry, the workers still cut stone the old way. " +
  "But here is the real secret nobody talks about. " +
  "It is not about the tools. It is about patience.";

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
  if (!hex) throw new Error("MiniMax: no audio " + JSON.stringify(j).slice(0, 200));
  fs.writeFileSync(outPath, Buffer.from(hex, "hex"));
}

async function transcribe(mp3Path) {
  // Mirror transcribe.ts: extract mono 16k mp3 then Groq Whisper verbose_json.
  const wav = mp3Path.replace(/\.mp3$/, "__a.mp3");
  spawnSync("ffmpeg", ["-y", "-i", mp3Path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", wav], { stdio: "pipe" });
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(wav)], { type: "audio/mpeg" }), "audio.mp3");
  fd.append("model", "whisper-large-v3");
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "segment");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.GROQ_API_KEY}` },
    body: fd,
  });
  if (!r.ok) throw new Error("Groq " + r.status + ": " + (await r.text()).slice(0, 200));
  const j = await r.json();
  try { fs.unlinkSync(wav); } catch {}
  return (j.segments || []).map((s, i) => ({
    index: i,
    startMs: Math.round(s.start * 1000),
    endMs: Math.round(s.end * 1000),
    text: (s.text || "").trim(),
  })).filter((s) => s.text);
}

async function planBeats(segments) {
  const numbered = segments.map((s) => `[${s.index}] ${s.text}`).join("\n");
  const userPrompt =
    `You are editing a talking-head (avatar) video into a dynamic faceless-style edit. ` +
    `Below are transcript segments of the avatar speaking, one per line as "[index] text".\n\n` +
    `For EACH segment decide the screen layout:\n` +
    `- "avatar": avatar full-screen (hook/intro, direct address, abstract lines).\n` +
    `- "broll": full-screen B-roll cutaway (a concrete object/place/action is named).\n` +
    `- "split": avatar on one side, B-roll on the other (explanatory lines).\n\n` +
    `Open on "avatar". Vary the layout for rhythm. For "broll"/"split" give a SHORT 3-8 word visual query of concrete nouns. For "avatar" visual_query is "".\n\n` +
    `Transcript:\n${numbered}\n\n` +
    `Return STRICTLY a JSON array, one object per segment in order: {"index":int,"layout":"avatar"|"broll"|"split","visual_query":string}. No markdown.`;
  const model = keys.SCENE_SPLIT_MODEL || "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(keys.GOOGLE_API_KEY)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.6, maxOutputTokens: 16000, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!r.ok) throw new Error("Gemini " + r.status + ": " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || text);
}

const tmp = os.tmpdir();
const mp3 = path.join(tmp, "avatar-brain-sample.mp3");

console.log("1) Synthesizing sample narration (stand-in for avatar speech)…");
await minimax(SCRIPT, mp3);
console.log(`   ok — ${fs.statSync(mp3).size} bytes`);

console.log("2) Transcribing (Groq Whisper → segments)…");
const segments = await transcribe(mp3);
console.log(`   ok — ${segments.length} segments:`);
for (const s of segments) console.log(`     [${s.index}] ${(s.startMs/1000).toFixed(1)}-${(s.endMs/1000).toFixed(1)}s  ${s.text}`);

console.log("3) Planning layouts (Gemini → avatar/split/broll + visual)…");
const beats = await planBeats(segments);
console.log("   ok — beat plan:");
for (const b of beats) {
  const seg = segments.find((s) => s.index === b.index);
  const t = seg ? `${(seg.startMs/1000).toFixed(1)}-${(seg.endMs/1000).toFixed(1)}s` : "?";
  console.log(`     [${b.index}] ${t}  ${String(b.layout).toUpperCase().padEnd(6)} ${b.visual_query ? "→ " + b.visual_query : ""}`);
}

const counts = beats.reduce((m, b) => ((m[b.layout] = (m[b.layout] || 0) + 1), m), {});
console.log(`\n=== SUMMARY: ${beats.length} beats · ${JSON.stringify(counts)} ===`);
try { fs.unlinkSync(mp3); } catch {}

import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";

/**
 * VoiceStudio (local TTS app). The splitter is pure; the TTS function is driven against a
 * fake VoiceStudio speaking the probed contract (POST /v1/audio/speech → audio bytes),
 * with a REAL ffmpeg join/transcode — "outPath is an MP3" is what every caller relies on.
 */

const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { splitForVoiceStudio, voicestudioTts, VOICESTUDIO_MAX_CHARS } from "./voicestudio";

describe("splitForVoiceStudio", () => {
  it("keeps a short text whole", () => {
    expect(splitForVoiceStudio("One sentence. Two sentences.")).toEqual(["One sentence. Two sentences."]);
  });

  it("splits a long script at sentence boundaries, every piece under VoiceStudio's 4096 cap", () => {
    const sentence = "The canoe slid past the warship without a sound, and nobody on deck saw it. ";
    const text = sentence.repeat(400);
    const pieces = splitForVoiceStudio(text);
    expect(pieces.length).toBeGreaterThan(5);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(VOICESTUDIO_MAX_CHARS);
      expect(p.endsWith(".")).toBe(true);
    }
    expect(pieces.join(" ").replace(/\s+/g, " ")).toBe(text.trim().replace(/\s+/g, " "));
  });

  it("cuts a single over-long sentence at word boundaries instead of failing", () => {
    const run = "word ".repeat(2000).trim();
    const pieces = splitForVoiceStudio(run);
    expect(pieces.every((p) => p.length <= VOICESTUDIO_MAX_CHARS)).toBe(true);
    expect(pieces.join(" ").split(" ").length).toBe(2000);
  });
});

describe("voicestudioTts against a fake VoiceStudio", () => {
  let server: http.Server;
  let mp3: Buffer;
  const seen: { voice: string; model: string; chars: number }[] = [];
  let failNext = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicestudio-"));

  beforeAll(async () => {
    const src = path.join(dir, "tone.mp3");
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "24000", src]);
    mp3 = fs.readFileSync(src);
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/v1/audio/speech") {
          if (failNext > 0) {
            failNext--;
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "engine exploded" } }));
            return;
          }
          const j = JSON.parse(body) as { voice: string; model: string; input: string };
          seen.push({ voice: j.voice, model: j.model, chars: j.input.length });
          res.writeHead(200, { "content-type": "audio/mpeg" });
          res.end(mp3);
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"status":"ok"}');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    settings.VOICESTUDIO_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("narrates in pieces, joins them into one 44.1 kHz MP3, defaults to mlx-audio + am_michael", async () => {
    const out = path.join(dir, "a.mp3");
    const text = "A sentence about canoes and warships. ".repeat(200); // ~7.6k chars → 3 pieces
    await voicestudioTts("r1", text, out, null, null);
    expect(seen.length).toBe(3);
    expect(seen.every((s) => s.model === "mlx-audio" && s.voice === "am_michael")).toBe(true);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", out]);
    expect(probe.stdout.toString().trim()).toBe("44100");
  });

  it("ignores a channel voice that belongs to another provider", async () => {
    seen.length = 0;
    await voicestudioTts("r2", "Short line.", path.join(dir, "b.mp3"), "elevenlabs_W2vNaOpQPTSPBLdAoHRX", null);
    expect(seen[0].voice).toBe("am_michael");
  });

  it("re-running the same text reuses the finished narration; a new voice renders again", async () => {
    seen.length = 0;
    const out = path.join(dir, "c.mp3");
    const text = "Another sentence about the special boat service. ".repeat(160); // 3 pieces
    await voicestudioTts("r3", text, out, null, null);
    expect(seen.length).toBe(3);
    seen.length = 0;
    await voicestudioTts("r3", text, out, null, null);
    expect(seen.length).toBe(0);
    await voicestudioTts("r3", text, out, "bm_george", null);
    expect(seen.length).toBe(3);
  });

  it("after a failure mid-text, the retry only narrates the pieces that are missing", async () => {
    seen.length = 0;
    const out = path.join(dir, "e.mp3");
    const text = "Yet another sentence about canoe raids on the French coast. ".repeat(130); // 3 pieces
    // Fail the 2nd request: piece 1 succeeds, piece 2 errors.
    let n = 0;
    const realPush = seen.push.bind(seen);
    seen.push = (...a) => { n++; if (n === 1) failNext = 1; return realPush(...a); };
    await expect(voicestudioTts("r5", text, out, null, null)).rejects.toThrow(/engine exploded/);
    seen.push = realPush;
    expect(seen.length).toBe(1);
    seen.length = 0;
    await voicestudioTts("r5", text, out, null, null);
    expect(seen.length).toBe(2);
  });

  it("a non-recoverable error is surfaced with VoiceStudio's own message", async () => {
    failNext = 1;
    await expect(voicestudioTts("r4", "Fails once.", path.join(dir, "d.mp3"), null, null)).rejects.toThrow(
      /VoiceStudio 500: engine exploded/
    );
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";

/**
 * Voicebox (local voice-cloning server). The helpers are pure; the TTS branch is driven
 * end-to-end against a fake Voicebox speaking the real contract (create → poll → WAV
 * download), with a REAL ffmpeg transcode, because "the file at outPath is an MP3" is the
 * invariant every caller depends on and a mock ffmpeg could not prove it.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));

import { voiceboxBaseUrl, voiceboxLanguage, readVoiceboxJob, voiceboxErrorDetail, VOICEBOX_DEFAULT_BASE } from "./voicebox";
import { synthesizeFullScript } from "./tts";

describe("voicebox helpers", () => {
  it("blank URL means the documented local default, trailing slashes trimmed", () => {
    expect(voiceboxBaseUrl("")).toBe(VOICEBOX_DEFAULT_BASE);
    expect(voiceboxBaseUrl("  ")).toBe("http://127.0.0.1:17493");
    expect(voiceboxBaseUrl("http://10.0.0.5:17493//")).toBe("http://10.0.0.5:17493");
  });

  it("sends the profile's language when Voicebox accepts it, else English", () => {
    expect(voiceboxLanguage("pt")).toBe("pt");
    expect(voiceboxLanguage("PT-BR")).toBe("pt");
    expect(voiceboxLanguage("xx")).toBe("en");
    expect(voiceboxLanguage(null)).toBe("en");
  });

  it("only completed is done; failed/cancelled carry the error; anything else is pending", () => {
    expect(readVoiceboxJob({ status: "completed" })).toEqual({ state: "done" });
    expect(readVoiceboxJob({ status: "failed", error: "CUDA OOM" })).toEqual({ state: "failed", error: "CUDA OOM" });
    expect(readVoiceboxJob({ status: "loading_model" })).toEqual({ state: "pending", status: "loading_model" });
    expect(readVoiceboxJob({ status: "generating" }).state).toBe("pending");
  });

  it("reads FastAPI's {detail} in both its string and validation-list forms", () => {
    expect(voiceboxErrorDetail('{"detail":"Profile not found"}')).toBe("Profile not found");
    expect(voiceboxErrorDetail('{"detail":[{"msg":"bad language"},{"msg":"too long"}]}')).toBe("bad language; too long");
    expect(voiceboxErrorDetail("plain")).toBe("plain");
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("voicebox TTS branch (fake server, real ffmpeg)", () => {
  let server: http.Server;
  let wav: Buffer;
  let tmp: string;
  const seen: { method: string; url: string; body?: unknown }[] = [];
  let polls = 0;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-test-"));
    const wavPath = path.join(tmp, "tone.wav");
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", wavPath]);
    wav = fs.readFileSync(wavPath);

    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined });
        const json = (code: number, b: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(b));
        };
        if (req.url === "/profiles/gone") return json(404, { detail: "Profile not found" });
        if (req.url === "/profiles/p1") return json(200, { id: "p1", name: "Jiro", language: "pt" });
        if (req.url === "/generate") return json(200, { id: "g1", status: "generating" });
        if (req.url === "/history/g1") return json(200, { id: "g1", status: ++polls < 2 ? "generating" : "completed" });
        if (req.url === "/audio/g1") {
          res.writeHead(200, { "content-type": "audio/wav" });
          return res.end(wav);
        }
        json(404, { detail: "nope" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    settings.VOICEBOX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates with the profile's language, polls to completion, and writes a real MP3", async () => {
    const out = path.join(tmp, "voiceover.mp3");
    settings.VOICEBOX_VOICE_ID = "p1";
    await synthesizeFullScript("run-vb", "Olá mundo.", out, { provider: "voicebox" });

    const create = seen.find((s) => s.url === "/generate");
    expect(create?.body).toEqual({ profile_id: "p1", text: "Olá mundo.", language: "pt" });
    const head = fs.readFileSync(out).subarray(0, 3);
    expect(head.toString("ascii") === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)).toBe(true);
    // The raw WAV scratch file is cleaned up.
    expect(fs.existsSync(`${out}.voicebox-src`)).toBe(false);
  }, 20_000);

  it("a channel voice override wins, and a deleted profile fails before anything is queued", async () => {
    const before = seen.filter((s) => s.url === "/generate").length;
    await expect(
      synthesizeFullScript("run-vb", "Hi.", path.join(tmp, "x.mp3"), { provider: "voicebox", voiceOverride: "gone" })
    ).rejects.toThrow(/no voice profile "gone"/);
    expect(seen.filter((s) => s.url === "/generate").length).toBe(before);
  });

  it("says Voicebox isn't running when nothing listens at the URL", async () => {
    const saved = settings.VOICEBOX_URL;
    settings.VOICEBOX_URL = "http://127.0.0.1:1";
    try {
      await expect(
        synthesizeFullScript("run-vb", "Hi.", path.join(tmp, "y.mp3"), { provider: "voicebox" })
      ).rejects.toThrow(/Could not reach Voicebox/);
    } finally {
      settings.VOICEBOX_URL = saved;
    }
  });
});

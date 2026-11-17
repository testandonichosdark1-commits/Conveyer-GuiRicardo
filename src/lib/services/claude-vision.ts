/**
 * Scores candidate stock clips with Claude (the operator's own Claude Code login, `claude -p`)
 * instead of Gemini: no API bill and no per-minute quota, at the price of the subscription's
 * usage limit. VISION_SCORING=claude selects it (see scoreAndPick in visual-source.ts).
 *
 * The preview images are written to a private temp folder and Claude opens them with the Read
 * tool — the only tool it gets, confined to that folder. Output is forced into a JSON schema,
 * so the answer needs no parsing heuristics. Any failure throws; scoreAndPick then falls back to
 * the lexical scorer exactly as it does when Gemini fails.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface VisionImage {
  mime: string;
  data: string; // base64
}

const SCHEMA = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, score: { type: "integer" } },
        required: ["i", "score"],
      },
    },
  },
  required: ["data"],
};

// Process-wide limit on simultaneous `claude` processes (beats run in parallel).
const g = globalThis as unknown as { __facelessClaudeVision?: { active: number; waiters: (() => void)[] } };
const gate = (g.__facelessClaudeVision ??= { active: 0, waiters: [] });
function limit(): number {
  const n = Number(process.env.CLAUDE_VISION_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 8) : 3;
}
async function acquire() {
  if (gate.active >= limit()) await new Promise<void>((r) => gate.waiters.push(r));
  gate.active++;
}
function release() {
  gate.active--;
  gate.waiters.shift()?.();
}

const ext = (mime: string) => (/png/i.test(mime) ? "png" : /webp/i.test(mime) ? "webp" : "jpg");

export function visionFileName(i: number, mime: string): string {
  return `cand_${i}.${ext(mime)}`;
}

export async function claudeScoreCandidates(opts: {
  instructions: string;
  /** One entry per candidate, in order; null = no preview (scored from its title only). */
  images: (VisionImage | null)[];
  model?: string;
  timeoutMs?: number;
}): Promise<{ i: number; score: number }[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-vision-"));
  try {
    const files = opts.images.map((img, i) => {
      if (!img) return null;
      const name = visionFileName(i, img.mime);
      fs.writeFileSync(path.join(dir, name), Buffer.from(img.data, "base64"));
      return name;
    });
    const prompt =
      `${opts.instructions}\n\n` +
      `Each candidate's preview image is a file in the current directory: ` +
      files.map((f, i) => (f ? `[${i}] = ${f}` : `[${i}] = (no image, judge by its title)`)).join(", ") +
      `. Open EVERY image with the Read tool first (all in one step), then answer. ` +
      `Answer with one entry per candidate: {"i": <number>, "score": <0-100>}.`;
    const args = [
      "-p",
      "--model", opts.model || "haiku",
      "--tools", "Read",
      "--allowedTools", "Read",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format", "json",
      "--json-schema", JSON.stringify(SCHEMA),
      "--system-prompt", "You are an image-relevance judge inside a video tool. Use only the Read tool, only on the listed files.",
    ];
    await acquire();
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.env.FACTORY_CLAUDE_BIN || "claude", args, { cwd: dir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Claude vision timeout after ${Math.round((opts.timeoutMs ?? 180_000) / 1000)}s`));
        }, opts.timeoutMs ?? 180_000);
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(new Error(`Claude CLI could not start: ${e.message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (!stdout.trim()) return reject(new Error(`Claude CLI exited ${code}: ${stderr.slice(0, 200)}`));
          resolve(stdout);
        });
        child.stdin.end(prompt);
      });
      let res: { is_error?: boolean; result?: string; structured_output?: { data?: { i: number; score: number }[] } };
      try {
        res = JSON.parse(out);
      } catch {
        throw new Error(`Claude vision returned non-JSON output (${out.slice(0, 120)})`);
      }
      if (res.is_error) throw new Error(`Claude: ${(res.result ?? "error").slice(0, 200)}`);
      const data = res.structured_output?.data;
      if (!Array.isArray(data) || data.length === 0) throw new Error("Claude vision returned no scores");
      return data.filter((x) => Number.isFinite(x.i) && Number.isFinite(x.score));
    } finally {
      release();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

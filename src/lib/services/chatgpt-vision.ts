/**
 * Scores candidate stock clips with ChatGPT, through the operator's own ChatGPT/Codex account
 * (`codex exec`, the same exclusive account folder the LTX/thumbnail image generation uses).
 * No API key, no per-call bill, and it leaves the Claude subscription's usage limit free for
 * the script, thumbnail prompt and planner. VISION_SCORING=chatgpt selects it.
 *
 * Measured on the same six candidates as claude-vision.ts: ~8 s, scores in the same range, the
 * same ordering at the top. Previews are attached as images (`-i`), the answer is forced into a
 * JSON schema, and the session is ephemeral and read-only. Any failure throws; scoreAndPick
 * then falls back to the lexical scorer, as it does for Gemini and Claude.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSetting } from "../settings";
import { codexImageEnvironment } from "./codex-images";
import { codexImageConfigured, codexImageProfile } from "./codex-image-runtime";
import type { VisionImage } from "./claude-vision";

// OpenAI structured output needs every property required and additionalProperties:false.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { i: { type: "integer" }, score: { type: "integer" } },
        required: ["i", "score"],
      },
    },
  },
  required: ["data"],
};

const g = globalThis as unknown as { __facelessChatgptVision?: { active: number; waiters: (() => void)[] } };
const gate = (g.__facelessChatgptVision ??= { active: 0, waiters: [] });
function limit(): number {
  const n = Number(process.env.CHATGPT_VISION_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 6) : 3;
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

export async function chatgptScoreCandidates(opts: {
  instructions: string;
  images: (VisionImage | null)[];
  timeoutMs?: number;
}): Promise<{ i: number; score: number }[]> {
  if (!(await codexImageConfigured())) throw new Error("ChatGPT account is not set up on this Mac (Codex image profile missing)");
  const profile = codexImageProfile();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-vision-"));
  try {
    const attached: string[] = [];
    const order: string[] = [];
    opts.images.forEach((img, i) => {
      if (!img) {
        order.push(`[${i}] = (no image, judge by its title)`);
        return;
      }
      const file = path.join(dir, `cand_${i}.${ext(img.mime)}`);
      fs.writeFileSync(file, Buffer.from(img.data, "base64"));
      attached.push(file);
      order.push(`[${i}] = image #${attached.length} of those attached`);
    });
    fs.writeFileSync(path.join(dir, "schema.json"), JSON.stringify(SCHEMA));
    const outFile = path.join(dir, "answer.json");
    const prompt =
      `${opts.instructions}\n\n` +
      `The candidates' preview images are attached in order: ${order.join("; ")}. ` +
      `Answer only with the JSON: one entry per candidate, {"i": <number>, "score": <0-100>}.`;
    // CHATGPT_VISION_MODEL picks the model (blank = the account's default). Validated: it goes on a command line.
    const model = (getSetting("CHATGPT_VISION_MODEL") || "").trim();
    if (model && !/^[a-z0-9][a-z0-9.\-]{0,40}$/i.test(model)) throw new Error(`CHATGPT_VISION_MODEL "${model}" is not a valid model id`);
    const args = [
      "exec",
      ...(model ? ["-m", model] : []),
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox", "read-only",
      "-C", dir,
      "--output-schema", path.join(dir, "schema.json"),
      "--output-last-message", outFile,
      ...attached.flatMap((f) => ["-i", f]),
      "-", // prompt from stdin, so it can never be swallowed by the variadic -i
    ];
    await acquire();
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(profile.executable, args, {
          cwd: dir,
          env: codexImageEnvironment(process.env, profile.accountHome),
          stdio: ["pipe", "ignore", "pipe"],
        });
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`ChatGPT vision timeout after ${Math.round((opts.timeoutMs ?? 180_000) / 1000)}s`));
        }, opts.timeoutMs ?? 180_000);
        child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-600)));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(new Error(`Codex could not start: ${e.message}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(new Error(`Codex exited ${code}: ${stderr.slice(-200)}`));
        });
        child.stdin.end(prompt);
      });
    } finally {
      release();
    }
    let parsed: { data?: { i: number; score: number }[] };
    try {
      parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
    } catch {
      throw new Error("ChatGPT vision returned no readable answer");
    }
    const data = parsed.data;
    if (!Array.isArray(data) || data.length === 0) throw new Error("ChatGPT vision returned no scores");
    return data.filter((x) => Number.isFinite(x.i) && Number.isFinite(x.score));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

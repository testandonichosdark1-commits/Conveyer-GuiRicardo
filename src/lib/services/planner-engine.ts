/**
 * Which model writes the PLAN (visual world, per-beat search queries, graphic picks).
 *
 * PLANNER_ENGINE = "gemini" (default, unchanged) | "claude". With "claude" the three text-only
 * planner calls run through the operator's own Claude Code login (`claude -p`), so they cost
 * no API money; the high-volume IMAGE scoring stays on Gemini (Flash-Lite), which Claude
 * could only do slowly and against the subscription's limits.
 *
 * The seam is callGemini's own contract: callers keep building their Gemini request body and
 * parsing a Gemini-shaped response, and this module answers it from Claude instead. So none of
 * the planner's prompt, schema, validation or fallback code is duplicated or branched. Any
 * Claude failure (CLI missing, login expired, bad JSON twice) falls back to Gemini for that
 * call, so switching engines can never leave a run on the keyword planner.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { getSetting } from "../settings";
import { callGemini, type CallGeminiOptions, type CallGeminiResult } from "./gemini-models";

/** Gemini's OpenAPI-subset schema (UPPERCASE types, extra keys) → plain JSON Schema. */
export function toJsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "propertyOrdering" || k === "nullable") continue;
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase();
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    } else out[k] = toJsonSchema(v);
  }
  return out;
}

interface GeminiBody {
  contents?: { parts?: { text?: string }[] }[];
  systemInstruction?: { parts?: { text?: string }[] };
  generationConfig?: { responseSchema?: unknown; responseMimeType?: string };
}

/** Pulls the prompt and schema back out of a Gemini request body. */
export function claudeRequestFromGeminiBody(body: string): { prompt: string; system?: string; schema?: unknown } {
  const b = JSON.parse(body) as GeminiBody;
  const prompt = (b.contents ?? []).flatMap((c) => c.parts ?? []).map((p) => p.text ?? "").join("\n\n");
  const system = (b.systemInstruction?.parts ?? []).map((p) => p.text ?? "").join("\n\n") || undefined;
  const schema = b.generationConfig?.responseSchema ? toJsonSchema(b.generationConfig.responseSchema) : undefined;
  return { prompt, system, schema };
}

export function plannerEngine(): "gemini" | "claude" {
  return (getSetting("PLANNER_ENGINE") || "").trim().toLowerCase() === "claude" ? "claude" : "gemini";
}

function runClaudeJson(prompt: string, system: string, schema: unknown | undefined, model: string, timeoutMs: number): Promise<string> {
  // Claude's structured output needs an OBJECT at the root; the planner's schemas are arrays.
  const wrapped = schema ? { type: "object", properties: { data: schema }, required: ["data"] } : undefined;
  const args = [
    "-p",
    "--model", model,
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt", system,
    ...(wrapped ? ["--json-schema", JSON.stringify(wrapped)] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FACTORY_CLAUDE_BIN || "claude", args, { cwd: os.tmpdir(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude planner timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Claude CLI could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let res: { is_error?: boolean; result?: string; structured_output?: { data?: unknown } } | null = null;
      try {
        res = JSON.parse(out);
      } catch {
        /* not JSON */
      }
      if (!res) return reject(new Error(`Claude CLI exited ${code}: ${(err || out).slice(0, 200)}`));
      if (res.is_error) return reject(new Error(`Claude: ${(res.result ?? "error").slice(0, 200)}`));
      if (wrapped) {
        if (res.structured_output?.data === undefined) return reject(new Error("Claude returned no structured output"));
        return resolve(JSON.stringify(res.structured_output.data));
      }
      resolve(res.result ?? "");
    });
    child.stdin.end(prompt);
  });
}

/**
 * Drop-in for callGemini on the PLANNER's text calls. With PLANNER_ENGINE=claude it asks
 * Claude, wraps the answer as a Gemini response and runs the caller's own validate() on it
 * (two attempts); anything else, or any Claude failure, is plain callGemini.
 */
export async function callPlanner(opts: CallGeminiOptions & { log?: (msg: string) => void }): Promise<CallGeminiResult> {
  if (plannerEngine() !== "claude") return callGemini(opts);
  const model = getSetting("PLANNER_CLAUDE_MODEL") || "haiku";
  const servedAs = `claude:${model}`;
  let lastErr = "";
  try {
    const { prompt, system, schema } = claudeRequestFromGeminiBody(opts.body);
    const sys = [system, "You are a planning engine inside a video tool. Answer with the requested JSON only."].filter(Boolean).join("\n\n");
    const timeoutMs = Math.max(180_000, (opts.timeoutMs ?? 0) * 4);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const text = await runClaudeJson(prompt, sys, schema, model, timeoutMs);
        const json = { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: {} };
        opts.validate?.(json as never, servedAs);
        return { json: json as never, model: servedAs };
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
  } catch (e) {
    lastErr = (e as Error).message;
  }
  opts.log?.(`Claude planner failed (${lastErr.slice(0, 160)}) — using Gemini for this call`);
  return callGemini(opts);
}

/**
 * Runs Claude Code headless (`claude -p`) inside a job folder.
 *
 * The script and thumbnail steps are the operator's own Claude Code skills
 * (`roteiro-7-things`, `foxhole-thumbnail-generator`, installed under
 * ~/.claude/skills). Calling the CLI keeps them the single source of truth: an
 * edit to a skill changes what the factory produces, with no copy of the prompt
 * living in this app.
 *
 * Permissions are an allowlist, not bypass: web research, file writes inside the
 * job folder, the skills folder readable, and only the read-only shell commands
 * the skills use to measure and check their output.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export class ClaudeCliError extends Error {}

const ALLOWED_TOOLS = [
  "Skill",
  "Agent",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Bash(wc:*)",
  "Bash(grep:*)",
  "Bash(ls:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(cat:*)",
];

function claudeBinary(): string {
  return process.env.FACTORY_CLAUDE_BIN || "claude";
}

export interface ClaudeRunOptions {
  cwd: string;
  prompt: string;
  /** Model alias for the session (the skills pick their own sub-agent models). */
  model?: string;
  timeoutMs: number;
  /** Name for the transcript file kept in the job folder (claude-<name>.log). */
  logName: string;
  signal?: AbortSignal;
}

/** Resolves with the final text Claude printed; rejects on a non-zero exit, timeout or abort. */
export function runClaude(opts: ClaudeRunOptions): Promise<string> {
  const args = [
    "-p",
    opts.prompt,
    "--model",
    opts.model || process.env.FACTORY_CLAUDE_MODEL || "sonnet",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--add-dir",
    path.join(os.homedir(), ".claude", "skills"),
  ];
  const logPath = path.join(opts.cwd, `claude-${opts.logName}.log`);
  const log = fs.createWriteStream(logPath, { flags: "a" });

  return new Promise((resolve, reject) => {
    const child = spawn(claudeBinary(), args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      log.end();
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new ClaudeCliError(`Claude did not finish within ${Math.round(opts.timeoutMs / 60000)} min`)));
    }, opts.timeoutMs);
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new ClaudeCliError("cancelled")));
    };
    opts.signal?.addEventListener("abort", onAbort);

    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      log.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      log.write(d);
    });
    child.on("error", (e) =>
      finish(() =>
        reject(
          new ClaudeCliError(
            `could not start Claude Code (${claudeBinary()}): ${e.message}. Install it or set FACTORY_CLAUDE_BIN.`
          )
        )
      )
    );
    child.on("close", (code) =>
      finish(() =>
        code === 0
          ? resolve(out.trim())
          : reject(new ClaudeCliError(`Claude exited with code ${code}: ${(err || out).trim().slice(-600)}`))
      )
    );
  });
}

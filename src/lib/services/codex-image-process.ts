import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CodexImageRpc, codexImageEnvironment, initializeCodexImages, type CodexImageWire } from "./codex-images";

export type ImageAccountOwner = { home: string; close(): Promise<void> };
const owners = new WeakSet<ImageAccountOwner>();
/** One durable lock per account, shared only by this owner's bounded process pool. */
export async function ownImageAccount(accountHome: string): Promise<ImageAccountOwner> {
  const home = await fs.realpath(accountHome), file = path.join(home, "conveyer-image.lock");
  const lock = await fs.open(file, "wx", 0o600).catch(() => { throw new Error("Esta pasta já está em uso ou tem uma trava pendente."); });
  let closed = false;
  const owner: ImageAccountOwner = { home, async close() {
    if (closed) return; closed = true; owners.delete(owner);
    await lock.close(); await fs.rm(file, { force: true });
  } };
  owners.add(owner); return owner;
}

/** Explicit connection only. Does not create a thread, log in, copy credentials, or generate. */
export async function connectCodexImageProcess(options: { executable: string; accountHome: string; emptyWorkspace: string; owner?: ImageAccountOwner }) {
  if (!path.isAbsolute(options.executable)) throw new Error("Informe o executável absoluto do Codex.");
  const home = await fs.realpath(options.accountHome);
  const shared = await fs.realpath(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")).catch(() => "");
  if (home === shared) throw new Error("Use uma pasta exclusiva, autenticada separadamente. A conta deste aplicativo não será reutilizada.");
  if (!(await fs.stat(path.join(home, "auth.json"))).isFile()) throw new Error("A pasta exclusiva ainda não foi autenticada.");
  // No inherited custom provider, paid API routing, MCP server, or hook configuration.
  if (await fs.stat(path.join(home, "config.toml")).then(() => true, () => false)) throw new Error("A pasta exclusiva deve estar sem configuração personalizada.");
  const workspace = await fs.realpath(options.emptyWorkspace);
  if ((await fs.readdir(workspace)).length) throw new Error("A pasta de trabalho precisa estar vazia.");
  if (options.owner && (!owners.has(options.owner) || options.owner.home !== home)) throw new Error("Dono da conta inválido.");
  const owner = options.owner || await ownImageAccount(home);
  let child: ReturnType<typeof spawn> | undefined;
  let closed = false;
  const listeners = new Set<Parameters<CodexImageWire["subscribe"]>[0]>();
  const close = async () => {
    if (closed) return;
    closed = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child?.kill("SIGKILL"); }, 2000);
        child!.once("close", () => { clearTimeout(timer); resolve(); });
        child!.kill("SIGTERM");
      });
    }
    if (!options.owner) await owner.close();
  };
  try {
    child = spawn(options.executable, ["app-server", "--stdio"], { cwd: workspace,
      env: codexImageEnvironment(process.env, home), stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", () => { void close(); });
    // Drain stderr without recording tokens, prompts, or raw server output.
    child.stderr!.resume();
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", line => {
      if (line.length > 64 * 1024 * 1024) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      // Reject unexpected server requests (approvals, tool calls, etc.).
      if (message.method && message.id !== undefined) {
        child?.stdin?.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "External tools and approvals are disabled." } }) + "\n");
        return;
      }
      for (const listener of listeners) listener(message);
    });
    const wire: CodexImageWire = {
      send: message => {
        if (closed || !child?.stdin?.writable) throw new Error("Conexão Codex encerrada.");
        child.stdin.write(JSON.stringify(message) + "\n");
      },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    // Image generation may outlast control RPCs, especially with four concurrent jobs.
    const rpc = new CodexImageRpc(wire, 120_000, 600_000);
    await initializeCodexImages(rpc);
    return { rpc, close };
  } catch (error) { await close(); throw error; }
}

import { it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectCodexImageProcess } from "./codex-image-process";

it("refuses missing login, custom config, occupied workspace and account lock before spawning", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-process-guards-"));
  try {
    const home = path.join(root, "account"), workspace = path.join(root, "workspace");
    await fs.mkdir(home); await fs.mkdir(workspace);
    const options = { executable: process.execPath, accountHome: home, emptyWorkspace: workspace };
    await expect(connectCodexImageProcess(options)).rejects.toThrow();
    await fs.writeFile(path.join(home, "auth.json"), "{}"); // Fake fixture, never used for authentication.
    await fs.writeFile(path.join(home, "config.toml"), "# fixture");
    await expect(connectCodexImageProcess(options)).rejects.toThrow("configuração personalizada");
    await fs.rm(path.join(home, "config.toml"));
    await fs.writeFile(path.join(workspace, "occupied"), "fixture");
    await expect(connectCodexImageProcess(options)).rejects.toThrow("vazia");
    await fs.rm(path.join(workspace, "occupied"));
    await fs.writeFile(path.join(home, "conveyer-image.lock"), "owner fixture");
    await expect(connectCodexImageProcess(options)).rejects.toThrow("trava");
    expect(await fs.readFile(path.join(home, "conveyer-image.lock"), "utf8")).toBe("owner fixture");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("holds one account owner lock and refuses forged ownership before spawning", async () => {
  const { ownImageAccount } = await import("./codex-image-process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-owner-"));
  const home = path.join(root, "account"), workspace = path.join(root, "workspace");
  await fs.mkdir(home); await fs.mkdir(workspace); await fs.writeFile(path.join(home, "auth.json"), "{}");
  const owner = await ownImageAccount(home);
  try {
    await expect(ownImageAccount(home)).rejects.toThrow("trava");
    await expect(connectCodexImageProcess({ executable: process.execPath, accountHome: home, emptyWorkspace: workspace, owner: { home, close: async () => {} } })).rejects.toThrow("inválido");
  } finally { await owner.close(); await fs.rm(root, { recursive: true, force: true }); }
});

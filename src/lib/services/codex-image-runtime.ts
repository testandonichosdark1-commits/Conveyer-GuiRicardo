import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { connectCodexImageProcess, ownImageAccount } from "./codex-image-process";
import { generateCodexImage, recoverCodexImage } from "./codex-images";
import { ImageProcessPool } from "./codex-image-pool";
import type { ImageDriver } from "./codex-image-jobs";

export function codexImageProfile() {
  const base = path.join(os.homedir(), "Documents", "Codex", "conveyer-private", "codex-images");
  return { accountHome: process.env.CONVEYER_CODEX_IMAGE_HOME || path.join(base, "account"),
    emptyWorkspace: process.env.CONVEYER_CODEX_IMAGE_WORKSPACE || path.join(base, "workspace"),
    executable: process.env.CONVEYER_CODEX_EXECUTABLE || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    model: process.env.CONVEYER_CODEX_CONTROLLER || "gpt-6-luna" };
}
/** Filesystem preflight only; never launches Codex or reads credential contents. */
export async function codexImageConfigured() {
  const p = codexImageProfile();
  try {
    return (await fs.stat(path.join(p.accountHome, "auth.json"))).isFile() && (await fs.stat(p.executable)).isFile() &&
      (await fs.readdir(p.emptyWorkspace)).length === 0;
  } catch { return false; }
}
type Connection = Awaited<ReturnType<typeof connectCodexImageProcess>>;
// Survive Next development module reloads; one queue and owner for the account.
const shared = globalThis as typeof globalThis & { conveyerImagePool?: {
  key: string; pool: ImageProcessPool<Connection>; pendingOwner: ReturnType<typeof ownImageAccount>;
} };
export async function connectImageDriver(model: string): Promise<ImageDriver> {
  const p = codexImageProfile(), key = JSON.stringify([p.accountHome, p.emptyWorkspace, p.executable]);
  if (shared.conveyerImagePool && shared.conveyerImagePool.key !== key) throw new Error("A conta mudou enquanto o pool estava ativo.");
  if (!shared.conveyerImagePool) {
    const pendingOwner = ownImageAccount(p.accountHome);
    // Attach a rejection handler immediately; all callers still receive the failure.
    void pendingOwner.catch(() => {});
    const pool = new ImageProcessPool<Connection>(async () => connectCodexImageProcess({ ...p, owner: await pendingOwner }), async () => {
      try { await (await pendingOwner).close(); }
      finally { if (shared.conveyerImagePool?.pool === pool) delete shared.conveyerImagePool; }
    });
    shared.conveyerImagePool = { key, pool, pendingOwner };
  }
  const active = shared.conveyerImagePool;
  let lease;
  try { lease = await active.pool.acquire(); }
  catch (error) {
    try { await active.pool.close(); } catch {}
    throw error;
  }
  let broken = false, conversation = false;
  return {
    generate: async (prompt, recordThread) => {
      conversation = true;
      try { return await generateCodexImage(lease.value.rpc, { model, emptyWorkspace: p.emptyWorkspace, prompt, recordThread, approved: true }); }
      catch (error) { broken = true; throw error; }
    },
    recover: threadId => recoverCodexImage(lease.value.rpc, threadId),
    close: () => lease.release(broken, conversation),
  };
}

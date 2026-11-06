import db from "../../db";
import { readDraft, draftDir } from "./script-drafts";
import { getRunDir } from "../../run-paths";
import { readLtxSceneRequest } from "./pipeline";

export async function resolveLtxTarget(runId: string, index: number, fingerprint: string) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(runId) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Cena inválida.");
  if (runId.startsWith("script-")) {
    await readDraft(runId);
    const runDir = draftDir(runId), request = await readLtxSceneRequest(runDir, index);
    if (request.fingerprint !== fingerprint) throw new Error("A cena mudou. Atualize a lista.");
    return { runId, runDir, request };
  }
  const run = db.prepare("SELECT id FROM runs WHERE id = ? AND deleted_at IS NULL").get(runId);
  if (!run) throw new Error("Vídeo não encontrado.");
  const runDir = getRunDir(runId);
  const request = await readLtxSceneRequest(runDir, index);
  if (request.fingerprint !== fingerprint) throw new Error("A cena mudou. Atualize a lista.");
  return { runId, runDir, request };
}

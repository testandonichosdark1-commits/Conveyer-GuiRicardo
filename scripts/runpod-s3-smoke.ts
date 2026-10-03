/**
 * Runpod network-volume S3 smoke test — steps A, B, C, E, F of workers/ltx/DEPLOYMENT.md §9.
 * (Step D, seeing the file at /runpod-volume/<path> from inside a worker, needs an endpoint.)
 *
 * NOT run by any test or by the app. It makes REAL requests against the volume configured in
 * Settings (RUNPOD_NETWORK_VOLUME_ID / RUNPOD_S3_*), so it refuses to do anything without
 * --confirm:
 *
 *   npx tsx scripts/runpod-s3-smoke.ts --confirm
 *
 * Uses the dev data dir like the server does; set FACELESS_STUDIO_DATA_DIR to point elsewhere.
 * Writes and then deletes ONE small object under conveyer/smoke/, and never prints a credential.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  uploadRunpodAsset,
  headRunpodAsset,
  downloadRunpodAsset,
  deleteRunpodAsset,
  readRunpodS3Config,
  RunpodAssetError,
} from "../src/lib/services/runpod-asset-store";

async function main(): Promise<number> {
  if (!process.argv.includes("--confirm")) {
    console.error("Refusing to run: this makes real requests to the Runpod S3 API. Re-run with --confirm.");
    return 2;
  }
  const cfg = readRunpodS3Config();
  console.log(`volume ${cfg.volumeId} @ ${cfg.endpoint} (${cfg.region})`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "runpod-s3-smoke-"));
  const remote = `conveyer/smoke/s3-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}.bin`;
  try {
    // A — a small local file with known content.
    const local = path.join(work, "payload.bin");
    fs.writeFileSync(local, crypto.randomBytes(256 * 1024));
    const want = crypto.createHash("sha256").update(fs.readFileSync(local)).digest("hex");

    // B — upload (PutObject, then HeadObject confirms the size).
    const up = await uploadRunpodAsset(local, remote);
    console.log(`B upload   ${up.path} ${up.bytes} B sha256=${up.sha256}`);

    // C — head.
    const head = await headRunpodAsset(remote);
    console.log(`C head     exists=${head.exists} bytes=${head.bytes}`);
    if (!head.exists || head.bytes !== up.bytes) throw new Error("HeadObject disagrees with the upload");

    // E — download, verified against the upload's size and hash.
    const back = await downloadRunpodAsset(remote, path.join(work, "back.bin"), { expectedBytes: up.bytes, expectedSha256: up.sha256 });
    console.log(`E download ${back.bytes} B sha256=${back.sha256}`);

    // F — compare with the local original.
    if (back.sha256 !== want || up.sha256 !== want) throw new Error("SHA-256 mismatch");
    console.log("F sha256   identical — path-style addressing, auth, region, bucket and read-after-write OK");
    console.log(`D (manual, needs an endpoint): the worker should see /runpod-volume/${remote} before cleanup`);
    return 0;
  } catch (e) {
    console.error(e instanceof RunpodAssetError ? `${e.op} ${e.code}: ${e.message}` : (e as Error).message);
    return 1;
  } finally {
    await deleteRunpodAsset(remote).catch(() => undefined);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code));

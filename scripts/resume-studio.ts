/**
 * Resume an interrupted studio run from the command line (crash / server-restart
 * recovery). Reuses the on-disk voiceover + beats.json + every beat clip already
 * rendered, regenerates ONLY the missing/corrupt beats, then reassembles the final
 * video. Already-paid HeyGen/AI clips are never re-billed.
 *
 *   npm run resume:studio -- <runId | folderName>
 *
 * Runs directly against the local SQLite DB + FFmpeg + provider keys (read from the
 * DB), so it works without the web server. Point it at the SAME data dir the server
 * uses — if the server sets FACELESS_STUDIO_DATA_DIR, export it here too, e.g.
 *   FACELESS_STUDIO_DATA_DIR=/root/.faceless-studio npm run resume:studio -- <id>
 */
import db from "../src/lib/db";
import { resumeStudioPipeline, canResumeStudioRun, getRunMode } from "../src/lib/studio-pipeline";

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: npm run resume:studio -- <runId | folderName>");
    return 1;
  }

  const row = db
    .prepare("SELECT id, folder_name, status FROM runs WHERE id = ? OR folder_name = ?")
    .get(arg, arg) as { id: string; folder_name: string; status: string } | undefined;

  if (!row) {
    console.error(`No run found matching "${arg}". Pass a run id or its folder name.`);
    return 1;
  }
  if (getRunMode(row.id) !== "studio") {
    console.error(`Run ${row.id} ("${row.folder_name}") is not a studio run — nothing to resume here.`);
    return 1;
  }
  if (!canResumeStudioRun(row.id)) {
    console.error(
      `Run ${row.id} ("${row.folder_name}") can't be resumed — audio/voiceover.mp3 or beats.json is missing on disk. Start a fresh run.`
    );
    return 1;
  }

  console.log(`Resuming studio run ${row.id} ("${row.folder_name}", status=${row.status})…`);
  console.log("Reused/regenerated beat counts + progress stream to the run's logs (open the run page).");
  await resumeStudioPipeline(row.id);

  const after = db.prepare("SELECT status, output_path FROM runs WHERE id = ?").get(row.id) as {
    status: string;
    output_path: string | null;
  };
  console.log(`Finished. status=${after.status}${after.output_path ? ` → ${after.output_path}` : ""}`);
  return after.status === "done" ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

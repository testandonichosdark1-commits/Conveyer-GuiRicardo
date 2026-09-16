/**
 * Extract the planner's REAL per-beat visual queries from a script — without paying for
 * narration.
 *
 * `planBeats` only ever sees `WordTiming[]`, so the voiceover can be skipped entirely:
 * this feeds it proportional timings at a fixed speaking rate and takes the queries
 * Gemini writes back. Cost is one Gemini call; no ElevenLabs, no HeyGen, no run row.
 *
 * The one thing this deliberately approximates is beat BOUNDARIES: real speech rhythm
 * groups words slightly differently than a constant rate does, so a beat may carry one
 * word more or less than it would in a paid run. Beat TEXT is sentence-aware either way,
 * which is what the query is written from — so the queries are production-shaped, and the
 * comparison they feed is fair. They are not a substitute for a real run's plan.
 *
 * Usage:
 *   FACELESS_STUDIO_DATA_DIR=~/.faceless-studio-wigolo \
 *     npx tsx scripts/wigolo-plan-queries.ts script.txt --out queries.txt [--jsonl]
 *
 * `--jsonl` writes one JSON object per beat instead of a bare query line, carrying the
 * planner's own classification (`query_type`, `footage_kind`) and the beat text alongside
 * the query. Those fields are what the entity/surrender gates should be reading instead of
 * guessing from the query string, so a fixture without them cannot measure that change.
 * The bake-off accepts both formats, so existing queries.txt files keep working.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { planBeats } from "../src/lib/services/studio-plan";
import type { WordTiming } from "../src/lib/services/elevenlabs-voiceover";
import { getSetting } from "../src/lib/settings";

/** ~150 wpm — a documentary narration pace, and the rate the beat lengths below assume. */
const MS_PER_WORD = 400;

function proportionalWords(script: string): WordTiming[] {
  return script
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => ({ word, startMs: i * MS_PER_WORD, endMs: (i + 1) * MS_PER_WORD }));
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: wigolo-plan-queries.ts <script.txt> [--out queries.txt]");
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx > 0 ? process.argv[outIdx + 1] : null;
  const jsonl = process.argv.includes("--jsonl");

  const words = proportionalWords(readFileSync(file, "utf8"));
  const runId = "bakeoff-plan";

  // Production values, read from the same DB the app reads — a plan built with benchmark
  // defaults would compare providers on beats the pipeline would never actually ask for.
  const beats = await planBeats(words, {
    secondsPerVisual: Number(getSetting("SECONDS_PER_VISUAL") || "4.5"),
    avatarPercent: Number(getSetting("AVATAR_FREQUENCY_PERCENT") || "15"),
    realPercent: Number(getSetting("REAL_RATIO_PERCENT") || "80"),
    hasAvatar: true,
    runId,
  });

  console.log(`\nscript: ${words.length} words ≈ ${((words.length * MS_PER_WORD) / 1000).toFixed(1)}s`);
  console.log(`beats:  ${beats.length}\n`);

  const queries: string[] = [];
  for (const b of beats) {
    const dur = ((b.endMs - b.startMs) / 1000).toFixed(1);
    console.log(
      `#${String(b.index).padStart(2)} ${String(b.layout).padEnd(6)} ${String(b.source ?? "-").padEnd(5)} ${dur.padStart(4)}s  ${b.visualQuery || "(no query)"}`
    );
    console.log(`      “${b.text.slice(0, 100)}${b.text.length > 100 ? "…" : ""}”`);
    // Avatar-only beats are the presenter talking; they never hit a footage provider,
    // so including them would pad the bake-off with queries no source is ever asked.
    if (b.layout === "avatar" || !b.visualQuery) continue;
    queries.push(
      jsonl
        ? JSON.stringify({ query: b.visualQuery, text: b.text, query_type: b.queryType, footage_kind: b.footageKind })
        : b.visualQuery
    );
  }

  if (outPath) {
    writeFileSync(outPath, queries.join("\n") + "\n");
    console.log(`\nwrote ${queries.length} b-roll queries → ${outPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * wigolo bake-off — provider-level comparison, no video rendered and nothing billed.
 *
 * Answers the only question that has to be settled before a full A/B run: for the SAME
 * beat query, which source returns candidates that are (a) there at all, (b) actually
 * downloadable, (c) big enough to fill a frame, and (d) fast.
 *
 * It stops short of judging whether a picture MATCHES the beat — that is the vision
 * scorer's job and it costs Gemini calls. What this measures is the pool the scorer gets
 * to choose from, which is upstream of every quality difference the scorer could produce.
 *
 * Usage:
 *   FACELESS_STUDIO_DATA_DIR=~/.faceless-studio-wigolo \
 *     npx tsx scripts/wigolo-bakeoff.ts queries.txt [--out report.json]
 *                                                   [--capture pools.json] [--no-verify]
 *     npx tsx scripts/wigolo-bakeoff.ts --pools pools.json [--baseline base.json] [--out r.json]
 *
 * `queries.txt` is one visual query per line — feed it the planner's real per-beat
 * queries from an existing run so the comparison is on production-shaped input, not
 * on queries invented for the benchmark. `wigolo-plan-queries.ts --jsonl` additionally
 * emits the planner's own fields per beat, and those lines are accepted here too.
 *
 * ── Capture / replay ───────────────────────────────────────────────────────────────
 * Providers are live services: run the same queries twice and the pools differ, so a
 * before/after comparison of a CODE change drowns in their noise. `--capture` writes the
 * raw pools alongside the report; `--pools` replays them with the network untouched. One
 * live capture, then every subsequent measurement is a pure function of the code — which
 * is the only way the selection stages can be graded honestly.
 *
 * `--baseline` diffs this run's selection metrics against a previously written report,
 * printing before/after for AI-routing share, provider mix, video/photo ratio and Gemini
 * spend. See scripts/pool-metrics.ts for what those numbers do and do not mean.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { __testing, type ProviderHit } from "../src/lib/services/visual-source";
import { measure, formatMetrics, type CapturedQuery, type Metrics } from "./pool-metrics";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Providers to compare. Sources needing an unset key return [] and show up as a zero row —
 *  which is itself a finding, so they are NOT filtered out of the report. */
const ARMS = ["pexels", "pixabay", "openverse", "wikimedia", "archive", "web", "wigolo"];

/** How many of a provider's hits get the (expensive) reachability check. The pool the
 *  scorer sees is capped per provider anyway, so checking beyond that measures nothing. */
const VERIFY_TOP = 5;

interface Row {
  provider: string;
  query: string;
  ms: number;
  hits: number;
  videos: number;
  images: number;
  reachable: number;
  checked: number;
  bytesTotal: number;
  error?: string;
  /** Kept in memory for the gate analysis below; stripped from the JSON report. */
  pool: ProviderHit[];
}

/**
 * A hit counts as usable only if the URL really serves media. Ranking a candidate that
 * 403s on download is worse than returning nothing: it occupies a slot in the pool, the
 * beat then falls through to broaden/AI, and the run pays for the detour.
 */
async function reachable(url: string): Promise<{ ok: boolean; bytes: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) return { ok: false, bytes: 0 };
    const type = r.headers.get("content-type") ?? "";
    const buf = await r.arrayBuffer();
    // A hotlink block often answers 200 with an HTML "denied" page, so the content type
    // is the real gate, not the status code.
    return { ok: /^(image|video)\//.test(type) && buf.byteLength > 10_000, bytes: buf.byteLength };
  } catch {
    return { ok: false, bytes: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** One line of the fixture: a bare query, or a JSONL object carrying the planner's fields. */
function parseQueryLine(line: string): { query: string; text?: string; queryType?: string; footageKind?: string } {
  if (!line.startsWith("{")) return { query: line };
  const o = JSON.parse(line) as Record<string, string>;
  return { query: o.query, text: o.text, queryType: o.query_type, footageKind: o.footage_kind };
}

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] ?? null : null;
}

async function main(): Promise<void> {
  const outPath = flag("--out");
  const capturePath = flag("--capture");
  const poolsPath = flag("--pools");
  const baselinePath = flag("--baseline");
  // The queries file is the first argument that isn't a flag or a flag's value.
  // Reachability answers "does this URL really serve media", which is a PROVIDER question.
  // The selection metrics below need only the candidate pools, and the check downloads each
  // candidate in FULL — 5 per provider per query, videos included — so it costs the entire
  // bandwidth of a capture run for nothing when that is all you are measuring.
  const noVerify = process.argv.includes("--no-verify");
  const flagged = new Set(["--out", "--capture", "--pools", "--baseline"]);
  const file = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !flagged.has(all[i - 1] ?? ""));
  if (!file && !poolsPath) {
    throw new Error("usage: wigolo-bakeoff.ts <queries.txt> [--out r.json] [--capture pools.json]\n" +
      "       wigolo-bakeoff.ts --pools pools.json [--baseline base.json] [--out r.json]");
  }

  let rows: Row[];
  let planned: ReturnType<typeof parseQueryLine>[];

  if (poolsPath) {
    // Replay: the pools were captured once, live. Nothing here touches the network, so any
    // difference against a baseline is attributable to the code and to nothing else.
    const captured = JSON.parse(readFileSync(poolsPath, "utf8")) as { rows: Row[]; planned?: ReturnType<typeof parseQueryLine>[] };
    // Re-tag on the way in as well: a capture may predate the tagging above, or have been
    // hand-written as a fixture. Untagged hits would grade as weight 0 across the board.
    rows = captured.rows.map((r) => ({ ...r, pool: (r.pool ?? []).map((h) => ({ ...h, provider: r.provider })) }));
    planned = captured.planned ?? [...new Set(rows.map((r) => r.query))].map((query) => ({ query }));
    console.log(`replaying ${rows.length} captured rows over ${planned.length} queries (no network)\n`);
  } else {
    planned = readFileSync(file!, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"))
      .map(parseQueryLine);
    rows = [];
    for (const { query } of planned) {
      for (const provider of ARMS) {
        const fn = __testing.PROVIDERS[provider];
        if (!fn) continue;
        const t0 = Date.now();
        let hits: ProviderHit[] = [];
        let error: string | undefined;
        try {
          // 8s is the beat length the planner targets; passing it makes video providers
          // prefer clips that cover a whole beat, exactly as they do in a real run.
          hits = await fn(query, "bakeoff", 8);
        } catch (e) {
          error = (e as Error).message.slice(0, 120);
        }
        const ms = Date.now() - t0;

        const checks = noVerify ? [] : await Promise.all(hits.slice(0, VERIFY_TOP).map((h) => reachable(h.url)));
        rows.push({
          provider,
          query,
          ms,
          hits: hits.length,
          videos: hits.filter((h) => h.kind === "video").length,
          images: hits.filter((h) => h.kind === "image").length,
          reachable: checks.filter((c) => c.ok).length,
          checked: checks.length,
          bytesTotal: checks.reduce((n, c) => n + c.bytes, 0),
          error,
          // Tag with the provider, exactly as gatherCandidates does before it merges. The
          // adapters themselves return hits UNTAGGED, so without this every weight lookup
          // below falls to `?? 0` and poolIsWeak grades an archive still like a pexels one —
          // which silently under-reports the very gate this script exists to count.
          pool: hits.map((h) => ({ ...h, provider })),
        });
        process.stdout.write(
          `${query.slice(0, 38).padEnd(38)} ${provider.padEnd(10)} ${String(ms).padStart(6)}ms  ` +
            `hits=${String(hits.length).padStart(3)}  ok=${checks.filter((c) => c.ok).length}/${checks.length}` +
            `${error ? `  ERR ${error}` : ""}\n`
        );
      }
    }
    if (capturePath) {
      writeFileSync(capturePath, JSON.stringify({ rows, planned }, null, 2));
      console.log(`\ncaptured pools → ${capturePath}`);
    }
  }

  const queries = planned.map((p) => p.query);

  // ── The gate that decides whether a beat abandons stock and goes to paid AI ──────────
  //
  // acquireReal gives up on the first attempt when the query names no entity AND the pool is
  // "weak" (no video, and no candidate scoring above zero). That gate — not the raw candidate
  // count — is what actually turns into AI spend, so the useful question about wigolo is
  // whether it changes the verdict, and the honest way to ask is to run the real predicate
  // over the real pools rather than to re-derive its rule here.
  console.log("\n=== route-to-AI gate (poolIsWeak) ===");
  let gateFiredWithout = 0;
  let gateFiredWith = 0;
  let entityQueries = 0;
  for (const query of queries) {
    const named = __testing.hasLikelyEntity(query);
    if (named) {
      entityQueries++;
      continue; // the gate never fires for these
    }
    const mine = rows.filter((r) => r.query === query);
    const without = mine.filter((r) => r.provider !== "wigolo").flatMap((r) => r.pool);
    const withWigolo = mine.flatMap((r) => r.pool);
    const a = __testing.poolIsWeak(without);
    const b = __testing.poolIsWeak(withWigolo);
    if (a) gateFiredWithout++;
    if (b) gateFiredWith++;
    console.log(`  ${a ? "AI " : "keep"} → ${b ? "AI " : "keep"}  ${query.slice(0, 60)}`);
  }
  console.log(
    `  gate fires: ${gateFiredWithout}/${queries.length - entityQueries} without wigolo, ` +
      `${gateFiredWith}/${queries.length - entityQueries} with it ` +
      `(${entityQueries} entity queries are exempt)`
  );

  console.log("\n=== per provider, across all queries ===");
  for (const provider of ARMS) {
    const mine = rows.filter((r) => r.provider === provider);
    if (!mine.length) continue;
    const checked = mine.reduce((n, r) => n + r.checked, 0);
    const ok = mine.reduce((n, r) => n + r.reachable, 0);
    // "Dry" queries are the number that matters most: a source that returns nothing for a
    // beat forces broaden/AI, whatever its average hit count looks like.
    const dry = mine.filter((r) => r.hits === 0).length;
    console.log(
      `${provider.padEnd(10)} hits/query ${(mine.reduce((n, r) => n + r.hits, 0) / mine.length).toFixed(1).padStart(5)}  ` +
        `dry ${String(dry).padStart(2)}/${mine.length}  ` +
        // "—" rather than "0%" when nothing was checked: a zero here reads as "nothing works".
        `reachable ${checked ? `${Math.round((ok / checked) * 100)}%` : "—"}  ` +
        `median ${mine.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(mine.length / 2)]}ms  ` +
        `video/img ${mine.reduce((n, r) => n + r.videos, 0)}/${mine.reduce((n, r) => n + r.images, 0)}`
    );
  }

  // ── Selection metrics: what the scorer is handed, and what it costs ─────────────────
  //
  // Everything above measures the providers. This measures OUR code — the slot allocation,
  // the 14 → 10 cut and the surrender gates — by replaying the captured pools through the
  // real internals. Read the deltas against --baseline, not the absolute levels; see
  // scripts/pool-metrics.ts for why.
  const byQuery = new Map<string, CapturedQuery>();
  for (const p of planned) byQuery.set(p.query, { ...p, lists: {} });
  for (const r of rows) {
    const q = byQuery.get(r.query);
    if (q) q.lists[r.provider] = r.pool ?? [];
  }
  const { metrics } = measure([...byQuery.values()]);

  let baseline: Metrics | undefined;
  if (baselinePath) {
    const prev = JSON.parse(readFileSync(baselinePath, "utf8")) as { metrics?: Metrics };
    if (!prev.metrics) throw new Error(`${baselinePath} has no metrics block — regenerate it with --out`);
    baseline = prev.metrics;
  }
  console.log("\n=== selection metrics (attempt 0, lexical stand-in scorer) ===");
  console.log(formatMetrics(metrics, baseline));

  if (outPath) {
    // Candidate lists are dropped here — they are only needed for the analysis above, and
    // keeping them would bloat the report by orders of magnitude. Use --capture for those.
    writeFileSync(outPath, JSON.stringify({ rows: rows.map(({ pool: _pool, ...r }) => r), metrics }, null, 2));
    console.log(`\nwrote ${outPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

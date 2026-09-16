import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Key-free INTEGRATION test for the cost ledger — exercises the real chain
 *   record*()  ->  run_costs (SQLite)  ->  aggregateCostsByRun()  ->  totals
 * that /api/costs sums for the overview. Runs against a throwaway DB (via
 * FACELESS_STUDIO_DATA_DIR) so it touches no real data and needs no API keys.
 * Modules that open the DB are dynamic-imported in beforeAll, AFTER the env var
 * is set, so db.ts points at the temp dir.
 */
let ledger!: typeof import("./services/cost-ledger");
const RUN = "cost-it-run-1";

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-ledger-it-"));
  process.env.FACELESS_STUDIO_DATA_DIR = dir;

  const { ensureInit } = await import("./init");
  ensureInit(); // creates the schema (incl. run_costs) + seeds default settings

  const { setSetting } = await import("./settings");
  // Deterministic rates with FX=1 (EUR == USD) so the arithmetic is exact.
  setSetting("COST_USD_TO_EUR", "1");
  setSetting("COST_ELEVENLABS_TIER", "Custom");
  setSetting("COST_ELEVENLABS_USD_PER_1K_CHARS", "0.22");
  setSetting("COST_GEMINI_IN_USD_PER_1M", "0.30"); // geminiText (planner) rate
  setSetting("COST_GEMINI_OUT_USD_PER_1M", "2.50");
  setSetting("COST_GEMINI_LITE_IN_USD_PER_1M", "0.25"); // geminiVision (flash-lite) rate
  setSetting("COST_GEMINI_LITE_OUT_USD_PER_1M", "1.50");
  setSetting("COST_KIE_IMAGE_USD", "0.02");
  setSetting("COST_KIE_VEO_USD_PER_SEC", "0.40");
  setSetting("COST_HEYGEN_USD_PER_MIN", "1.90");
  setSetting("COST_LABS69_USD_PER_VIDEO", "0.50");
  setSetting("COST_GROQ_USD_PER_AUDIO_HOUR", "3.60"); // = $0.001/audio-sec → easy arithmetic

  ledger = await import("./services/cost-ledger");
});

describe("cost ledger integration", () => {
  it("records every provider and aggregates per-run buckets + total", () => {
    ledger.recordElevenlabs(RUN, 1000); // 1000/1000 × 0.22            = 0.22
    ledger.recordGemini(RUN, "geminiText", 1_000_000, 0, "gemini-3.5-flash"); // 1M in × 0.30 = 0.30
    ledger.recordGemini(RUN, "geminiVision", 0, 1_000_000, "gemini-3.1-flash-lite"); // 1M out × LITE 1.50 = 1.50
    ledger.recordKieImage(RUN, 3); // 3 × 0.02                          = 0.06
    ledger.recordKieVeo(RUN, 5); // 5 × 0.40                            = 2.00
    ledger.recordHeygen(RUN, 60); // 60s/60 × 1.90                      = 1.90
    ledger.recordLabs69(RUN, 2); // 2 × 0.50                            = 1.00

    const b = ledger.aggregateCostsByRun().get(RUN);
    expect(b).toBeDefined();
    expect(b!.elevenlabs).toBeCloseTo(0.22, 6);
    expect(b!.geminiText).toBeCloseTo(0.3, 6);
    expect(b!.geminiVision).toBeCloseTo(1.5, 6);
    // aiProviders bucket = kie image + kie veo + heygen + 69labs
    expect(b!.aiProviders).toBeCloseTo(0.06 + 2.0 + 1.9 + 1.0, 6); // 4.96
    expect(b!.total).toBeCloseTo(0.22 + 0.3 + 1.5 + 4.96, 6); // 6.98
  });

  it("overview total = sum of every run's total (the /api/costs computation)", () => {
    const RUN2 = "cost-it-run-2";
    ledger.recordHeygen(RUN2, 30); // 30s/60 × 1.90 = 0.95

    const agg = ledger.aggregateCostsByRun();
    expect(agg.get(RUN2)!.total).toBeCloseTo(0.95, 6);
    expect(agg.get(RUN)!.total).toBeCloseTo(6.98, 6); // prior run unaffected

    const overviewTotal = [...agg.values()].reduce((s, x) => s + x.total, 0);
    expect(overviewTotal).toBeCloseTo(6.98 + 0.95, 6); // 7.93
  });

  it("69labs honors its configured rate (regression: was hardcoded €0)", () => {
    const RUN3 = "cost-it-run-3";
    ledger.recordLabs69(RUN3, 4); // 4 × 0.50 = 2.00
    expect(ledger.aggregateCostsByRun().get(RUN3)!.aiProviders).toBeCloseTo(2.0, 6);
  });

  // Groq Whisper transcription — previously unmetered entirely, so every non-ElevenLabs
  // voiceover under-reported its true spend. It must land in aiProviders (real pay-as-you-go
  // money), NOT the elevenlabs bucket, which the Costs page treats as amortized subscription
  // usage and never sums as spend.
  it("Groq transcription is metered into aiProviders, not the ElevenLabs bucket", () => {
    const RUN4 = "cost-it-run-4";
    ledger.recordGroqTranscription(RUN4, 125); // 125 audio-sec × $0.001 = 0.125
    const b = ledger.aggregateCostsByRun().get(RUN4)!;
    expect(b.aiProviders).toBeCloseTo(0.125, 6);
    expect(b.elevenlabs).toBe(0);
    expect(b.total).toBeCloseTo(0.125, 6);
  });

  // The upload-voiceover mode (and today's 69labs/MiniMax/GenAIPro runs) buy NO TTS, so the
  // ElevenLabs bucket must stay empty while transcription is still charged. This is the
  // invariant that keeps an audio-sourced run's cost honest.
  it("a transcription-only run reports Groq spend with zero TTS cost", () => {
    const RUN5 = "cost-it-run-5";
    ledger.recordGroqTranscription(RUN5, 60); // 60 × 0.001 = 0.06
    ledger.recordHeygen(RUN5, 60); // 60s/60 × 1.90 = 1.90
    const b = ledger.aggregateCostsByRun().get(RUN5)!;
    expect(b.elevenlabs).toBe(0);
    expect(b.aiProviders).toBeCloseTo(0.06 + 1.9, 6);
  });
});

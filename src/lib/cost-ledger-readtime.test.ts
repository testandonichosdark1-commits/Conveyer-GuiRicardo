import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * INTEGRATION test for read-time pricing through the real SQLite chain:
 *   record*()  ->  run_costs  ->  spendByRunProvider()/spendByProvider()
 *
 * The aggregates sum UNITS and price them on read, so the thing most worth pinning
 * is that a GROUP never mixes rows that price differently. If it did, one bucket's
 * rate would silently be applied to another's rows and the error would be invisible.
 *
 * Throwaway DB via FACELESS_STUDIO_DATA_DIR — touches no real data, needs no keys.
 */
let ledger!: typeof import("./services/cost-ledger");
let settings!: typeof import("./settings");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-readtime-it-"));
  process.env.FACELESS_STUDIO_DATA_DIR = dir;
  const { ensureInit } = await import("./init");
  ensureInit();
  settings = await import("./settings");
  settings.setSetting("COST_USD_TO_EUR", "1"); // EUR == USD so the arithmetic is exact
  ledger = await import("./services/cost-ledger");
});

const runTotal = (runId: string) =>
  ledger
    .spendByRunProvider()
    .filter((r) => r.runId === runId)
    .reduce((s, r) => s + r.amountEur, 0);

describe("a rate correction reaches already-recorded spend", () => {
  it("reprices historical rows instead of leaving them at the rate they were written with", () => {
    const RUN = "reprice-run";
    settings.setSetting("COST_LABS69_USD_PER_VIDEO", "0"); // unset, as it ships
    for (let i = 0; i < 5; i++) ledger.recordLabs69(RUN);

    // As things stood before: recorded at rate 0, and permanently stuck there.
    expect(runTotal(RUN)).toBeCloseTo(0, 6);

    settings.setSetting("COST_LABS69_USD_PER_VIDEO", "0.15");
    expect(runTotal(RUN)).toBeCloseTo(0.75, 6); // 5 × $0.15, retroactively

    settings.setSetting("COST_USD_TO_EUR", "0.5"); // the FX rate restates it too
    expect(runTotal(RUN)).toBeCloseTo(0.375, 6);
    settings.setSetting("COST_USD_TO_EUR", "1");
  });

  it("reports an unset rate as unknown rather than as €0.00 of spend", () => {
    const RUN = "unpriced-run";
    settings.setSetting("COST_MAGNIFIC_VIDEO_USD_PER_SEC", "0");
    ledger.recordMagnificVideo(RUN, 6);
    const row = ledger.spendByRunProvider().find((r) => r.runId === RUN)!;
    expect(row.amountEur).toBe(0);
    expect(row.rateKnown).toBe(false); // → the page says "rate not set", not "free"
    expect(row.units).toBe(6); // usage is recorded regardless
  });
});

describe("aggregation groups never mix rows that price differently", () => {
  it("keeps a provider's engines apart, since their rates differ 4x", () => {
    // Everything below lands on provider "heygen"; only rate_kind separates them.
    const RUN = "heygen-run";
    settings.setSetting("COST_HEYGEN_USD_PER_MIN", "3.00");
    settings.setSetting("COST_HEYGEN_UNLIMITED_USD_PER_MIN", "1.00");
    settings.setSetting("COST_HEYGEN_AVATAR_V_USD_PER_MIN", "4.00");
    ledger.recordHeygenEngine(RUN, 60, "avatar_iv");
    ledger.recordHeygenEngine(RUN, 60, "unlimited");
    ledger.recordHeygenEngine(RUN, 60, "avatar_v");

    const kinds = ledger
      .spendByRunProvider()
      .filter((r) => r.runId === RUN)
      .map((r) => [r.rateKind, Number(r.amountEur.toFixed(4))])
      .sort();
    expect(kinds).toEqual([
      ["heygen:avatar_iv", 3],
      ["heygen:avatar_v", 4],
      ["heygen:unlimited", 1],
    ]);
  });

  it("does not let a 0-rate estimate overwrite a provider-reported amount", () => {
    // Runware reports what it really billed. Grouping it with an estimated row would
    // apply the (default 0) fallback rate to real money.
    const RUN = "runware-run";
    settings.setSetting("COST_RUNWARE_IMAGE_USD", "0");
    ledger.recordRunwareImage(RUN, 0.13, "google:4@2"); // real cost reported
    ledger.recordRunwareImage(RUN, null, "google:4@2"); // no cost reported

    const rows = ledger.spendByRunProvider().filter((r) => r.runId === RUN);
    expect(rows.length).toBe(2); // split, not merged
    expect(rows.find((r) => r.real)?.amountEur).toBeCloseTo(0.13, 6);
    expect(rows.find((r) => !r.real)?.amountEur).toBe(0);
    expect(runTotal(RUN)).toBeCloseTo(0.13, 6);
  });

  it("prices Gemini by the model that ran, not by the caller's role", () => {
    const RUN = "gemini-run";
    settings.setSetting("COST_GEMINI_IN_USD_PER_1M", "1.50");
    settings.setSetting("COST_GEMINI_OUT_USD_PER_1M", "9.00");
    settings.setSetting("COST_GEMINI_LITE_IN_USD_PER_1M", "0.25");
    settings.setSetting("COST_GEMINI_LITE_OUT_USD_PER_1M", "1.50");
    // A PLANNER call ("geminiText") running on a LITE model. The old rule read the
    // category and billed this at the standard rate — ~6x too much.
    ledger.recordGemini(RUN, "geminiText", 1_000_000, 0, "gemini-3.1-flash-lite");
    const row = ledger.spendByRunProvider().find((r) => r.runId === RUN)!;
    expect(row.rateKind).toBe("gemini:lite");
    expect(row.amountEur).toBeCloseTo(0.25, 6);
  });

  it("bills a 69labs still at the image rate, not the video rate", () => {
    const RUN = "labs69-split-run";
    settings.setSetting("COST_LABS69_USD_PER_VIDEO", "0.15");
    settings.setSetting("COST_LABS69_IMAGE_USD", "0.02");
    ledger.recordLabs69(RUN);
    ledger.recordLabs69Image(RUN);
    const rows = ledger.spendByRunProvider().filter((r) => r.runId === RUN);
    expect(rows.find((r) => r.rateKind === "69labs:video")?.amountEur).toBeCloseTo(0.15, 6);
    expect(rows.find((r) => r.rateKind === "69labs:image")?.amountEur).toBeCloseTo(0.02, 6);
  });
});

describe("previously unmetered providers now reach the ledger", () => {
  it("records the TTS providers that used to spend silently", () => {
    const RUN = "tts-run";
    settings.setSetting("COST_HEYGEN_TTS_USD_PER_1K_CHARS", "0.30");
    ledger.recordTtsChars(RUN, 2000, "heygen:tts");
    ledger.recordStoryblocksDownload(RUN);
    ledger.recordGoogleCseQuery(RUN);
    const kinds = ledger.spendByRunProvider().filter((r) => r.runId === RUN).map((r) => r.rateKind).sort();
    expect(kinds).toEqual(["googlecse:query", "heygen:tts", "storyblocks:download"]);
    expect(runTotal(RUN)).toBeCloseTo(0.6, 6); // 2k chars × $0.30/1k; the other two rate-less
  });
});

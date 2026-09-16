import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { getKeyCount } from "@/lib/services/labs69";

/**
 * Returns runtime stats used by the UI for estimate widgets:
 *   - how many 69labs keys are configured
 *   - effective per-key + total concurrency for each stage
 *   - animation distribution settings
 *
 * Does NOT expose key values themselves — only the count.
 */
export async function GET() {
  ensureInit();
  const keyCount = getKeyCount();
  const imageConcurrencyPerKey = Math.max(1, Number(getSetting("IMAGE_CONCURRENCY") || "5"));
  const ttsConcurrencyPerKey = Math.max(1, Number(getSetting("TTS_CONCURRENCY") || "3"));
  const animConcurrencyPerKey = Math.max(1, Number(getSetting("ANIMATION_CONCURRENCY") || "3"));
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const xfadeChunks = Math.max(1, Number(getSetting("ASSEMBLE_XFADE_CHUNKS") || "4"));
  const animationProvider = (getSetting("ANIMATION_PROVIDER") || "off").toLowerCase();
  const animationRatio = Math.max(0, Math.min(100, Number(getSetting("ANIMATION_RATIO_PERCENT") || "50")));

  // Surface the "active stack" so the New Run page can show at a glance
  // which providers/models the next run will actually use — operator should
  // never have to guess what's wired up.
  const ttsProvider = (getSetting("TTS_PROVIDER") || "heygen").toLowerCase();
  const ttsMode = (getSetting("TTS_MODE") || "per-scene").toLowerCase();
  const animationModel = getSetting("ANIMATION_MODEL") || "";
  const minimaxModel = getSetting("MINIMAX_MODEL") || "";
  const autoReuseEnabled = getSetting("AUTO_REUSE_ENABLED") === "1";
  const stockRatioPercent = Math.max(0, Math.min(100, Number(getSetting("STOCK_RATIO_PERCENT") || "0")));

  return NextResponse.json({
    keyCount,
    perKey: {
      image: imageConcurrencyPerKey,
      tts: ttsConcurrencyPerKey,
      anim: animConcurrencyPerKey,
    },
    total: {
      image: imageConcurrencyPerKey * Math.max(1, keyCount),
      tts: ttsConcurrencyPerKey * Math.max(1, keyCount),
      anim: animConcurrencyPerKey * Math.max(1, keyCount),
    },
    assembleConcurrency,
    xfadeChunks,
    animationEnabled: animationProvider !== "off",
    animationRatio,
    activeStack: {
      ttsProvider,
      ttsMode,
      animationProvider,
      animationModel,
      minimaxModel,
      autoReuseEnabled,
      stockRatioPercent,
    },
  });
}

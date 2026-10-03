import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { resolveFfmpeg, isTransientSpawnFailure } from "../ffmpeg-bin";
import { runComfyWorkflow, downloadComfyOutput, LocalGpuError } from "./comfyui-client";

/**
 * LTX-Video 2B distilled, run through a local ComfyUI instance — the AI b-roll VIDEO
 * backend for AI_PROVIDER=local. Chosen specifically because it's the only LTX tier
 * that fits an 8GB consumer GPU (the newer LTX-2 line needs 12-32GB); "distilled" also
 * means it needs as few as ~8 sampling steps instead of the base model's ~30+, which
 * matters on a GPU this small.
 *
 * The workflow (buildWorkflow below) is the official ComfyUI example graph for LTXV
 * text-to-video (comfyanonymous/ComfyUI_examples, ltxv/ltxv_text_to_video.json),
 * converted from its UI node-graph shape into the API shape POST /prompt expects, with
 * the checkpoint filename swapped for the distilled tier and width/height/length made
 * dynamic. NOT YET VALIDATED against a live ComfyUI run (blocked on Windows Smart App
 * Control preventing the local ComfyUI server from starting at all) — the node graph
 * itself is copied verbatim from Lightricks' own example, not invented, but the first
 * real run is still the thing that proves it end to end. If a run fails with
 * LocalGpuError code "node_missing", the ComfyUI checkout is missing LTXVConditioning/
 * EmptyLTXVLatentVideo/LTXVScheduler — these ship in ComfyUI core as of the version
 * cloned by setup-comfyui.ps1, not a separate custom node install.
 *
 * Output: the workflow's SaveAnimatedWEBP node (no custom video-combine node needed —
 * it ships in ComfyUI core, unlike VHS_VideoCombine which would be one more custom node
 * to install and that could fail). The downloaded animated WEBP is converted to MP4
 * locally via ffmpeg, the same binary every other provider in this app already uses.
 */

const LTX_CHECKPOINT = "ltxv-2b-0.9.6-distilled-04-25.safetensors";
const T5_CLIP = "t5xxl_fp16.safetensors";

/** LTX-Video requires frame COUNT to be 8n+1. Picks the closest valid count for the
 *  beat's duration at the given fps, never below 9 (1 full octet) or the model produces
 *  near-static output. */
function ltxFrameCount(durationSec: number, fps: number): number {
  const raw = Math.round(durationSec * fps);
  const n = Math.max(1, Math.round((raw - 1) / 8));
  return n * 8 + 1;
}

/** LTX-Video wants width/height as multiples of 32. Deliberately generates at a LOW,
 *  GPU-friendly resolution (the shared beat compositor in studio-assemble.ts already
 *  re-encodes every beat visual to the project's exact frame size — see CLAUDE.md — so
 *  there's no reason to ask an 8GB card to render at the project's full resolution). */
function ltxDimensions(aspectWide: boolean): { width: number; height: number } {
  return aspectWide ? { width: 768, height: 512 } : { width: 512, height: 768 };
}

const NEGATIVE_PROMPT =
  "low quality, worst quality, deformed, distorted, disfigured, motion smear, motion artifacts, fused fingers, bad anatomy, weird hand, ugly, text, watermark, caption, subtitles";

function buildWorkflow(opts: { prompt: string; width: number; height: number; length: number; steps: number; seed: number }): Record<string, unknown> {
  return {
    "38": { class_type: "CLIPLoader", inputs: { clip_name: T5_CLIP, type: "ltxv" } },
    "44": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: LTX_CHECKPOINT } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["38", 0], text: opts.prompt.slice(0, 2000) } },
    "7": { class_type: "CLIPTextEncode", inputs: { clip: ["38", 0], text: NEGATIVE_PROMPT } },
    "69": { class_type: "LTXVConditioning", inputs: { positive: ["6", 0], negative: ["7", 0], frame_rate: 25 } },
    "70": { class_type: "EmptyLTXVLatentVideo", inputs: { width: opts.width, height: opts.height, length: opts.length, batch_size: 1 } },
    "71": { class_type: "LTXVScheduler", inputs: { latent: ["70", 0], steps: opts.steps, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1 } },
    "73": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "72": {
      class_type: "SamplerCustom",
      inputs: {
        model: ["44", 0],
        positive: ["69", 0],
        negative: ["69", 1],
        sampler: ["73", 0],
        sigmas: ["71", 0],
        latent_image: ["70", 0],
        add_noise: true,
        noise_seed: opts.seed,
        cfg: 3,
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["72", 0], vae: ["44", 2] } },
    "41": { class_type: "SaveAnimatedWEBP", inputs: { images: ["8", 0], filename_prefix: "faceless_ltx", fps: 25, lossless: false, quality: 90, method: "default" } },
  };
}

/** Converts a downloaded animated WEBP into a silent MP4 via ffmpeg — the same binary
 *  every other provider in this app already depends on. No audio stream: every beat
 *  visual is muxed against the one master voiceover downstream (studio-assemble.ts). */
async function webpToMp4(webpPath: string, outPath: string): Promise<void> {
  const ffmpeg = resolveFfmpeg();
  const args = ["-y", "-i", webpPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", outPath];
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (status) => resolve({ status, stderr }));
      child.on("error", () => resolve({ status: null, stderr: "spawn error" }));
    });
    if (result.status === 0) return;
    lastErr = new Error(`ffmpeg webp->mp4 failed (status ${result.status}): ${result.stderr.slice(-400)}`);
    if (!isTransientSpawnFailure(result.status)) throw lastErr;
    await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
  }
  throw lastErr ?? new Error("ffmpeg webp->mp4 failed");
}

export interface LtxVideoResult { path: string }

/** Generates ONE b-roll video clip with LTX-Video via a local ComfyUI instance. */
export async function generateLtxVideo(
  runId: string,
  prompt: string,
  outPath: string,
  opts: { durationSec: number; aspectWide: boolean; steps?: number }
): Promise<LtxVideoResult> {
  const { width, height } = ltxDimensions(opts.aspectWide);
  const length = ltxFrameCount(Math.max(1, opts.durationSec), 25);
  const steps = opts.steps ?? 8; // the distilled checkpoint's whole point: ~8 steps vs ~30+
  const seed = Math.floor(Math.random() * 2 ** 32);

  const workflow = buildWorkflow({ prompt, width, height, length, steps, seed });
  const outputs = await runComfyWorkflow(runId, workflow, { label: "LTX-Video b-roll" });
  const images = outputs?.["41"]?.images;
  if (!images || !images.length) {
    throw new LocalGpuError("LTX-Video workflow completed but produced no output frames.", "capture");
  }
  const result = images[0];

  const tmpWebp = path.join(os.tmpdir(), `ltx_${Date.now()}_${Math.random().toString(36).slice(2)}.webp`);
  try {
    await downloadComfyOutput(result.filename, result.subfolder, result.type, tmpWebp);
    await webpToMp4(tmpWebp, outPath);
  } finally {
    try { fs.unlinkSync(tmpWebp); } catch { /* best effort */ }
  }
  return { path: outPath };
}

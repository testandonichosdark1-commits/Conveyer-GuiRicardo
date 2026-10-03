import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { resolveFfmpeg, isTransientSpawnFailure } from "../ffmpeg-bin";
import { uploadComfyInput, runComfyWorkflow, downloadComfyOutput, LocalGpuError } from "./comfyui-client";

/**
 * LTX-Video 2B distilled, run through a local ComfyUI instance — the AI b-roll VIDEO
 * backend for AI_PROVIDER=local. Chosen specifically because it's the only LTX tier
 * that fits an 8GB consumer GPU (the newer LTX-2 line needs 12-32GB); "distilled" also
 * means it needs as few as ~8 sampling steps instead of the base model's ~30+, which
 * matters on a GPU this small.
 *
 * IMAGE-TO-VIDEO, not text-to-video: the caller supplies a starting frame (normally a
 * ChatGPT-generated still), and LTXVImgToVideo encodes it as the first latent frame
 * instead of starting from noise. This is the fix for the pure-text-to-video path's
 * distortion on fine-detail objects (text, numbers, clock faces) — operator-reported,
 * confirmed live (2026-10-03): the model only has to imagine MOTION now, not the whole
 * object's geometry, since the starting frame is already correct. Chosen over Wan 2.1
 * I2V (wan-i2v.ts, also built to fix the same problem) because LTX's 2B checkpoint is
 * small enough to actually finish on this 8GB GPU — Wan's 14B transformer measurably is
 * not (see wan-i2v.ts's doc comment).
 *
 * The workflow (buildWorkflow below) is the official ComfyUI image-to-video template for
 * LTXV 0.9.x (comfyui_workflow_templates, ltxv_image_to_video.json — NOT one of the
 * newer/bigger "ltx2_*" templates, which need more VRAM than this checkpoint tier),
 * converted from its UI node-graph shape into the API shape POST /prompt expects, with
 * the checkpoint filename swapped for the distilled tier and width/height/length made
 * dynamic. Every node type/input name/link read directly out of the template JSON and
 * ComfyUI core's own nodes_lt.py (LTXVImgToVideo's exact parameter names), same
 * methodology as wan-i2v.ts. If a run fails with LocalGpuError code "node_missing", the
 * ComfyUI checkout is missing LTXVImgToVideo/LTXVConditioning/LTXVScheduler — these ship
 * in ComfyUI core as of the version cloned by setup-comfyui.ps1, not a separate custom
 * node install.
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

function buildWorkflow(opts: { imageFileName: string; prompt: string; width: number; height: number; length: number; steps: number; seed: number }): Record<string, unknown> {
  return {
    "38": { class_type: "CLIPLoader", inputs: { clip_name: T5_CLIP, type: "ltxv" } },
    "44": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: LTX_CHECKPOINT } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["38", 0], text: opts.prompt.slice(0, 2000) } },
    "7": { class_type: "CLIPTextEncode", inputs: { clip: ["38", 0], text: NEGATIVE_PROMPT } },
    "78": { class_type: "LoadImage", inputs: { image: opts.imageFileName, upload: "image" } },
    "77": {
      class_type: "LTXVImgToVideo",
      inputs: {
        positive: ["6", 0],
        negative: ["7", 0],
        vae: ["44", 2],
        image: ["78", 0],
        width: opts.width,
        height: opts.height,
        length: opts.length,
        batch_size: 1,
        // ComfyUI core's nodes_lt.py: conditioning_latent_frames_mask = 1.0 - strength —
        // i.e. standard img2img semantics (1.0 = ignore the starting frame, free
        // generation; 0.0 = frozen on it, no motion at all). 1.0 (the node's own default)
        // measurably still distorts complex, busy textures (an electrical panel's many
        // switches/wires) partway into the clip, even though the FIRST frame is correct —
        // confirmed live 2026-10-03 by extracting frames across a real beat. 0.65 keeps
        // real motion but gives the model much less room to reinvent fine detail it
        // should just be tracking. This reduces the risk, it does not eliminate it — no
        // current video model guarantees zero drift on busy textures.
        strength: 0.65,
      },
    },
    "69": { class_type: "LTXVConditioning", inputs: { positive: ["77", 0], negative: ["77", 1], frame_rate: 25 } },
    "71": { class_type: "LTXVScheduler", inputs: { latent: ["77", 2], steps: opts.steps, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1 } },
    "73": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "72": {
      class_type: "SamplerCustom",
      inputs: {
        model: ["44", 0],
        positive: ["69", 0],
        negative: ["69", 1],
        sampler: ["73", 0],
        sigmas: ["71", 0],
        latent_image: ["77", 2],
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

/** Generates ONE b-roll video clip by animating a still image (normally a ChatGPT-
 *  generated frame) with LTX-Video. The caller supplies the already-generated image —
 *  this module never calls ChatGPT itself, same separation wan-i2v.ts keeps. */
export async function generateLtxVideo(
  runId: string,
  startImagePath: string,
  prompt: string,
  outPath: string,
  opts: { durationSec: number; aspectWide: boolean; steps?: number }
): Promise<LtxVideoResult> {
  const imageFileName = await uploadComfyInput(startImagePath, "image");
  const { width, height } = ltxDimensions(opts.aspectWide);
  const length = ltxFrameCount(Math.max(1, opts.durationSec), 25);
  const steps = opts.steps ?? 8; // the distilled checkpoint's whole point: ~8 steps vs ~30+
  const seed = Math.floor(Math.random() * 2 ** 32);

  const workflow = buildWorkflow({ imageFileName, prompt, width, height, length, steps, seed });
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

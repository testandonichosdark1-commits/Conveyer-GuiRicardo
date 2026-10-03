import { uploadComfyInput, runComfyWorkflow, downloadComfyOutput, LocalGpuError } from "./comfyui-client";

/**
 * Wan 2.1 I2V 14B (image-to-video), run through local ComfyUI — animates a STILL image
 * into motion instead of generating video from pure noise/text like LTX-Video does. This
 * exists specifically to fix the structural distortion LTX-Video 2B distilled produces on
 * fine-detail objects (text, numbers, clock faces — the model has to invent the whole
 * shape AND the motion at once, on a checkpoint small enough to fit 8GB). Starting from a
 * correct, already-coherent image (ChatGPT-generated) means the model only has to imagine
 * MOTION — far less room to melt a shape it never had to invent in the first place.
 *
 * Reuses every checkpoint already downloaded for infinitetalk.ts (same base model family,
 * Wan 2.1 14B): the Q4_K_M GGUF, fp8 UMT5-XXL text encoder, clip_vision_h, Wan2.1 VAE, and
 * the lightx2v speed LoRA — no new download. The graph is the official plain I2V example
 * (wanvideo_2_1_14B_I2V_example_03.json, kijai/ComfyUI-WanVideoWrapper) — every node type,
 * input name and link read directly out of the installed package source (nodes.py,
 * nodes_sampler.py, nodes_model_loading.py), same methodology as infinitetalk.ts — with
 * the checkpoint swapped for the GGUF/fp8 8GB-budget tier (matching infinitetalk.ts's
 * choice) and width/height/frame-count made dynamic. The sampler's steps/cfg/shift (4/1/5)
 * are the example's own values for this exact lightx2v-LoRA-accelerated setup, not guessed.
 *
 * LIVE-TESTED 2026-10-03 — NOT PRACTICAL on this 8GB GPU, same failure mode as
 * infinitetalk.ts's 14B avatar model. Model loading, text encoding, CLIP vision and VAE
 * encoding all succeeded quickly (confirmed via the ComfyUI server log — GGUF weights
 * loaded, LoRA applied, "Sampling start... 33 frames at 832x480 ... with 4 steps"), but
 * the sampler itself never completed a single one of its 4 steps in 25 minutes (GPU
 * pegged at 100%, ~7.7GB/8GB used, no error, no OOM — it was genuinely computing, just
 * far too slowly to be usable) before the run was interrupted. Removing the audio/
 * MultiTalk nodes made LOADING much faster than infinitetalk.ts, but the 14B transformer
 * itself, even as a Q4_K_M GGUF with 20-block CPU/GPU swapping and sdpa attention, is too
 * large for this GPU to sample at a usable speed. This graph is kept — never deleted —
 * as a selectable, NOT recommended option (see providers.ts) for different/future
 * hardware; LTX-Video (ltx-video.ts) is the default despite its own distortion problem
 * because it's the one of the two that actually finishes.
 */

const MAIN_MODEL = "WanVideo\\wan2.1-i2v-14b-480p-Q4_K_M.gguf";
const VAE_MODEL = "wanvideo\\Wan2_1_VAE_bf16.safetensors";
const CLIP_VISION_MODEL = "clip_vision_h.safetensors";
const LORA_MODEL = "WanVideo\\Lightx2v\\lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors";
const TEXT_ENCODER_MODEL = "umt5-xxl-enc-fp8_e4m3fn.safetensors";

const NEGATIVE_PROMPT =
  "bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, images, static, overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, still picture, messy background, three legs, many people in the background, walking backwards";

/** WanVideoImageToVideoEncode rounds num_frames to 4k+1 internally (see its source) —
 *  picked up front so the requested count isn't silently changed under us. */
function wanFrameCount(durationSec: number, fps: number): number {
  const raw = Math.round(durationSec * fps);
  const k = Math.max(1, Math.round((raw - 1) / 4));
  return k * 4 + 1;
}

/** 480p, the tier the official example and the downloaded checkpoint (…-480p-Q4_K_M) were
 *  both built for — the shared beat compositor re-encodes every visual to the project's
 *  real resolution downstream (see CLAUDE.md), so there's no reason to push this past what
 *  the model was validated at. */
function wanDimensions(aspectWide: boolean): { width: number; height: number } {
  return aspectWide ? { width: 832, height: 480 } : { width: 480, height: 832 };
}

function buildWorkflow(opts: { imageFileName: string; prompt: string; width: number; height: number; numFrames: number; seed: number }): Record<string, unknown> {
  return {
    "16": {
      class_type: "WanVideoTextEncodeCached",
      inputs: {
        model_name: TEXT_ENCODER_MODEL,
        precision: "bf16",
        positive_prompt: opts.prompt,
        negative_prompt: NEGATIVE_PROMPT,
        quantization: "disabled",
        use_disk_cache: false,
        device: "gpu",
      },
    },
    "22": {
      class_type: "WanVideoModelLoader",
      inputs: {
        block_swap_args: ["39", 0],
        lora: ["69", 0],
        model: MAIN_MODEL,
        base_precision: "fp16_fast",
        quantization: "disabled",
        load_device: "offload_device",
        attention_mode: "sdpa",
      },
    },
    "27": {
      class_type: "WanVideoSampler",
      inputs: {
        model: ["22", 0],
        image_embeds: ["63", 0],
        text_embeds: ["16", 0],
        steps: 4,
        cfg: 1,
        shift: 5,
        seed: opts.seed,
        force_offload: true,
        scheduler: "dpm++_sde",
        riflex_freq_index: 0,
        denoise_strength: 1,
        batched_cfg: false,
        rope_function: "comfy",
        start_step: 0,
        end_step: -1,
        add_noise_to_samples: true,
      },
    },
    "28": {
      class_type: "WanVideoDecode",
      inputs: { vae: ["38", 0], samples: ["27", 0], enable_vae_tiling: false, tile_x: 272, tile_y: 272, tile_stride_x: 144, tile_stride_y: 128, normalization: "default" },
    },
    "30": {
      class_type: "VHS_VideoCombine",
      inputs: {
        images: ["28", 0],
        frame_rate: 16,
        loop_count: 0,
        filename_prefix: "faceless_wan_i2v",
        format: "video/h264-mp4",
        pix_fmt: "yuv420p",
        crf: 19,
        save_metadata: true,
        trim_to_audio: false,
        pingpong: false,
        save_output: true,
      },
    },
    "38": { class_type: "WanVideoVAELoader", inputs: { model_name: VAE_MODEL, precision: "bf16" } },
    "39": {
      class_type: "WanVideoBlockSwap",
      inputs: { blocks_to_swap: 20, offload_img_emb: false, offload_txt_emb: false, use_non_blocking: true, vace_blocks_to_swap: 0, prefetch_blocks: 1, block_swap_debug: false },
    },
    "58": { class_type: "LoadImage", inputs: { image: opts.imageFileName, upload: "image" } },
    "59": { class_type: "CLIPVisionLoader", inputs: { clip_name: CLIP_VISION_MODEL } },
    "63": {
      class_type: "WanVideoImageToVideoEncode",
      inputs: {
        vae: ["38", 0],
        clip_embeds: ["65", 0],
        start_image: ["68", 0],
        width: opts.width,
        height: opts.height,
        num_frames: opts.numFrames,
        noise_aug_strength: 0.03,
        start_latent_strength: 1,
        end_latent_strength: 1,
        force_offload: true,
        tiled_vae: false,
      },
    },
    "65": {
      class_type: "WanVideoClipVisionEncode",
      inputs: { clip_vision: ["59", 0], image_1: ["68", 0], strength_1: 1, strength_2: 1, crop: "center", combine_embeds: "average", force_offload: true, tiles: 0, ratio: 0.5 },
    },
    "68": {
      class_type: "ImageResizeKJv2",
      inputs: { image: ["58", 0], width: opts.width, height: opts.height, upscale_method: "lanczos", keep_proportion: "crop", pad_color: "0, 0, 0", crop_position: "center", divisible_by: 16, device: "cpu" },
    },
    "69": { class_type: "WanVideoLoraSelect", inputs: { lora: LORA_MODEL, strength: 1, low_mem_load: false, merge_loras: false } },
  };
}

export interface WanI2vResult { path: string }

/** Generates one b-roll video clip by animating a still image (normally a ChatGPT-
 *  generated frame) with Wan 2.1 I2V. The caller supplies the already-generated image —
 *  this module never calls ChatGPT itself, same separation ltx-video.ts keeps from the
 *  image path. */
export async function generateWanI2vVideo(
  runId: string,
  startImagePath: string,
  prompt: string,
  outPath: string,
  opts: { durationSec: number; aspectWide: boolean }
): Promise<WanI2vResult> {
  const imageFileName = await uploadComfyInput(startImagePath, "image");
  const { width, height } = wanDimensions(opts.aspectWide);
  const numFrames = wanFrameCount(Math.max(1, opts.durationSec), 16);
  const seed = Math.floor(Math.random() * 2 ** 32);

  const workflow = buildWorkflow({ imageFileName, prompt, width, height, numFrames, seed });
  const outputs = await runComfyWorkflow(runId, workflow, { label: "Wan I2V b-roll" });
  const videos = outputs?.["30"]?.gifs; // VHS_VideoCombine reports its saved file(s) under "gifs" regardless of format
  const video = videos?.[0];
  if (!video) {
    throw new LocalGpuError("Wan I2V workflow completed but produced no output video.", "capture");
  }
  await downloadComfyOutput(video.filename, video.subfolder, video.type, outPath);
  return { path: outPath };
}

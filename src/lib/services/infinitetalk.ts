import { execFileSync } from "node:child_process";
import { resolveFfprobe } from "../ffmpeg-bin";
import { uploadComfyInput, runComfyWorkflow, downloadComfyOutput, LocalGpuError } from "./comfyui-client";

/**
 * InfiniteTalk (MeiGen-AI, built on kijai/ComfyUI-WanVideoWrapper's WanVideo 2.1 I2V
 * 14B) — the local-GPU avatar/lip-sync backend, a free alternative to HeyGen.
 *
 * The workflow graph (buildWorkflow below) is the official example
 * (wanvideo_2_1_14B_I2V_InfiniteTalk_example_03.json, kijai/ComfyUI-WanVideoWrapper),
 * programmatically converted from its UI node-graph shape into the API shape POST
 * /prompt expects — every node type, input name, and widget value was read directly out
 * of the installed custom node source (not guessed), SetNode/GetNode indirection was
 * resolved to the real upstream link, and dead nodes unreachable from the terminal
 * VHS_VideoCombine were dropped. Two deliberate deviations from the example's exact
 * checkpoints, both for the 8GB VRAM budget (WanVideoBlockSwap already offloads blocks
 * between GPU/CPU either way, so a smaller quant means less to swap, not just a smaller
 * download):
 *   - the main WanVideo checkpoint is Q4_K_M (~11.3GB) instead of the example's Q8_0 (~18GB)
 *   - the UMT5-XXL text encoder is fp8 (~6.7GB) instead of bf16 (~11.4GB)
 * NOT YET VALIDATED against a live run — see the note at the bottom of this file.
 */

const MAIN_MODEL = "WanVideo\\wan2.1-i2v-14b-480p-Q4_K_M.gguf";
const INFINITETALK_MODEL = "WanVideo\\InfiniteTalk\\Wan2_1-InfiniteTalk_Single_Q8.gguf";
const VAE_MODEL = "wanvideo\\Wan2_1_VAE_bf16.safetensors";
const CLIP_VISION_MODEL = "clip_vision_h.safetensors";
const LORA_MODEL = "WanVideo\\Lightx2v\\lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors";
const TEXT_ENCODER_MODEL = "umt5-xxl-enc-fp8_e4m3fn.safetensors";
const WAV2VEC_MODEL = "wav2vec2-chinese-base_fp16.safetensors";
const MELBAND_MODEL = "MelBandRoFormer\\MelBandRoformer_fp16.safetensors";

const NEGATIVE_PROMPT =
  "bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, images, static, overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, still picture, messy background, three legs, many people in the background, walking backwards";

function probeAudioDurationSec(audioFileName: string, audioPath: string): number {
  try {
    const out = execFileSync(resolveFfprobe(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath], { encoding: "utf8" });
    const sec = Number(out.trim());
    if (Number.isFinite(sec) && sec > 0) return sec;
  } catch {
    // fall through to the error below — a bad duration would silently mis-time every beat
  }
  throw new LocalGpuError(`Could not read the duration of ${audioFileName}.`, "capture");
}

function buildWorkflow(opts: {
  imageFileName: string;
  audioFileName: string;
  prompt: string;
  numFrames: number;
  seed: number;
}): Record<string, unknown> {
  return {
    "120": { class_type: "MultiTalkModelLoader", inputs: { model: INFINITETALK_MODEL } },
    "122": {
      class_type: "WanVideoModelLoader",
      inputs: {
        block_swap_args: ["134", 0],
        lora: ["138", 0],
        multitalk_model: ["120", 0],
        model: MAIN_MODEL,
        base_precision: "fp16_fast",
        quantization: "disabled",
        load_device: "offload_device",
        attention_mode: "sageattn",
      },
    },
    "125": { class_type: "LoadAudio", inputs: { audio: opts.audioFileName, upload: null } },
    "128": {
      class_type: "WanVideoSampler",
      inputs: {
        model: ["122", 0],
        image_embeds: ["192", 0],
        text_embeds: ["241", 0],
        multitalk_embeds: ["194", 0],
        steps: 6,
        cfg: 1,
        shift: 11,
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
    "129": { class_type: "WanVideoVAELoader", inputs: { model_name: VAE_MODEL, precision: "bf16" } },
    "131": {
      class_type: "VHS_VideoCombine",
      inputs: {
        images: ["309", 0],
        audio: ["125", 0],
        frame_rate: 25,
        loop_count: 0,
        filename_prefix: "faceless_infinitetalk",
        format: "video/h264-mp4",
        pix_fmt: "yuv420p",
        crf: 19,
        save_metadata: true,
        trim_to_audio: false,
        pingpong: false,
        save_output: true,
      },
    },
    "134": {
      class_type: "WanVideoBlockSwap",
      inputs: { blocks_to_swap: 20, offload_img_emb: false, offload_txt_emb: false, use_non_blocking: true, vace_blocks_to_swap: 0, prefetch_blocks: 1, block_swap_debug: false },
    },
    "138": { class_type: "WanVideoLoraSelect", inputs: { lora: LORA_MODEL, strength: 1, low_mem_load: false, merge_loras: false } },
    "192": {
      class_type: "WanVideoImageToVideoMultiTalk",
      inputs: {
        vae: ["129", 0],
        start_image: ["291", 0],
        clip_embeds: ["237", 0],
        width: 832,
        height: 480,
        frame_window_size: 81,
        motion_frame: 9,
        force_offload: false,
        colormatch: "disabled",
        tiled_vae: false,
        mode: "infinitetalk",
        output_path: "",
      },
    },
    "194": {
      class_type: "MultiTalkWav2VecEmbeds",
      inputs: {
        wav2vec_model: ["300", 0],
        audio_1: ["302", 0],
        num_frames: opts.numFrames,
        normalize_loudness: true,
        fps: 25,
        audio_scale: 1,
        audio_cfg_scale: 1,
        multi_audio_type: "para",
      },
    },
    "237": {
      class_type: "WanVideoClipVisionEncode",
      inputs: { clip_vision: ["238", 0], image_1: ["291", 0], strength_1: 1, strength_2: 1, crop: "center", combine_embeds: "average", force_offload: true, tiles: 0, ratio: 0.5 },
    },
    "238": { class_type: "CLIPVisionLoader", inputs: { clip_name: CLIP_VISION_MODEL } },
    "241": {
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
    "281": {
      class_type: "ImageResizeKJv2",
      inputs: { image: ["284", 0], width: 832, height: 480, upscale_method: "lanczos", keep_proportion: "crop", pad_color: "0, 0, 0", crop_position: "center", divisible_by: 16, device: "cpu" },
    },
    "284": { class_type: "LoadImage", inputs: { image: opts.imageFileName, upload: "image" } },
    "291": { class_type: "GetImageSizeAndCount", inputs: { image: ["281", 0] } },
    "300": { class_type: "Wav2VecModelLoader", inputs: { model: WAV2VEC_MODEL, base_precision: "fp16", load_device: "main_device" } },
    "301": { class_type: "MelBandRoFormerModelLoader", inputs: { model_name: MELBAND_MODEL } },
    "302": { class_type: "MelBandRoFormerSampler", inputs: { model: ["301", 0], audio: ["125", 0] } },
    "309": { class_type: "WanVideoPassImagesFromSamples", inputs: { samples: ["128", 0] } },
  };
}

export interface LocalAvatarHandle {
  provider: "local_infinitetalk";
  dbId: number;
  /** avatars.ref_image_path — InfiniteTalk consumes the photo directly, no remote ingest. */
  refImagePath: string;
  motionPrompt?: string | null;
}

export async function generateLocalAvatarClip(
  runId: string,
  avatar: LocalAvatarHandle,
  audioPath: string,
  outPath: string,
  opts: { resolution?: string } = {}
): Promise<string> {
  void runId;
  void opts;
  const audioFileName = await uploadComfyInput(audioPath, "audio");
  const imageFileName = await uploadComfyInput(avatar.refImagePath, "image");
  const durationSec = probeAudioDurationSec(audioFileName, audioPath);
  // frame_window_size is 81 in the official graph — MultiTalkWav2VecEmbeds' own
  // num_frames just needs to cover the clip; WanVideoImageToVideoMultiTalk loops
  // internally in 81-frame windows for anything longer (see its own docstring).
  const numFrames = Math.max(25, Math.round(durationSec * 25));
  const prompt = avatar.motionPrompt?.trim() || "a person talking naturally to the camera, documentary interview style";
  const seed = Math.floor(Math.random() * 2 ** 32);

  const workflow = buildWorkflow({ imageFileName, audioFileName, prompt, numFrames, seed });
  const outputs = await runComfyWorkflow(runId, workflow, { label: "InfiniteTalk avatar" });
  const videos = outputs?.["131"]?.gifs; // VHS_VideoCombine reports its saved file(s) under "gifs" regardless of format
  const video = videos?.[0];
  if (!video) {
    throw new LocalGpuError("InfiniteTalk workflow completed but produced no output video.", "capture");
  }
  await downloadComfyOutput(video.filename, video.subfolder, video.type, outPath);
  return outPath;
}

/**
 * NOT YET VALIDATED against a live ComfyUI run. Unlike ltx-video.ts (which worked on
 * the first live attempt because its workflow is 11 simple core nodes), this graph is
 * 20 nodes across 4 custom node packs with real failure surface this analysis cannot
 * rule out from reading source code alone — most notably whether VHS_VideoCombine
 * really reports its result under the "gifs" output key for an mp4 format (it does for
 * gif/webp; mp4 was not confirmed against a live run) and whether the Q4_K_M/fp8
 * substitutions load without error. Run a real beat end to end and fix whatever this
 * note turns out to be wrong about before trusting it unattended.
 */

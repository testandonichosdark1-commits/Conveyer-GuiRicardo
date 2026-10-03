import fs from "node:fs";
import path from "node:path";
import { uploadComfyInput, runComfyWorkflow, LocalGpuError } from "./comfyui-client";
import type { LocalAvatarHandle } from "./infinitetalk";

/**
 * SadTalker, run through a local ComfyUI instance — the free avatar/lip-sync backend
 * for a `local_infinitetalk`-provider avatar, selected via the `AVATAR_LOCAL_MODEL`
 * setting (default "sadtalker"). Added 2026-10-03 because InfiniteTalk (infinitetalk.ts,
 * built on Wan 2.1's 14B transformer) is NOT practical on this 8GB GPU — live-tested
 * twice (InfiniteTalk itself and the same base model's plain I2V path, see wan-i2v.ts):
 * neither finished a single sampling step in 16-25 minutes. SadTalker is architecturally
 * a different, much lighter category — 3DMM coefficients + a GAN-based renderer, not a
 * diffusion transformer — with a 3-year track record of running on modest consumer GPUs,
 * which is why it was chosen over newer-but-heavier diffusion talking-head models (e.g.
 * Sonic, whose official implementation needs a 32GB GPU).
 *
 * Trade-off, accepted deliberately: lower visual quality than HeyGen or InfiniteTalk
 * would have been — output tops out at 512x512 (this app renders at 256x256, the faster
 * tier) and head motion is noticeably stiffer than a modern diffusion avatar. The
 * operator chose "actually runs" over "higher fidelity, but unproven on this hardware"
 * after InfiniteTalk and Wan I2V both failed live tests the same day.
 *
 * Installed via haomole/Comfyui-SadTalker (ComfyUI custom node wrapping OpenTalker/
 * SadTalker). The workflow graph (buildWorkflow below) is this package's own
 * workflow/workflow.json example, converted to the API shape POST /prompt expects —
 * every node type/input name read directly from the installed node source
 * (nodes/SadTalkerNode.py, nodes/ShowVideo.py), same methodology as every other local
 * provider in this app. `ShowVideo` is NOT decorative: `SadTalkerNode` itself returns
 * plain STRING outputs with no UI/OUTPUT_NODE behavior, so nothing would appear in
 * ComfyUI's /history response without a downstream OUTPUT_NODE consuming them — ShowVideo
 * is that node, and its `show_video_path` output is what this module reads back.
 *
 * Output retrieval is NOT the usual `/view` HTTP download every other local provider
 * uses: SadTalkerNode writes its result as an absolute path on disk and copies it into
 * ComfyUI's own output directory (`comfy_output_dir`), rather than returning a
 * `{filename, subfolder, type}` descriptor. Since ComfyUI and this app always run on the
 * same machine (COMFYUI_URL is loopback-only by convention throughout this codebase),
 * the path is read directly via `fs.copyFileSync` instead of an HTTP round-trip.
 *
 * LIVE-TESTED 2026-10-03: a 3s clip generated end-to-end in ~15s (image upload + 3DMM
 * face fitting + audio coefficient prediction + GAN rendering + mux), well within budget
 * on this 8GB GPU. Required patching FIVE compatibility bugs in the installed package —
 * none of them logic errors, all symptoms of running 2023-era code against this venv's
 * numpy 2.4.6 / modern torchvision (SadTalker predates both by ~2 years):
 *   1. `SadTalker/src/face3d/util/preprocess.py` — `np.VisibleDeprecationWarning` moved
 *      to `np.exceptions.VisibleDeprecationWarning` in modern numpy.
 *   2-3. Same file, `resize_n_crop_img()` — two `float(array)` calls on non-0-d arrays,
 *      which numpy <1.25 silently coerced and numpy 2.x rejects. Fixed with
 *      `float(np.ravel(x)[0])`, robust to whatever shape the array actually has.
 *   4. `SadTalker/src/utils/preprocess.py` — same `float(array)` pattern on the output
 *      of `np.hsplit`.
 *   5. `basicsr`'s `data/degradations.py` imports `torchvision.transforms.functional_tensor`,
 *      removed upstream; the function moved to `torchvision.transforms.functional`.
 * Plus one real node bug: `ShowVideo.generate()` assumed `extra_pnginfo[0]` is always a
 * dict, which is only true when ComfyUI's own UI supplies it — calling the workflow via
 * the raw POST /prompt API (as this app always does) leaves it `[None]`, crashing on
 * `"workflow" in extra_pnginfo[0]`. Patched with a `extra_pnginfo[0]` truthiness check.
 * All patches are in the installed package under ComfyUI's custom_nodes/ and .venv/, not
 * in this repo — if this ComfyUI install is ever rebuilt from scratch, these five fixes
 * need to be re-applied (or the operator should check if upstream has fixed them by then).
 */

const DEFAULT_MOTION_PROMPT_POSE_STYLE = 0; // SadTalker has no text prompt — poseStyle (0-46) is its only "style" knob

export async function generateSadTalkerClip(
  runId: string,
  avatar: LocalAvatarHandle,
  audioPath: string,
  outPath: string,
  opts: { resolution?: string } = {}
): Promise<string> {
  void opts;
  const audioFileName = await uploadComfyInput(audioPath, "audio");
  const imageFileName = await uploadComfyInput(avatar.refImagePath, "image");

  const workflow = {
    "9": { class_type: "LoadImage", inputs: { image: imageFileName, upload: "image" } },
    "63": { class_type: "LoadAudio", inputs: { audio: audioFileName, upload: null } },
    "70": {
      class_type: "SadTalker",
      inputs: {
        image: ["9", 0],
        audio: ["63", 0],
        poseStyle: DEFAULT_MOTION_PROMPT_POSE_STYLE,
        faceModelResolution: "256",
        preprocess: "crop",
        stillMode: false,
        batchSizeInGeneration: 2,
        gfpganAsFaceEnhancer: false,
        useIdleMode: false,
        idleModeTime: 5,
        useRefVideo: false,
        refInfo: "pose",
      },
    },
    "49": { class_type: "ShowVideo", inputs: { show_video_path: ["70", 1] } },
  };

  const outputs = await runComfyWorkflow(runId, workflow, { label: "SadTalker avatar" });
  // ShowVideo's "show_video_path" output isn't one of comfyui-client.ts's known output
  // shapes (images/audio/gifs) — it's a plain string this custom node invents, so the
  // shared ComfyHistoryEntry type doesn't declare it.
  const showVideoOutput = outputs?.["49"] as unknown as { show_video_path?: string[] } | undefined;
  const resultPath = showVideoOutput?.show_video_path?.[0];
  if (!resultPath || !fs.existsSync(resultPath)) {
    throw new LocalGpuError("SadTalker workflow completed but produced no readable output video.", "capture");
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.copyFileSync(resultPath, outPath);
  return outPath;
}

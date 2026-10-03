import { LocalGpuError } from "./comfyui-client";

/**
 * InfiniteTalk (MeiGen-AI, built on kijai/ComfyUI-WanVideoWrapper's WanVideo 2.1 I2V
 * 14B) — the local-GPU avatar/lip-sync backend, a free alternative to HeyGen.
 *
 * NOT YET WIRED TO A REAL WORKFLOW. The official example workflow
 * (wanvideo_2_1_14B_I2V_InfiniteTalk_example_03.json, kijai/ComfyUI-WanVideoWrapper) is
 * 47 nodes across THREE custom node packs (ComfyUI-WanVideoWrapper,
 * ComfyUI-VideoHelperSuite, ComfyUI-KJNodes) and needs ~36GB of additional checkpoints
 * (WanVideo 2.1 I2V 14B GGUF, the InfiniteTalk GGUF, a CLIP Vision model, Wav2Vec2,
 * MelBandRoFormer, UMT5-XXL) — a much larger install than LTX-Video's single 2B
 * checkpoint in ComfyUI core. That install (custom nodes + checkpoints) has not run yet,
 * so there is nothing real to test a workflow translation against. Rather than ship an
 * untested 400-line workflow JSON built from reading someone else's graph, this throws a
 * clear, typed error — the existing degrade-to-b-roll path in studio-pipeline.ts (the
 * same one that already handles a HeyGen failure) takes over cleanly:  the beat falls
 * back to b-roll, the run is marked `degraded`, nothing crashes.
 *
 * `LocalAvatarHandle` and `generateLocalAvatarClip`'s signature ARE final — wired into
 * studio-pipeline.ts already (see readAvatar/generateAnyAvatarClip) — only the body
 * that actually talks to ComfyUI is pending.
 */

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
  void avatar;
  void audioPath;
  void outPath;
  void opts;
  throw new LocalGpuError(
    "InfiniteTalk is not installed yet (custom nodes + ~36GB of checkpoints pending) — this avatar beat will fall back to b-roll.",
    "node_missing"
  );
}

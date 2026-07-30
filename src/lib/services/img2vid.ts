import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createVideoJob, pollJob, downloadJob, cancelJob, releaseJob } from "./labs69";
import { CancelledError } from "../cancellation";

/**
 * Generates a short video clip for a scene.
 *
 * Conveyer Grok is video-only: every scene runs Grok in pure text-to-video mode
 * (no image keyframe), routed through 69labs. The legacy img2vid behavior —
 * chaining a generated image into the video model as the first frame — is
 * removed because we no longer have an image stage to chain from.
 *
 * If you ever want to re-enable image-keyframed video later, pass a non-null
 * `imagePath` AND make sure the upstream pipeline produced the image first.
 * Replicate / fal still expect an image; 69labs's grok-imagine-video accepts
 * a text-only prompt (which is what we use now).
 */
export async function animateScene(
  runId: string,
  scene: Scene,
  imagePath: string | null,
  outDir: string,
  options: {
    providerJobId?: string;
    imageProvider?: string;
    /** Optional preset-level override for the animation_motion suffix.
     *  Empty/null → fall back to global default from prompts table. */
    motionOverride?: string | null;
  } = {}
): Promise<string | null> {
  const provider = (getSetting("ANIMATION_PROVIDER") || "off").toLowerCase();
  if (provider === "off") return null;

  const fileName = `scene_${String(scene.index).padStart(3, "0")}.mp4`;
  const filePath = path.join(outDir, fileName);
  const mode = imagePath ? "img2vid" : "text-to-video";

  log(runId, "info", `${mode} scene #${scene.index} (${provider})`, {
    stage: "animate",
    data: { provider, mode, prompt: scene.visual_prompt.slice(0, 120) },
  });

  if (provider === "69labs") {
    await labs69Img2Vid(
      runId,
      scene,
      options.providerJobId,
      options.imageProvider,
      filePath,
      options.motionOverride
    );
  } else if (provider === "replicate") {
    if (!imagePath) throw new Error("Replicate Kling needs an image keyframe — not available in Conveyer Grok's video-only flow.");
    await replicateImg2Vid(scene, imagePath, filePath);
  } else if (provider === "fal") {
    if (!imagePath) throw new Error("fal.ai Kling needs an image keyframe — not available in Conveyer Grok's video-only flow.");
    await falImg2Vid(scene, imagePath, filePath);
  } else {
    throw new Error(`Unknown animation provider: ${provider}`);
  }

  log(runId, "success", `Animation done: ${fileName}`, { stage: "animate" });
  return filePath;
}

async function labs69Img2Vid(
  runId: string,
  scene: Scene,
  providerJobId: string | undefined,
  imageProvider: string | undefined,
  outPath: string,
  motionOverride?: string | null
) {
  const model = getSetting("ANIMATION_MODEL") || undefined;
  const aspectRatio = getSetting("IMAGE_RATIO") || undefined;
  const durationSetting = getSetting("ANIMATION_DURATION") || undefined;
  // ANIMATION_KEEP_VEO_AUDIO=1 — keep generated ambient audio (default: off, mute it).
  const keepAudio = getSetting("ANIMATION_KEEP_VEO_AUDIO") === "1";

  // Motion style: preset override (per channel) wins over the global default.
  // Empty/null override means "inherit global" — fall back to getPrompt().
  const motionStyle =
    motionOverride && motionOverride.trim().length > 0
      ? motionOverride
      : getPrompt("animation_motion");
  const prompt = `${scene.visual_prompt}. ${motionStyle}`;

  // If the image was generated through 69labs, pass its jobId so the API
  // reuses the cached image instead of making us re-upload bytes.
  const usableJobId = imageProvider === "69labs" ? providerJobId : undefined;

  // Duration parameter rules per model:
  //  - Veo 3.1 Fast: ignores duration entirely. Skip.
  //  - Grok Imagine Video via 69labs: gateway hard-rejects duration with
  //    HTTP 400 "Grok Video does not support duration selection" no matter
  //    what format we send ("6", "6s", "10s" — all fail). The 69labs
  //    OpenAPI spec lists duration on the endpoint but the runtime check
  //    blocks it specifically for Grok. So we skip it and 69labs returns
  //    its fixed ~6-second clip. xAI native allows 6–15s, but only via
  //    direct API or other gateways (Replicate/fal/wavespeed).
  //  - Other models (Kling etc.): pass duration through with "<N>s" format.
  const isGrok = model && /^grok/i.test(model);
  const isVeo = model && /^veo/i.test(model);
  let duration: string | undefined;

  if (!isVeo && !isGrok) {
    if (durationSetting) {
      const n = parseInt(String(durationSetting).replace(/[^0-9]/g, ""), 10);
      if (Number.isFinite(n) && n > 0) duration = `${n}s`;
    } else {
      const sceneDur = Math.max(4, Math.min(10, Math.ceil(scene.duration_hint_sec || 5)));
      duration = `${sceneDur}s`;
    }
  }

  // Retry: timeout → cancel → retry. Same pattern as image-gen.
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  let lastJobId: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const jobId = await createVideoJob({
        prompt,
        model,
        aspectRatio,
        duration,
        imageJobId: usableJobId,
        mute: !keepAudio,
        runId,
      });
      lastJobId = jobId;
      log(
        runId,
        "debug",
        `69labs video job ${jobId.slice(0, 8)}… (img2vid${usableJobId ? ", reusing image" : ", text-only"}, attempt=${attempt})`,
        { stage: "animate" }
      );
      await pollJob("videos", jobId, runId, "animate");
      await downloadJob("videos", jobId, outPath);
      return;
    } catch (e) {
      // A user cancel must abort — never retry into a new billable job.
      if (e instanceof CancelledError) {
        if (lastJobId) releaseJob(lastJobId);
        throw e;
      }
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (lastJobId) {
        if (/polling timeout/i.test(msg)) {
          const cancelled = await cancelJob("videos", lastJobId);
          log(runId, "debug", `Cancelled video ${lastJobId.slice(0, 8)} → ${cancelled ? "ok" : "skipped"}`, {
            stage: "animate",
          });
        } else {
          releaseJob(lastJobId);
        }
      }
      if (attempt < MAX_ATTEMPTS) {
        const delay = 5000 * attempt;
        log(runId, "warn", `video attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg.slice(0, 200)} — retry in ${delay}ms`, {
          stage: "animate",
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function replicateImg2Vid(scene: Scene, imagePath: string, outPath: string) {
  const token = getSetting("REPLICATE_API_TOKEN");
  if (!token) throw new Error("REPLICATE_API_TOKEN is not set");

  // Default: Kling 1.6 standard — good quality/price balance.
  // Alternatives: kwaivgi/kling-v1.6-pro, wavespeedai/wan-2.1-i2v
  const model = getSetting("ANIMATION_MODEL") || "kwaivgi/kling-v1.6-standard";

  const imgB64 = fs.readFileSync(imagePath).toString("base64");
  const dataUri = `data:image/png;base64,${imgB64}`;

  const create = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      input: {
        prompt: scene.visual_prompt,
        start_image: dataUri,
        duration: 5,
        cfg_scale: 0.5,
        aspect_ratio: getSetting("IMAGE_RATIO") || "16:9",
      },
    }),
  });

  if (!create.ok) {
    throw new Error(`Replicate img2vid ${create.status}: ${(await create.text()).slice(0, 300)}`);
  }
  const json = (await create.json()) as { output?: string | string[] };
  const url = typeof json.output === "string" ? json.output : json.output?.[0];
  if (!url) throw new Error(`Replicate returned no output: ${JSON.stringify(json).slice(0, 300)}`);

  const vid = await fetch(url);
  if (!vid.ok) throw new Error(`Failed to download video: ${vid.status}`);
  fs.writeFileSync(outPath, Buffer.from(await vid.arrayBuffer()));
}

async function falImg2Vid(scene: Scene, imagePath: string, outPath: string) {
  const key = getSetting("FAL_API_KEY");
  if (!key) throw new Error("FAL_API_KEY is not set");
  const model = getSetting("ANIMATION_MODEL") || "fal-ai/kling-video/v1.6/standard/image-to-video";

  const imgB64 = fs.readFileSync(imagePath).toString("base64");
  const dataUri = `data:image/png;base64,${imgB64}`;

  const resp = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: scene.visual_prompt,
      image_url: dataUri,
      duration: "5",
      aspect_ratio: getSetting("IMAGE_RATIO") || "16:9",
    }),
  });

  if (!resp.ok) throw new Error(`fal img2vid ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const json = (await resp.json()) as { video?: { url: string } };
  const url = json.video?.url;
  if (!url) throw new Error("fal img2vid: empty output");
  const vid = await fetch(url);
  fs.writeFileSync(outPath, Buffer.from(await vid.arrayBuffer()));
}

/**
 * Picks which scenes get img2vid (the rest go through Ken-Burns on a still image).
 *
 * Distribution modes:
 *  - "first-half" (default): first `ratio%` of scenes get video, rest get photo.
 *    Creates a strong hook at the start of the video.
 *  - "alternating": every Nth scene (video / photo / video / photo).
 *  - "random": random `ratio%`, with priority for scenes that have motion-related keywords.
 *  - "all": every scene gets video (ratio = 100%).
 */
export function pickScenesToAnimate(
  scenes: Scene[],
  ratioPercent: number,
  distribution: "first-half" | "alternating" | "random" | "all" = "first-half"
): Set<number> {
  if (ratioPercent >= 100 || distribution === "all") {
    return new Set(scenes.map((s) => s.index));
  }
  if (ratioPercent <= 0) return new Set();
  const target = Math.max(1, Math.round((scenes.length * ratioPercent) / 100));

  if (distribution === "first-half") {
    return new Set(scenes.slice(0, target).map((s) => s.index));
  }

  if (distribution === "alternating") {
    const step = scenes.length / target;
    const picks = new Set<number>();
    for (let i = 0; picks.size < target && i < scenes.length; i++) {
      picks.add(Math.floor(i * step));
    }
    return picks;
  }

  // "random" — prioritize scenes whose prompt contains motion keywords
  const motionWords = /\b(moving|drift|orbit|explos|swirl|flowing|burst|spin|rotate|shoot|fly|fall|rising|crash|run|march|lift|pour|flow|surge)\b/i;
  const scored = scenes.map((s) => ({
    index: s.index,
    score: motionWords.test(s.visual_prompt) ? 2 : 1,
  }));
  scored.sort((a, b) => b.score - a.score || Math.random() - 0.5);
  return new Set(scored.slice(0, target).map((s) => s.index));
}

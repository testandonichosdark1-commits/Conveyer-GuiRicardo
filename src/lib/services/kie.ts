import fs from "node:fs";
import { getSetting } from "../settings";
import { checkCancelled } from "../cancellation";

/**
 * kie.ai provider — nano-banana (image) + Veo (video).
 *
 * Two API families with DIFFERENT shapes (confirmed in research):
 *  - Jobs/Market API (nano-banana): POST /api/v1/jobs/createTask → taskId;
 *    GET /api/v1/jobs/recordInfo → data.state + data.resultJson (a JSON STRING
 *    you must parse → resultUrls[0]).
 *  - Veo dedicated API: POST /api/v1/veo/generate → taskId;
 *    GET /api/v1/veo/record-info → data.successFlag (int) + data.response.resultUrls (array).
 * Auth: `Authorization: Bearer <KIE_API_KEY>`. See docs/DESIGN.md.
 */

const BASE = "https://api.kie.ai";

function kieKey(): string {
  const k = getSetting("KIE_API_KEY");
  if (!k) throw new Error("KIE_API_KEY is not set — paste it in /parametres.");
  return k;
}

/**
 * kie.ai returns application-level errors as HTTP 200 with a non-200 `code` in
 * the body (401 auth, 402 no credits, 422 validation, 429 rate limit, 500 …).
 * Surface those as real errors instead of letting them masquerade as success.
 */
function parseKie<T>(label: string, text: string): T {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`kie.ai ${label}: non-JSON response: ${text.slice(0, 200)}`);
  }
  const code = (j as { code?: number }).code;
  const msg = (j as { msg?: string }).msg;
  if (typeof code === "number" && code !== 200) {
    throw new Error(`kie.ai ${label} code ${code}: ${msg || text.slice(0, 200)}`);
  }
  return j as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch + text with retries on transient failures (network error, 429, 5xx). */
async function kieFetchText(url: string, init: RequestInit, label: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(url, init);
    } catch (e) {
      // Network error ("fetch failed", DNS, timeout) — retry a few times.
      if (attempt < 3) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new Error(`kie.ai ${label}: ${(e as Error).message}`);
    }
    const text = await r.text();
    if (r.ok) return text;
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      await sleep(2000 * attempt);
      continue;
    }
    throw new Error(`kie.ai ${label} ${r.status}: ${text.slice(0, 250)}`);
  }
}

async function kiePost<T>(pathName: string, body: unknown): Promise<T> {
  const text = await kieFetchText(
    `${BASE}${pathName}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${kieKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    pathName
  );
  return parseKie<T>(pathName, text);
}

async function kieGet<T>(pathWithQuery: string): Promise<T> {
  const text = await kieFetchText(
    `${BASE}${pathWithQuery}`,
    { headers: { Authorization: `Bearer ${kieKey()}` } },
    pathWithQuery
  );
  return parseKie<T>(pathWithQuery, text);
}

function toBananaAspect(ratio: string): string {
  // Accept "16:9"/"9:16"/"1:1" etc.; default 16:9 for landscape documentary.
  return /^\d+:\d+$/.test(ratio) ? ratio : "16:9";
}

// ── nano-banana image (Jobs API) ─────────────────────────────────────────────

interface CreateTaskResp {
  code?: number;
  msg?: string;
  data?: { taskId?: string };
}
interface JobRecordResp {
  data?: {
    state?: string; // waiting | queuing | generating | success | fail
    resultJson?: string;
    failCode?: string;
    failMsg?: string;
    progress?: number;
  };
}

/** Generate one image from a text prompt via nano-banana. Returns the image URL. */
export async function generateImageUrl(
  runId: string,
  prompt: string,
  aspectRatio = "16:9"
): Promise<string> {
  const model = getSetting("KIE_IMAGE_MODEL") || "google/nano-banana";
  if (runId) checkCancelled(runId); // never start a new billable kie job for a cancelled run
  const created = await kiePost<CreateTaskResp>("/api/v1/jobs/createTask", {
    model,
    input: {
      prompt: prompt.slice(0, 5000),
      output_format: "png",
      aspect_ratio: toBananaAspect(aspectRatio),
      nsfw_checker: false,
    },
  });
  const taskId = created.data?.taskId;
  if (!taskId) throw new Error(`kie.ai createTask returned no taskId: ${JSON.stringify(created).slice(0, 200)}`);

  const DEADLINE = Date.now() + 5 * 60 * 1000;
  let delay = 4000;
  while (Date.now() < DEADLINE) {
    if (runId) checkCancelled(runId);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1500, 12000);
    const rec = await kieGet<JobRecordResp>(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`);
    const state = rec.data?.state;
    if (state === "success" && rec.data?.resultJson) {
      try {
        const parsed = JSON.parse(rec.data.resultJson) as { resultUrls?: string[] };
        const url = parsed.resultUrls?.[0];
        if (url) return url;
      } catch {}
      throw new Error("kie.ai nano-banana success but no resultUrls");
    }
    if (state === "fail") throw new Error(`kie.ai nano-banana failed: ${rec.data?.failMsg || rec.data?.failCode || "unknown"}`);
  }
  throw new Error("kie.ai nano-banana timed out");
}

// ── Veo video (dedicated API) ────────────────────────────────────────────────

interface VeoRecordResp {
  data?: {
    successFlag?: number; // 0 generating, 1 success, 2/3 failed
    response?: { resultUrls?: string[] };
    errorMessage?: string;
    errorCode?: string | null;
  };
}

function toVeoAspect(ratio: string): string {
  if (ratio === "9:16") return "9:16";
  return "16:9";
}

/** Generate a video from a text prompt via Veo. Returns the video URL. */
export async function generateVideoUrl(
  runId: string,
  prompt: string,
  aspectRatio = "16:9",
  durationSec = 8
): Promise<string> {
  const model = getSetting("KIE_VIDEO_MODEL") || "veo3_fast";
  const duration = durationSec <= 4 ? 4 : durationSec <= 6 ? 6 : 8;
  if (runId) checkCancelled(runId); // never start a new billable kie job for a cancelled run
  const created = await kiePost<CreateTaskResp>("/api/v1/veo/generate", {
    prompt: prompt.slice(0, 5000),
    model,
    generationType: "TEXT_2_VIDEO",
    aspect_ratio: toVeoAspect(aspectRatio),
    duration,
    resolution: "1080p",
    enableTranslation: false,
  });
  const taskId = created.data?.taskId;
  if (!taskId) throw new Error(`kie.ai veo generate returned no taskId: ${JSON.stringify(created).slice(0, 200)}`);

  const DEADLINE = Date.now() + 12 * 60 * 1000;
  let delay = 6000;
  while (Date.now() < DEADLINE) {
    if (runId) checkCancelled(runId);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 2000, 20000);
    const rec = await kieGet<VeoRecordResp>(`/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`);
    const flag = rec.data?.successFlag;
    if (flag === 1) {
      const url = rec.data?.response?.resultUrls?.[0];
      if (url) return url;
      throw new Error("kie.ai Veo success but no resultUrls");
    }
    if (flag === 2 || flag === 3) {
      throw new Error(`kie.ai Veo failed: ${rec.data?.errorMessage || rec.data?.errorCode || "unknown"}`);
    }
  }
  throw new Error("kie.ai Veo timed out");
}

/** Download a kie.ai result URL to disk. */
export async function downloadKie(url: string, outPath: string): Promise<void> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`kie.ai download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("kie.ai download empty");
  fs.writeFileSync(outPath, buf);
}

/**
 * Generate an AI portrait image from a description and save it to `outPath`
 * (used to create an avatar from text). Returns outPath.
 */
export async function generateAvatarImage(prompt: string, outPath: string): Promise<string> {
  // 16:9 on purpose: HeyGen renders a talking photo at the photo's own aspect,
  // so a wide reference photo = a true full-frame 16:9 presenter (no pillarbox,
  // no blur-fill needed). Waist-up framing keeps the face large enough for good
  // lip-sync while still showing a believable environment.
  const styled =
    `${prompt}. Photorealistic medium shot, waist-up, centered, looking straight at the camera, ` +
    `natural realistic environment with soft depth of field, natural lighting, ultra-detailed, 4k. ` +
    `Wide 16:9 cinematic framing. No text, no watermark.`;
  const url = await generateImageUrl("", styled, "16:9");
  await downloadKie(url, outPath);
  return outPath;
}

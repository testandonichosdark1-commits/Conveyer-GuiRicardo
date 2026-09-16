import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import {
  CloudflareImageError,
  cloudflareImageConfigured,
  generateCloudflareImage,
  getCloudflareProfileSummaries,
  isCloudflareDailyQuotaError,
  type CloudflareProfileFailoverInfo,
  type CloudflareRetryInfo,
} from "@/lib/services/cloudflare-image";
import { callGemini } from "@/lib/services/gemini-models";
import { generateImageUrl, downloadKie } from "@/lib/services/kie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Simulation = "none" | "3040" | "3036" | "4006" | "401" | "403" | "500";

type Body = {
  prompt?: string;
  aspectRatio?: "16:9" | "9:16";
  threshold?: number;
  runGeminiScore?: boolean;
  actuallyCallKieFallback?: boolean;
  simulation?: Simulation;
};

function cleanTemp(filePath: string) {
  try { fs.unlinkSync(filePath); } catch {}
}

function dataUrl(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

async function scoreImage(filePath: string, prompt: string): Promise<{ score: number | null; model?: string; error?: string; elapsedMs: number }> {
  const started = Date.now();
  const apiKey = getSetting("GOOGLE_API_KEY").trim();
  if (!apiKey) return { score: null, error: "GOOGLE_API_KEY is not configured", elapsedMs: Date.now() - started };

  try {
    const buf = fs.readFileSync(filePath);
    if (!buf.length) return { score: null, error: "Generated image file is empty", elapsedMs: Date.now() - started };
    const mime = filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    const instruction =
      `You are quality-checking ONE AI-generated image for a documentary/YouTube B-roll scene.\n` +
      `WANTED VISUAL: "${prompt.slice(0, 900)}"\n` +
      `Score 0-100: does the image accurately match the wanted visual, look photorealistic and high quality, ` +
      `and contain no unwanted readable text, gibberish labels, obvious anatomy errors, broken objects, or unrelated subjects? ` +
      `Return STRICTLY JSON {"score":<int>}. No markdown.`;
    const model = getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL");
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: instruction }, { inline_data: { mime_type: mime, data: buf.toString("base64") } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
    });
    const { json, model: usedModel } = await callGemini({
      apiKey,
      model,
      body,
      maxAttempts: 1,
      allowModelFallback: false,
      timeoutMs: 30_000,
    });
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as { score?: number };
    const score = Number.isFinite(parsed.score) ? Math.max(0, Math.min(100, Number(parsed.score))) : null;
    return { score, model: usedModel, elapsedMs: Date.now() - started, ...(score === null ? { error: "Gemini returned no numeric score" } : {}) };
  } catch (e) {
    return { score: null, error: (e as Error).message.slice(0, 240), elapsedMs: Date.now() - started };
  }
}

function simulationResult(simulation: Exclude<Simulation, "none">, threshold: number) {
  const common = {
    ok: true,
    mode: "simulation" as const,
    simulation,
    threshold,
    configuredProfiles: getCloudflareProfileSummaries(),
    externalCalls: { cloudflare: false, gemini: false, kie: false, ai33: false, groq: false },
  };

  if (simulation === "3040") {
    return {
      ...common,
      cloudflare: { success: false, status: 429, code: 3040, message: "Out of capacity", retries: ["retry 2/3 after 2s", "retry 3/3 after 5s"] },
      fallback: { wouldUseKie: true, called: false },
      action: "Temporary capacity issue: retry the current profile up to 3 attempts, then try the next configured backup profile. If every operational profile fails, use Kie only for this beat and keep Cloudflare enabled for later beats.",
    };
  }
  if (simulation === "3036" || simulation === "4006") {
    const code = Number(simulation);
    return {
      ...common,
      cloudflare: { success: false, status: 429, code, message: "Daily free allocation exhausted", retries: [], failovers: [] },
      fallback: { wouldUseKie: true, called: false },
      action: `Daily free allocation exhausted (${code}): use Kie and disable Cloudflare for the remainder of the current video run. Backup Cloudflare profiles are NOT used for quota exhaustion.`,
    };
  }
  if (simulation === "401" || simulation === "403") {
    return {
      ...common,
      cloudflare: { success: false, status: Number(simulation), message: "Credentials/permissions rejected", retries: [] },
      fallback: { wouldUseKie: true, called: false },
      action: "Credential/permission problem: mark that profile unavailable for this run and try the next configured backup. Only if no usable Cloudflare profile remains does production fall back to Kie.",
    };
  }
  return {
    ...common,
    cloudflare: { success: false, status: 500, message: "Temporary Cloudflare server error", retries: [] },
    fallback: { wouldUseKie: true, called: false },
    action: "Temporary server error: try the next configured backup profile. If all operational profiles fail, use Kie for this beat only. Cloudflare remains enabled for later beats.",
  };
}

export async function POST(req: Request) {
  ensureInit();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const simulation: Simulation = body.simulation || "none";
  const threshold = Math.max(0, Math.min(100, Number.isFinite(body.threshold) ? Number(body.threshold) : 75));
  if (simulation !== "none") return NextResponse.json(simulationResult(simulation, threshold));

  const prompt = String(body.prompt || "").trim();
  if (!prompt) return NextResponse.json({ error: "Enter a prompt before generating." }, { status: 400 });
  if (!cloudflareImageConfigured()) {
    return NextResponse.json({ error: "Cloudflare Account ID / API Token are not configured in Settings." }, { status: 400 });
  }

  const aspectRatio = body.aspectRatio === "9:16" ? "9:16" : "16:9";
  const id = randomUUID().slice(0, 8);
  const cfPath = path.join(os.tmpdir(), `provider-test-cf-${id}.png`);
  const kiePath = path.join(os.tmpdir(), `provider-test-kie-${id}.png`);
  const retries: Array<CloudflareRetryInfo & { atMs: number }> = [];
  const failovers: Array<CloudflareProfileFailoverInfo & { atMs: number }> = [];
  const started = Date.now();

  let cfSuccess = false;
  let cfError: CloudflareImageError | null = null;
  let cfImageDataUrl: string | undefined;
  let cfScore: Awaited<ReturnType<typeof scoreImage>> | undefined;
  let usedProfile: { profileId: string; profileLabel: string } | undefined;

  try {
    usedProfile = await generateCloudflareImage("", prompt, cfPath, aspectRatio, {
      onRetry: (info) => retries.push({ ...info, atMs: Date.now() - started }),
      onProfileFailover: (info) => failovers.push({ ...info, atMs: Date.now() - started }),
    });
    cfSuccess = true;
    cfImageDataUrl = dataUrl(cfPath);
    if (body.runGeminiScore) cfScore = await scoreImage(cfPath, prompt);
  } catch (e) {
    cfError = e instanceof CloudflareImageError
      ? e
      : new CloudflareImageError(e instanceof Error ? e.message : String(e));
  }

  const scoreFailed = body.runGeminiScore && cfSuccess && cfScore?.score !== null && cfScore?.score !== undefined && cfScore.score < threshold;
  const shouldFallback = !cfSuccess || Boolean(scoreFailed);
  let kieCalled = false;
  let kieImageDataUrl: string | undefined;
  let kieScore: Awaited<ReturnType<typeof scoreImage>> | undefined;
  let kieError: string | undefined;
  let kieElapsedMs: number | undefined;

  if (shouldFallback && body.actuallyCallKieFallback) {
    kieCalled = true;
    const kieStarted = Date.now();
    try {
      const url = await generateImageUrl("", prompt, aspectRatio);
      await downloadKie(url, kiePath);
      kieImageDataUrl = dataUrl(kiePath);
      if (body.runGeminiScore) kieScore = await scoreImage(kiePath, prompt);
    } catch (e) {
      kieError = (e as Error).message.slice(0, 300);
    } finally {
      kieElapsedMs = Date.now() - kieStarted;
    }
  }

  const cfElapsedMs = Date.now() - started - (kieElapsedMs || 0);
  const result = {
    ok: true,
    mode: "real" as const,
    threshold,
    aspectRatio,
    model: getSetting("CLOUDFLARE_IMAGE_MODEL") || "@cf/black-forest-labs/flux-2-klein-4b",
    configuredProfiles: getCloudflareProfileSummaries(),
    totalElapsedMs: Date.now() - started,
    cloudflare: cfSuccess
      ? {
          success: true,
          elapsedMs: cfElapsedMs,
          retries,
          failovers,
          profileId: usedProfile?.profileId,
          profileLabel: usedProfile?.profileLabel,
          imageDataUrl: cfImageDataUrl,
          score: cfScore?.score ?? null,
          scoreModel: cfScore?.model,
          scoreError: cfScore?.error,
          passed: body.runGeminiScore && cfScore?.score !== null && cfScore?.score !== undefined ? cfScore.score >= threshold : null,
        }
      : {
          success: false,
          elapsedMs: cfElapsedMs,
          retries,
          failovers,
          profileId: cfError?.profileId,
          profileLabel: cfError?.profileLabel,
          dailyQuotaExhausted: isCloudflareDailyQuotaError(cfError),
          status: cfError?.status,
          code: cfError?.cfCode,
          message: cfError?.cfMessage || cfError?.message || "Cloudflare generation failed",
        },
    fallback: {
      wouldUseKie: shouldFallback,
      called: kieCalled,
      elapsedMs: kieElapsedMs,
      imageDataUrl: kieImageDataUrl,
      score: kieScore?.score ?? null,
      scoreModel: kieScore?.model,
      scoreError: kieScore?.error,
      error: kieError,
    },
    action: !shouldFallback
      ? body.runGeminiScore
        ? "Cloudflare image passed the configured score threshold. Production would use this image and avoid Kie."
        : "Cloudflare generated successfully. Gemini scoring was disabled, so this test stopped before any paid fallback."
      : isCloudflareDailyQuotaError(cfError)
        ? "Cloudflare daily allocation is exhausted. Production does NOT rotate to backup Cloudflare accounts for quota exhaustion; it moves to the normal provider fallback (Kie)."
        : body.actuallyCallKieFallback
          ? "Production fallback condition was met and the paid Kie fallback was explicitly enabled for this test."
          : "Production fallback condition was met, but Kie was NOT called because paid fallback is disabled in the test page.",
    externalCalls: {
      cloudflare: true,
      gemini: Boolean(body.runGeminiScore && (cfSuccess || kieCalled)),
      kie: kieCalled,
      ai33: false,
      groq: false,
    },
  };

  cleanTemp(cfPath);
  cleanTemp(kiePath);
  return NextResponse.json(result);
}

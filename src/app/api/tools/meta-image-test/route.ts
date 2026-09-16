import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { callGemini } from "@/lib/services/gemini-models";
import { generateImageUrl, downloadKie } from "@/lib/services/kie";
import { generateMetaImage, MetaImageError } from "@/lib/services/meta-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  prompt?: string;
  aspectRatio?: "16:9" | "9:16";
  threshold?: number;
  runGeminiScore?: boolean;
  actuallyCallKieFallback?: boolean;
  metaApiKey?: string;
  metaBaseUrl?: string;
  metaModel?: string;
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
    const instruction =
      `You are quality-checking ONE AI-generated image for a documentary/YouTube B-roll scene.\n` +
      `WANTED VISUAL: "${prompt.slice(0, 900)}"\n` +
      `Score 0-100: does the image accurately match the wanted visual, look photorealistic and high quality, ` +
      `and contain no unwanted readable text, gibberish labels, obvious anatomy errors, broken objects, or unrelated subjects? ` +
      `Return STRICTLY JSON {"score":<int>}. No markdown.`;
    const model = getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL");
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: instruction }, { inline_data: { mime_type: "image/png", data: buf.toString("base64") } }] }],
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

export async function POST(req: Request) {
  ensureInit();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const prompt = String(body.prompt || "").trim();
  const apiKey = String(body.metaApiKey || "").trim();
  if (!prompt) return NextResponse.json({ error: "Enter a prompt before generating." }, { status: 400 });
  if (!apiKey) return NextResponse.json({ error: "Enter your Meta API key before generating." }, { status: 400 });

  const aspectRatio = body.aspectRatio === "9:16" ? "9:16" : "16:9";
  const threshold = Math.max(0, Math.min(100, Number.isFinite(body.threshold) ? Number(body.threshold) : 75));
  const id = randomUUID().slice(0, 8);
  const metaPath = path.join(os.tmpdir(), `provider-test-meta-${id}.png`);
  const kiePath = path.join(os.tmpdir(), `provider-test-kie-${id}.png`);
  const started = Date.now();

  let metaSuccess = false;
  let metaError: MetaImageError | null = null;
  let imageDataUrl: string | undefined;
  let score: Awaited<ReturnType<typeof scoreImage>> | undefined;
  let model = String(body.metaModel || "").trim() || "muse-image-1.0";
  let baseUrl = String(body.metaBaseUrl || "").trim() || "https://api.meta.ai/v1";

  try {
    const info = await generateMetaImage(prompt, metaPath, aspectRatio, { apiKey, baseUrl, model });
    model = info.model;
    baseUrl = info.baseUrl;
    metaSuccess = true;
    imageDataUrl = dataUrl(metaPath);
    if (body.runGeminiScore) score = await scoreImage(metaPath, prompt);
  } catch (e) {
    metaError = e instanceof MetaImageError ? e : new MetaImageError(e instanceof Error ? e.message : String(e));
  }

  const scoreFailed = body.runGeminiScore && metaSuccess && score?.score !== null && score?.score !== undefined && score.score < threshold;
  const shouldFallback = !metaSuccess || Boolean(scoreFailed);

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

  const metaElapsedMs = Date.now() - started - (kieElapsedMs || 0);
  const result = {
    ok: true,
    provider: "meta" as const,
    providerLabel: "Meta Muse Image",
    threshold,
    aspectRatio,
    model,
    baseUrl,
    totalElapsedMs: Date.now() - started,
    meta: metaSuccess
      ? {
          success: true,
          elapsedMs: metaElapsedMs,
          imageDataUrl,
          score: score?.score ?? null,
          scoreModel: score?.model,
          scoreError: score?.error,
          passed: body.runGeminiScore && score?.score !== null && score?.score !== undefined ? score.score >= threshold : null,
        }
      : {
          success: false,
          elapsedMs: metaElapsedMs,
          status: metaError?.status,
          code: metaError?.metaCode,
          message: metaError?.metaDetails || metaError?.message || "Meta image generation failed",
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
        ? "Muse Image passed the configured score threshold. Production could use this image and avoid Kie."
        : "Muse Image generated successfully. Gemini scoring was disabled, so this test stopped before any paid fallback."
      : body.actuallyCallKieFallback
        ? "Muse Image failed or missed the score threshold and the paid Kie fallback was explicitly enabled for this test."
        : "Muse Image failed or missed the score threshold, but Kie was NOT called because paid fallback is disabled.",
    externalCalls: {
      meta: true,
      gemini: Boolean(body.runGeminiScore && (metaSuccess || kieCalled)),
      kie: kieCalled,
      ai33: false,
      groq: false,
    },
  };

  cleanTemp(metaPath);
  cleanTemp(kiePath);
  return NextResponse.json(result);
}

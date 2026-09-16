import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { callGemini } from "@/lib/services/gemini-models";
import { generateImageUrl, downloadKie } from "@/lib/services/kie";
import { generatePollinationsImage, PollinationsImageError } from "@/lib/services/pollinations-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  prompt?: string;
  aspectRatio?: "16:9" | "9:16";
  threshold?: number;
  runGeminiScore?: boolean;
  actuallyCallKieFallback?: boolean;
  apiKey?: string;
  model?: string;
};

function cleanTemp(filePath: string) { try { fs.unlinkSync(filePath); } catch {} }
function dataUrl(filePath: string) { return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`; }

async function scoreImage(filePath: string, prompt: string): Promise<{ score: number | null; model?: string; error?: string }> {
  const apiKey = getSetting("GOOGLE_API_KEY").trim();
  if (!apiKey) return { score: null, error: "GOOGLE_API_KEY is not configured" };
  try {
    const buf = fs.readFileSync(filePath);
    const instruction = `You are quality-checking ONE AI-generated image for a documentary/YouTube B-roll scene.\nWANTED VISUAL: "${prompt.slice(0, 900)}"\nScore 0-100: does the image accurately match the wanted visual, look photorealistic and high quality, and contain no unwanted readable text, gibberish labels, obvious anatomy errors, broken objects, or unrelated subjects? Return STRICTLY JSON {"score":<int>}. No markdown.`;
    const model = getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL");
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: instruction }, { inline_data: { mime_type: "image/png", data: buf.toString("base64") } }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
    });
    const { json, model: usedModel } = await callGemini({ apiKey, model, body, maxAttempts: 1, allowModelFallback: false, timeoutMs: 30_000 });
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as { score?: number };
    const score = Number.isFinite(parsed.score) ? Math.max(0, Math.min(100, Number(parsed.score))) : null;
    return { score, model: usedModel, ...(score === null ? { error: "Gemini returned no numeric score" } : {}) };
  } catch (e) {
    return { score: null, error: (e as Error).message.slice(0, 240) };
  }
}

export async function POST(req: Request) {
  ensureInit();
  let body: Body;
  try { body = (await req.json()) as Body; } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const prompt = String(body.prompt || "").trim();
  const apiKey = String(body.apiKey || getSetting("POLLINATIONS_API_KEY") || "").trim();
  const model = String(body.model || getSetting("POLLINATIONS_IMAGE_MODEL") || "zimage").trim() || "zimage";
  if (!prompt) return NextResponse.json({ error: "Enter a prompt before generating." }, { status: 400 });
  if (!apiKey) return NextResponse.json({ error: "Enter a Pollinations API key or save one in Settings." }, { status: 400 });

  const aspectRatio = body.aspectRatio === "9:16" ? "9:16" : "16:9";
  const threshold = Math.max(0, Math.min(100, Number.isFinite(body.threshold) ? Number(body.threshold) : 75));
  const id = randomUUID().slice(0, 8);
  const pollPath = path.join(os.tmpdir(), `provider-test-poll-${id}.png`);
  const kiePath = path.join(os.tmpdir(), `provider-test-kie-${id}.png`);
  const started = Date.now();

  let success = false;
  let error: PollinationsImageError | null = null;
  let imageDataUrl: string | undefined;
  let score: Awaited<ReturnType<typeof scoreImage>> | undefined;
  try {
    await generatePollinationsImage(prompt, pollPath, aspectRatio, { apiKey, model });
    success = true;
    imageDataUrl = dataUrl(pollPath);
    if (body.runGeminiScore) score = await scoreImage(pollPath, prompt);
  } catch (e) {
    error = e instanceof PollinationsImageError ? e : new PollinationsImageError(e instanceof Error ? e.message : String(e));
  }

  const scoreFailed = body.runGeminiScore && success && score?.score !== null && score?.score !== undefined && score.score < threshold;
  const shouldFallback = !success || Boolean(scoreFailed);
  let kieCalled = false;
  let kieImageDataUrl: string | undefined;
  let kieError: string | undefined;
  if (shouldFallback && body.actuallyCallKieFallback) {
    kieCalled = true;
    try {
      const url = await generateImageUrl("", prompt, aspectRatio);
      await downloadKie(url, kiePath);
      kieImageDataUrl = dataUrl(kiePath);
    } catch (e) { kieError = (e as Error).message.slice(0, 300); }
  }

  const result = {
    ok: true,
    model,
    threshold,
    totalElapsedMs: Date.now() - started,
    pollinations: success ? {
      success: true, imageDataUrl, score: score?.score ?? null, scoreModel: score?.model, scoreError: score?.error,
      passed: body.runGeminiScore && score?.score !== null && score?.score !== undefined ? score.score >= threshold : null,
    } : {
      success: false, status: error?.status, code: error?.pollinationsCode, message: error?.pollinationsDetails || error?.message,
    },
    fallback: { wouldUseKie: shouldFallback, called: kieCalled, imageDataUrl: kieImageDataUrl, error: kieError },
    externalCalls: { pollinations: true, gemini: Boolean(body.runGeminiScore && success), kie: kieCalled, ai33: false, groq: false },
  };

  cleanTemp(pollPath); cleanTemp(kiePath);
  return NextResponse.json(result);
}

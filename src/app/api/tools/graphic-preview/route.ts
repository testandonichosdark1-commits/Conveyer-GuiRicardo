import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { GRAPHIC_TEMPLATE_KEYS, GRAPHIC_TEMPLATES, isGraphicTemplateKey, syntheticWords, validateGraphicData } from "@/lib/services/graphic-templates";
import { GraphicRenderError, renderGraphicClip, renderGraphicFrame } from "@/lib/services/graphic-renderer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /tools/graphic-preview backend: render one graphic template, either a single PNG frame
 * or a short silent MP4. Local, free, isolated — no run row, no provider call, no DB write.
 * Word timings are synthetic (the narration line spread evenly over the clip).
 */

type Body = {
  template?: string;
  data?: unknown;
  narration?: string;
  durationSec?: number;
  mode?: "frame" | "clip";
  atMs?: number;
};

export async function GET() {
  return NextResponse.json({
    templates: GRAPHIC_TEMPLATE_KEYS.map((key) => ({
      key,
      label: GRAPHIC_TEMPLATES[key].label,
      sample: GRAPHIC_TEMPLATES[key].sample,
      sampleNarration: GRAPHIC_TEMPLATES[key].sampleNarration,
    })),
  });
}

export async function POST(req: Request) {
  ensureInit();
  let body: Body;
  try { body = (await req.json()) as Body; } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }

  const template = String(body.template || "");
  if (!isGraphicTemplateKey(template)) return NextResponse.json({ error: `Unknown template "${template}".` }, { status: 400 });
  const v = validateGraphicData(template, body.data);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const durationSec = Math.min(30, Math.max(1, Number(body.durationSec) || 6));
  const words = syntheticWords(String(body.narration || ""), durationSec * 1000);
  const input = { template, data: v.data, words, durationSec, width: 1920, height: 1080 };

  const started = Date.now();
  try {
    if (body.mode === "frame") {
      const atMs = Math.max(0, Number(body.atMs) || 0);
      const png = await renderGraphicFrame({ ...input, atMs });
      return NextResponse.json({ kind: "frame", atMs, ms: Date.now() - started, dataUrl: `data:image/png;base64,${png.toString("base64")}` });
    }
    const out = path.join(os.tmpdir(), `graphic-preview-${randomUUID()}.mp4`);
    try {
      const r = await renderGraphicClip({ ...input, outPath: out });
      const mp4 = fs.readFileSync(out);
      return NextResponse.json({ kind: "clip", frames: r.frames, ms: r.ms, bytes: mp4.length, dataUrl: `data:video/mp4;base64,${mp4.toString("base64")}` });
    } finally {
      try { fs.unlinkSync(out); } catch {}
    }
  } catch (e) {
    const status = e instanceof GraphicRenderError ? 422 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

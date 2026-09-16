import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { getRunDir } from "@/lib/run-paths";

const getRun = db.prepare("SELECT id FROM runs WHERE id = ?");

interface SceneAsset {
  index: number;
  audio?: { name: string; size: number };
  image?: { name: string; size: number };
  animation?: { name: string; size: number };
  clip?: { name: string; size: number };
}

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  if (!getRun.get(id)) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const runDir = getRunDir(id);
  if (!fs.existsSync(runDir)) {
    return NextResponse.json({ runDir, scenes: [], finalExists: false, finalSize: 0 });
  }

  const scenes = new Map<number, SceneAsset>();
  function take(rel: string): { name: string; size: number } | undefined {
    const full = path.join(runDir, rel);
    if (!fs.existsSync(full)) return undefined;
    return { name: path.basename(rel), size: fs.statSync(full).size };
  }
  function ensureScene(i: number) {
    if (!scenes.has(i)) scenes.set(i, { index: i });
    return scenes.get(i)!;
  }
  function scanDir(sub: string, key: "audio" | "image" | "animation" | "clip") {
    const dir = path.join(runDir, sub);
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/(?:scene|clip)_(\d+)\./);
      if (!m) continue;
      const idx = Number(m[1]);
      const asset = take(path.join(sub, f));
      if (asset) ensureScene(idx)[key] = asset;
    }
  }
  scanDir("audio", "audio");
  scanDir("images", "image");
  scanDir("animations", "animation");
  scanDir("clips", "clip");

  const final = take("final.mp4");

  return NextResponse.json({
    runDir,
    scenes: [...scenes.values()].sort((a, b) => a.index - b.index),
    finalExists: !!final,
    finalSize: final?.size ?? 0,
  });
}

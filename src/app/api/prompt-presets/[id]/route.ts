import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import {
  getPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
} from "@/lib/prompts";

function parseId(idStr: string): number | null {
  const id = Number(idStr);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id: idStr } = await params;
  const id = parseId(idStr);
  if (id == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const preset = getPromptPreset(id);
  if (!preset) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(preset);
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id: idStr } = await params;
  const id = parseId(idStr);
  if (id == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  let body: {
    name?: string;
    content?: string;
    description?: string | null;
    animation_motion?: string | null;
    image_prompt?: string | null;
    heygen_voice_id?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  const content = body.content ?? "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!content.trim()) return NextResponse.json({ error: "content is required" }, { status: 400 });

  try {
    updatePromptPreset(id, {
      name,
      content,
      description: body.description,
      animation_motion: body.animation_motion,
      image_prompt: body.image_prompt,
      heygen_voice_id: body.heygen_voice_id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("unique")) {
      return NextResponse.json({ error: `A channel named "${name}" already exists` }, { status: 409 });
    }
    if (msg.includes("not found")) {
      return NextResponse.json({ error: "Channel profile not found" }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id: idStr } = await params;
  const id = parseId(idStr);
  if (id == null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  deletePromptPreset(id);
  return NextResponse.json({ ok: true });
}

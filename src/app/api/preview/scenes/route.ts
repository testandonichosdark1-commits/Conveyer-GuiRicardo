import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { splitScriptPreview } from "@/lib/services/scene-split";
import { getPromptPreset } from "@/lib/prompts";

interface Body {
  script?: string;
  /** Optional: Prompt Preset id. If set, preview uses preset's content as the system prompt. */
  presetId?: number | null;
}

/**
 * Splits a script into scenes WITHOUT creating a run in the DB. Used by the
 * New Run page to show the user a preview of scenes before committing to a
 * pipeline run — so they can browse the library and pick reusable clips.
 */
export async function POST(req: Request) {
  ensureInit();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const script = (body.script ?? "").trim();
  if (!script) {
    return NextResponse.json({ error: "script is empty" }, { status: 400 });
  }

  // Resolve preset content if presetId was passed
  let overridePrompt: string | undefined;
  if (typeof body.presetId === "number" && body.presetId > 0) {
    const preset = getPromptPreset(body.presetId);
    if (preset) overridePrompt = preset.content;
  }

  try {
    const scenes = await splitScriptPreview(script, overridePrompt);
    return NextResponse.json({ scenes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

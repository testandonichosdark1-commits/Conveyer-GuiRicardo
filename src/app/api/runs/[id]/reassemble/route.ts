import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { resumeRun, canResumeRun } from "@/lib/pipeline";
import { resumeStudioPipeline, canResumeStudioRun, getRunMode } from "@/lib/studio-pipeline";
import { isRunActive, failRun } from "@/lib/run-lifecycle";

/**
 * Resume a failed / partial run.
 *
 * Studio (avatar-documentary) runs resume via the studio pipeline: reuse the saved
 * voiceover + beats.json and every beat clip already on disk, regenerate ONLY the
 * missing ones, then reassemble. Faceless scene-split runs use the legacy path
 * (scenes.json). Work runs in the background; the run page streams the logs.
 *
 * (URL is `/reassemble` for legacy reasons — the user-facing action is "Resume".)
 */
export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;

  // Duplicate-Resume guard: if this run's pipeline is already executing in this
  // process, refuse to start a second one (which would double-spend HeyGen/AI
  // credits). The in-memory lock is authoritative — the pipeline runs in-process.
  if (isRunActive(id)) {
    return NextResponse.json(
      { error: "This run is already generating — Resume is unavailable until it stops." },
      { status: 409 }
    );
  }

  // Studio run → beats-based resume.
  if (getRunMode(id) === "studio") {
    if (!canResumeStudioRun(id)) {
      return NextResponse.json(
        {
          error:
            "This studio run can't be resumed — its voiceover or beat plan (beats.json) isn't on disk, " +
            "which means it failed before those were produced. Start a fresh run instead.",
        },
        { status: 400 }
      );
    }
    resumeStudioPipeline(id).catch((e) => {
      // Backstop for a rejection that escaped the resume pipeline's own
      // try/catch/finally: mark the run failed + release its lock in-process.
      const msg = e instanceof Error ? e.message : String(e);
      failRun(id, `Resume failed to start or crashed unexpectedly: ${msg}`);
      // eslint-disable-next-line no-console
      console.error("studio resume crash", e);
    });
    return NextResponse.json({ ok: true });
  }

  if (!canResumeRun(id)) {
    return NextResponse.json(
      {
        error:
          "This run can't be resumed — there's no saved scene plan (scenes.json) on disk, " +
          "which usually means it failed before scene-splitting finished. Start a fresh run instead.",
      },
      { status: 400 }
    );
  }

  // Fire-and-forget — the run page streams logs over SSE.
  resumeRun(id).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    failRun(id, `Resume failed to start or crashed unexpectedly: ${msg}`);
    // eslint-disable-next-line no-console
    console.error("resume crash", e);
  });

  return NextResponse.json({ ok: true });
}

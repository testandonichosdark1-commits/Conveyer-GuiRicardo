// DEPRECATED in Conveyer Grok.
//
// This CLI was inherited from Conveyer Isabell (Ken-Burns-on-images flow:
// images + audio → final.mp4 reassembled outside the dev server). Conveyer
// Grok is video-only — every scene is a Grok clip in `animations/`, not a
// still image — so this script's logic (reads `images/*.png`, runs Ken-Burns
// in ffmpeg) does not apply and would produce a broken output.
//
// A Conveyer-Grok-aware standalone reassemble would concat existing
// `animations/scene_N.mp4` clips with `audio/scene_N.mp3` and apply xfade —
// effectively a CLI mirror of `src/lib/services/video-assemble.ts`. TODO if
// it ever becomes needed; for now we just bail with a clear message.
console.error(
  "scripts/reassemble.mjs is disabled in Conveyer Grok (video-only flow).\n" +
    "If a run failed mid-pipeline, just re-run it from the web UI — library reuse\n" +
    "picks up any scenes whose clips already exist on Drive."
);
process.exit(1);

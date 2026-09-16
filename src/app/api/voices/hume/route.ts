import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";

interface HumeVoice {
  id?: string;
  name?: string;
  provider?: string;
  compatible_octave_models?: string[];
}

/** Pages through GET /v0/tts/voices for ONE provider. `error` is returned rather than
 *  thrown so a failure on one side (e.g. no custom voices) can't blank the other. */
async function listVoices(
  key: string,
  provider: "HUME_AI" | "CUSTOM_VOICE"
): Promise<{ voices: HumeVoice[]; error?: string }> {
  const out: HumeVoice[] = [];
  const MAX_PAGES = 3; // 300 voices — plenty for a dropdown, and bounded.
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ provider, page_number: String(page), page_size: "100" });
    const r = await fetch(`https://api.hume.ai/v0/tts/voices?${qs}`, {
      headers: { "X-Hume-Api-Key": key, Accept: "application/json" },
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 200);
      return {
        voices: out,
        error:
          r.status === 401 || r.status === 403
            ? "Hume rejected the API key — check HUME_API_KEY."
            : `Hume ${r.status}: ${detail}`,
      };
    }
    const j = (await r.json()) as { voices_page?: HumeVoice[]; total_pages?: number };
    out.push(...(j.voices_page ?? []));
    if (page + 1 >= (j.total_pages ?? 1)) break;
  }
  return { voices: out };
}

/**
 * List Hume voices for the "Load voices" picker.
 *
 * Hume splits voices across TWO providers and `GET /v0/tts/voices` requires you to pick
 * one — but a voice referenced by `id` in a TTS request needs no provider at all. So both
 * lists are fetched and merged into one dropdown, each option labelled with its origin,
 * and only the bare UUID is stored. That is what keeps "Voice Library voice" and "custom
 * voice" from being confusable state: they differ in the label, not in what is persisted,
 * so neither can be saved in a form the TTS call can't resolve.
 *
 * Octave compatibility is surfaced, not enforced: Octave-1 voices run on both generations
 * while Octave-2 voices need version 2, so when HUME_VERSION is pinned, any voice whose
 * `compatible_octave_models` doesn't include it is flagged in its label. The check matches
 * on the version DIGIT so it holds whatever spelling Hume uses ("octave-2" / "OCTAVE_2"),
 * and it stays advisory — a wrong guess about that enum must never hide a usable voice.
 */
export async function GET() {
  ensureInit();
  const key = getSetting("HUME_API_KEY");
  if (!key) return NextResponse.json({ error: "HUME_API_KEY not set" }, { status: 400 });
  const version = getSetting("HUME_VERSION").trim();

  try {
    const [library, custom] = await Promise.all([listVoices(key, "HUME_AI"), listVoices(key, "CUSTOM_VOICE")]);

    // Only a total failure is an error; one empty side is normal (a new account has no
    // custom voices) and must still show the other side.
    if (library.voices.length === 0 && custom.voices.length === 0) {
      const err = library.error ?? custom.error;
      if (err) return NextResponse.json({ error: err }, { status: 502 });
    }

    const seen = new Set<string>();
    const voices: { voice_id: string; name: string }[] = [];
    for (const [list, origin] of [
      [custom.voices, "yours"],
      [library.voices, "library"],
    ] as const) {
      for (const v of list) {
        if (!v.id || seen.has(v.id)) continue;
        seen.add(v.id);
        const compat = v.compatible_octave_models ?? [];
        const incompatible =
          (version === "1" || version === "2") && compat.length > 0 && !compat.some((m) => m.includes(version));
        voices.push({
          voice_id: v.id,
          name: `${v.name ?? v.id} · ${origin}${compat.length ? ` · Octave ${compat.join("/")}` : ""}${
            incompatible ? ` ⚠ needs Octave ${compat.join("/")}, you selected ${version}` : ""
          }`,
        });
      }
    }
    return NextResponse.json({ voices });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

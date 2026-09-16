import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";

interface FishModel {
  _id?: string;
  title?: string;
  languages?: string[];
  author?: { nickname?: string };
}

/** One page of GET /model. Returns [] rather than throwing so one failed half can't
 *  empty the whole picker (the operator's own voices matter more than the public list). */
async function listModels(key: string, params: Record<string, string>): Promise<FishModel[]> {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`https://api.fish.audio/model?${qs}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { items?: FishModel[] };
  return j.items ?? [];
}

/**
 * List Fish Audio voices for the "Load voices" picker.
 *
 * A Fish "voice" IS a MODEL (GET /model), and its `_id` is the stable identifier the TTS
 * call sends as `reference_id` — so that is exactly what the picker writes into
 * FISHAUDIO_VOICE_ID. Nothing derived from the title is stored, so renaming a voice on
 * fish.audio can't invalidate a saved channel.
 *
 * Two pages are merged: the account's OWN models first (`self=true` — clones and saved
 * voices, the ones an operator expects to see), then the popular public library. Without
 * the public half a fresh account gets an empty dropdown and no way to proceed but to
 * paste an id by hand; without the self half the operator's own clone is buried. Each
 * option says which side it came from.
 */
export async function GET() {
  ensureInit();
  const key = getSetting("FISHAUDIO_API_KEY");
  if (!key) return NextResponse.json({ error: "FISHAUDIO_API_KEY not set" }, { status: 400 });
  try {
    const [own, publicModels] = await Promise.all([
      listModels(key, { page_size: "100", page_number: "1", self: "true" }),
      listModels(key, { page_size: "100", page_number: "1", sort_by: "task_count" }),
    ]);

    // Probe with a cheap authenticated call so a bad key is reported as a bad key rather
    // than as "no voices" — both halves above swallow their errors by design.
    if (own.length === 0 && publicModels.length === 0) {
      const probe = await fetch("https://api.fish.audio/model?page_size=1", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!probe.ok) {
        const detail = (await probe.text()).slice(0, 200);
        return NextResponse.json(
          {
            error:
              probe.status === 401
                ? "Fish Audio rejected the API key (401) — check FISHAUDIO_API_KEY."
                : `Fish Audio ${probe.status}: ${detail}`,
          },
          { status: 502 }
        );
      }
    }

    const seen = new Set<string>();
    const voices: { voice_id: string; name: string }[] = [];
    for (const [models, origin] of [
      [own, "yours"],
      [publicModels, "library"],
    ] as const) {
      for (const m of models) {
        const id = m._id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const langs = (m.languages ?? []).slice(0, 2).join("/");
        voices.push({
          voice_id: id,
          name: `${m.title ?? id}${langs ? ` · ${langs}` : ""} · ${origin}`,
        });
      }
    }
    return NextResponse.json({ voices });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

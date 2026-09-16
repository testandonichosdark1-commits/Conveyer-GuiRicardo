"use client";
import { useT } from "../../_i18n";
import type { Val, Set } from "./useSettings";

/**
 * 69labs VOICE ENGINE — which engine behind the 69labs gateway synthesizes the narration.
 * Writes the existing TTS_VOICE_PROVIDER setting (edgetts | elevenlabs | voice-clone), the
 * same key `labs69Tts()` reads and sends as `voiceProvider` on /tts/generate.
 *
 * It exists because the key had NO form field anywhere: every install was pinned to the
 * "edgetts" default, so pasting an ElevenLabs voice ID into the 69labs voice field sent it
 * to the Edge engine and 69labs answered "This Edge TTS voice ID was not found."
 *
 * Default stays "edgetts" and nothing is migrated — an existing Edge user who never touches
 * this control keeps the exact behaviour they have today.
 */
export const LABS69_ENGINES = ["edgetts", "elevenlabs", "voice-clone"] as const;
export type Labs69Engine = (typeof LABS69_ENGINES)[number];

/** Read TTS_VOICE_PROVIDER as one of the three canonical values; anything else → edgetts. */
export function labs69Engine(raw: string): Labs69Engine {
  const v = (raw || "edgetts").toLowerCase();
  return v === "elevenlabs" ? "elevenlabs" : v === "voice-clone" ? "voice-clone" : "edgetts";
}

const OPTIONS = [
  { v: "edgetts", fr: "Edge TTS", en: "Edge TTS" },
  { v: "elevenlabs", fr: "ElevenLabs", en: "ElevenLabs" },
  { v: "voice-clone", fr: "Clone vocal", en: "Voice Clone" },
] as const;

export function Labs69VoiceEngine({ val, set }: { val: Val; set: Set }) {
  const tr = useT();
  const current = labs69Engine(val("TTS_VOICE_PROVIDER"));

  return (
    <div>
      <label className="label">{tr("Moteur vocal 69labs", "69labs Voice Engine")}</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 2 }}>
        {OPTIONS.map((o) => (
          <label key={o.v} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13.5 }}>
            <input
              type="radio"
              name="TTS_VOICE_PROVIDER"
              value={o.v}
              checked={current === o.v}
              onChange={() => set("TTS_VOICE_PROVIDER", o.v)}
            />
            {tr(o.fr, o.en)}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Which engine a stored voice value OBVIOUSLY belongs to, or "unknown" when we can't tell.
 * Deliberately conservative — only two unmistakable shapes are recognised, so anything we
 * don't positively identify is treated as "unknown" and therefore always displayed. Guessing
 * wrong in the other direction would hide a value the user actually typed.
 */
function detectVoiceIdFormat(value: string): "edge" | "elevenlabs" | "unknown" {
  const s = value.trim();
  if (/^[a-z]{2}-[A-Z]{2}-\S+$/.test(s)) return "edge"; // en-US-GuyNeural, fr-FR-HenriNeural
  if (/^[A-Za-z0-9]{20}$/.test(s)) return "elevenlabs"; // 21m00Tcm4TlvDq8ikWAM
  return "unknown";
}

/**
 * Should the voice-id input RENDER as empty (placeholder only)? True only when the stored value
 * confidently belongs to a DIFFERENT engine than the one selected — e.g. an Edge voice name while
 * ElevenLabs is picked, which otherwise reads as a valid ElevenLabs ID.
 *
 * Display-only. The stored setting is never rewritten or cleared, so a field left untouched still
 * saves exactly what it held before; the user must paste a new ID deliberately.
 */
export function labs69VoiceIdMismatch(engine: Labs69Engine, value: string): boolean {
  const fmt = detectVoiceIdFormat(value);
  if (fmt === "unknown") return false;
  if (engine === "edgetts") return fmt === "elevenlabs";
  if (engine === "elevenlabs") return fmt === "edge";
  return fmt === "edge"; // voice-clone: an Edge voice name is certainly not a clone id
}

/**
 * Warning shown under the voice-id field when a value from ANOTHER engine is still stored but
 * hidden. Without it the field just looks empty, so a user could save and get a failed render
 * with no clue that a stale Edge name is still the value being sent.
 *
 * Derived from the same mismatch check as the hiding itself, so it clears the instant the user
 * types a new value or switches back to the matching engine — there is no separate state to sync.
 * Returns null when there is nothing to warn about.
 */
export function labs69VoiceIdWarning(
  engine: Labs69Engine,
  value: string,
  tr: (fr: string, en: string) => string
): string | null {
  if (!labs69VoiceIdMismatch(engine, value)) return null;
  const stored =
    detectVoiceIdFormat(value) === "edge"
      ? tr("Une voix Edge TTS est toujours enregistrée.", "An Edge TTS voice is still stored.")
      : tr("Une voix ElevenLabs est toujours enregistrée.", "An ElevenLabs voice is still stored.");
  const replace =
    engine === "elevenlabs"
      ? tr("Collez un Voice ID ElevenLabs pour la remplacer.", "Paste an ElevenLabs Voice ID to replace it.")
      : engine === "voice-clone"
        ? tr("Collez un ID de clone vocal 69labs pour la remplacer.", "Paste a 69labs Voice Clone ID to replace it.")
        : tr("Collez un nom de voix Edge TTS pour la remplacer.", "Paste an Edge TTS voice name to replace it.");
  return `${stored} ${replace}`;
}

/** Voice-ID field label + placeholder + hint for the selected 69labs engine (text only). */
export function labs69VoiceIdCopy(engine: Labs69Engine, tr: (fr: string, en: string) => string) {
  if (engine === "elevenlabs") {
    return {
      label: tr("ElevenLabs — Voice ID", "ElevenLabs Voice ID"),
      placeholder: "21m00Tcm4TlvDq8ikWAM",
      hint: tr(
        "L'ID d'une voix de votre bibliothèque ElevenLabs (ex. 21m00Tcm4TlvDq8ikWAM).",
        "The ID of a voice from your ElevenLabs library (example: 21m00Tcm4TlvDq8ikWAM)."
      ),
    };
  }
  if (engine === "voice-clone") {
    return {
      label: tr("69labs — ID de clone vocal", "69labs Voice Clone ID"),
      placeholder: "your_clone_id",
      hint: tr(
        "L'ID du clone vocal créé dans 69labs.",
        "The ID of the voice clone you created inside 69labs."
      ),
    };
  }
  return {
    label: tr("Edge — nom de voix", "Edge voice name"),
    placeholder: "en-US-GuyNeural",
    hint: tr(
      "Un nom de voix Edge TTS (ex. en-US-GuyNeural).",
      "An Edge TTS voice name (example: en-US-GuyNeural)."
    ),
  };
}

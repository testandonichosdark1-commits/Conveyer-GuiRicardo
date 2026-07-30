"use client";
import { voiceProviderMeta } from "@/lib/providers";
import { useT } from "../../_i18n";
import { SettingsField } from "./SettingsField";
import { VoicePicker } from "./VoicePicker";
import type { Val, Set } from "./useSettings";

/**
 * Renders ONLY the selected voice provider's key + voice_id (+ extras), plus the
 * Groq word-timing key when the provider is NOT ElevenLabs. HeyGen narration
 * reuses the Avatar section's key, so it shows a hint instead of duplicating.
 * Groq is a SOFT requirement — shown as required with a warning, never blocks Save.
 */
export function ProviderVoiceFields({ provider, val, set }: { provider: string; val: Val; set: Set }) {
  const tr = useT();
  const meta = voiceProviderMeta(provider);
  const needsGroq = provider !== "elevenlabs";
  const groqEmpty = !val("GROQ_API_KEY").trim();

  return (
    <>
      {provider === "heygen" ? (
        <>
          <VoicePicker label={`${meta.label} — voice_id`} settingKey={meta.voiceIdKey} which="hg" val={val} set={set} />
          <div className="faint" style={{ fontSize: 12 }}>
            {tr(
              "La narration utilise la clé HeyGen (section Avatar ci-dessous).",
              "Narration uses the HeyGen key (Avatar section below)."
            )}
          </div>
        </>
      ) : (
        <>
          <SettingsField label={`${meta.label} — API key`} settingKey={meta.apiKey} val={val} set={set} />
          {meta.voicesEndpoint === "el" ? (
            <VoicePicker label={`${meta.label} — voice_id`} settingKey={meta.voiceIdKey} which="el" val={val} set={set} />
          ) : (
            <SettingsField label={`${meta.label} — voice_id`} settingKey={meta.voiceIdKey} val={val} set={set} />
          )}
          {meta.extraKeys?.map((ek) => <SettingsField key={ek.key} label={ek.label} settingKey={ek.key} val={val} set={set} />)}
        </>
      )}

      {needsGroq && (
        <div>
          <SettingsField
            label={tr("Groq — clé API (timing des mots)", "Groq — API key (word timing)")}
            settingKey="GROQ_API_KEY"
            val={val}
            set={set}
            required
          />
          {groqEmpty && (
            <div className="faint" style={{ fontSize: 12, marginTop: 5, color: "var(--warning)" }}>
              {tr(
                "Recommandé quand la voix ≠ ElevenLabs : sans clé Groq, le minutage voix↔visuel est approximatif (réparti proportionnellement).",
                "Recommended when voice ≠ ElevenLabs: without a Groq key, voice↔visual timing is approximate (spread proportionally)."
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

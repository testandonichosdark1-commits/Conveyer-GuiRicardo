"use client";
import Link from "next/link";
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
  const isVoicebox = provider === "voicebox";
  const needsGroq = provider !== "elevenlabs" && !isVoicebox;
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
      ) : isVoicebox ? (
        <>
          <SettingsField
            label={tr("Voicebox — dossier du checkout", "Voicebox — checkout folder")}
            settingKey="VOICEBOX_DIR"
            val={val}
            set={set}
            placeholder={tr("chemin vers votre clone de github.com/jamiepine/voicebox", "path to your github.com/jamiepine/voicebox checkout")}
          />
          <VoicePicker label={`${meta.label} — voice_id`} settingKey={meta.voiceIdKey} which="vb" val={val} set={set} />
          <div className="faint" style={{ fontSize: 12 }}>
            {tr(
              "Gratuit, tourne en local (pas de clé API). Lancez d'abord ",
              "Free, runs locally (no API key). First run "
            )}
            <code>npm run setup:voicebox</code>
            {tr(
              " une fois, puis créez un profil de voix sur la ",
              " once, then create a voice profile on the "
            )}
            <Link href="/voices">{tr("page Voix", "Voices page")}</Link>.
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

      {isVoicebox && (
        <div className="faint" style={{ fontSize: 12 }}>
          {tr(
            "Le timing des mots utilise d'abord faster-whisper en local (gratuit, configuré à l'étape ci-dessus) ; Groq n'est qu'un filet de sécurité optionnel.",
            "Word timing tries local faster-whisper first (free, set up in the step above); Groq is only an optional safety net."
          )}
        </div>
      )}
    </>
  );
}

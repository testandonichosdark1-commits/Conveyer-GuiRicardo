"use client";
import { voiceProviderMeta, AI84_MODELS, ai84Backend } from "@/lib/providers";
import { useT } from "../../_i18n";
import { SettingsField } from "./SettingsField";
import { VoicePicker } from "./VoicePicker";
import { Labs69VoiceEngine, labs69Engine, labs69VoiceIdCopy, labs69VoiceIdMismatch, labs69VoiceIdWarning } from "./Labs69VoiceEngine";
import type { Val, Set } from "./useSettings";

/**
 * Renders ONLY the selected voice provider's key + voice_id (+ extras). HeyGen
 * narration reuses the Avatar section's key, so it shows a hint instead of duplicating.
 *
 * The Groq word-timing key is NO LONGER here: it used to be shown only when the voice
 * provider ≠ ElevenLabs, but Upload Voiceover always needs Groq (Whisper times the
 * uploaded narration) regardless of the TTS provider — so hiding it behind ElevenLabs
 * made the key unreachable for that feature. It now lives in its own always-visible
 * section in the settings page, decoupled from the provider.
 */
export function ProviderVoiceFields({ provider, val, set }: { provider: string; val: Val; set: Set }) {
  const tr = useT();
  const meta = voiceProviderMeta(provider);
  // 69labs fans out to three engines behind one gateway; the engine picker below writes
  // TTS_VOICE_PROVIDER, and the voice-id field's copy follows the chosen engine (text only —
  // it stays the same TTS_VOICE_ID key, with no added validation).
  const is69labs = provider === "69labs";
  // AI84 fronts two engines; the model picks one, and that decides which voices exist.
  const isAi84 = provider === "ai84";
  const ai84Engine = ai84Backend(val("AI84_MODEL"));
  const engine = labs69Engine(val("TTS_VOICE_PROVIDER"));
  const voiceCopy = labs69VoiceIdCopy(engine, tr);
  // A leftover Edge voice name reads as a plausible ElevenLabs ID, so when the stored value
  // clearly belongs to another engine the field RENDERS empty (placeholder only). Display-only:
  // the setting keeps its value and an untouched field saves byte-identically.
  const voiceIdMismatch = is69labs && labs69VoiceIdMismatch(engine, val(meta.voiceIdKey));
  // Says WHY the field looks empty, so a hidden stale value can't silently ship. Same derived
  // state as the hiding, so it clears the moment the value or the engine changes.
  const voiceIdWarning = is69labs ? labs69VoiceIdWarning(engine, val(meta.voiceIdKey), tr) : null;

  return (
    <>
      {provider === "heygen" ? (
        <>
          <VoicePicker label={`${meta.label} — voice_id`} settingKey={meta.voiceIdKey} which="heygen" val={val} set={set} />
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
          {is69labs && <Labs69VoiceEngine val={val} set={set} />}
          {/* Any provider that can list its voices gets the picker — the operator never has
              to go hunting for an id. 69labs is excluded because its id's expected FORM
              depends on the engine chosen just above, which its own block explains. */}
          {meta.voicesEndpoint && !is69labs ? (
            <div>
              {/* This pair is the GLOBAL voice and the model it is read with, so the picker
                  below still lists one engine at a time — matching them on one page is what
                  stops a cloned voice being stored against the ElevenLabs engine.

                  It no longer decides what a VIDEO runs on: each video and each channel
                  carries its own voice, and the engine follows that voice. Said out loud
                  below, because an operator who reads this select as the master switch will
                  keep trying to solve a per-channel problem with a global setting. */}
              {isAi84 && (
                <div style={{ marginBottom: 10 }}>
                  <label className="label">{tr("AI84 — modèle par défaut", "AI84 — default model")}</label>
                  <select className="input" value={val("AI84_MODEL")} onChange={(e) => set("AI84_MODEL", e.target.value)}>
                    {AI84_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.backend === "minimax" ? "MiniMax" : "ElevenLabs"} · {m.label}
                      </option>
                    ))}
                  </select>
                  <div className="faint" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>
                    {tr(
                      "Choisit le moteur de la voix globale ci-dessous, et le niveau de qualité facturé. Chaque vidéo et chaque chaîne peut avoir sa propre voix : le moteur suit cette voix, donc des chaînes sur les deux moteurs fonctionnent en même temps.",
                      "Picks the engine for the global voice below, and the quality tier you're billed at. Each video and each channel can have its own voice, and the engine follows that voice — so channels on both engines work at the same time."
                    )}
                  </div>
                </div>
              )}
              {/* key={ai84Engine}: switching engines must drop a list loaded for the other
                  one. Remounting does that for free — an effect here would re-fire on
                  every render and hammer the API, which has already happened once. */}
              <VoicePicker
                key={isAi84 ? ai84Engine : undefined}
                label={`${meta.label} — voice_id`}
                settingKey={meta.voiceIdKey}
                which={meta.voicesEndpoint}
                params={isAi84 ? { backend: ai84Engine } : undefined}
                val={val}
                set={set}
              />
              {isAi84 && (
                <div className="faint" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>
                  {ai84Engine === "minimax"
                    ? tr(
                        "Moteur MiniMax : la liste contient vos voix clonées (marquées « your clone ») ainsi que la bibliothèque partagée.",
                        "MiniMax engine: the list includes your own cloned voices (marked “your clone”) as well as the shared library."
                      )
                    : tr(
                        "Moteur ElevenLabs : vos voix clonées n'existent pas ici. Elles ne fonctionnent qu'avec un modèle « speech-… » (MiniMax) — changez le modèle ci-dessus pour les voir.",
                        "ElevenLabs engine: your cloned voices don't exist here. They only work with a “speech-…” (MiniMax) model — switch the model above to see them."
                      )}
                </div>
              )}
            </div>
          ) : is69labs ? (
            <div>
              <SettingsField
                label={voiceCopy.label}
                settingKey={meta.voiceIdKey}
                val={val}
                set={set}
                placeholder={voiceCopy.placeholder}
                displayValue={voiceIdMismatch ? "" : undefined}
              />
              {voiceIdWarning && (
                <div style={{ fontSize: 12, marginTop: 5, lineHeight: 1.45, color: "var(--warning)" }}>
                  ⚠ {voiceIdWarning}
                </div>
              )}
              <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>{voiceCopy.hint}</div>
            </div>
          ) : (
            <SettingsField label={`${meta.label} — voice_id`} settingKey={meta.voiceIdKey} val={val} set={set} />
          )}
          {meta.extraKeys?.map((ek) => <SettingsField key={ek.key} label={ek.label} settingKey={ek.key} val={val} set={set} />)}
        </>
      )}
    </>
  );
}

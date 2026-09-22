"use client";

import { useT } from "@/app/_i18n";
import { providerVoiceLabel, voiceProviderMeta, VOICE_PROVIDERS } from "@/lib/providers";
import { VoiceSelect } from "@/app/_components/VoiceSelect";
import { useVoiceCatalogue } from "@/app/_components/useVoiceCatalogue";

/**
 * Voice-provider + voice-id pair for ONE channel (draft or an existing one being
 * edited). A real component — not inlined into the parent's `fields()` closure —
 * because it calls useVoiceCatalogue(), a hook, and `fields()` is invoked a variable
 * number of times per render (the create draft, plus one call per channel currently
 * being edited); a hook can only be called from a genuine component/hook, never from a
 * plain function invoked a variable number of times.
 */
export function ChannelVoiceFields({
  voiceProvider,
  voiceId,
  globalVoiceProvider,
  onVoiceProviderChange,
  onVoiceIdChange,
}: {
  voiceProvider: string;
  voiceId: string;
  globalVoiceProvider: string;
  onVoiceProviderChange: (v: string) => void;
  onVoiceIdChange: (v: string) => void;
}) {
  const tr = useT();
  // The provider ACTUALLY in effect for this channel — its own override, else the global
  // one — decides which catalogue/label below is really being configured.
  const effectiveProvider = voiceProvider || globalVoiceProvider;
  const voiceLabel = providerVoiceLabel(effectiveProvider);
  const voiceProviderLabel = voiceProviderMeta(effectiveProvider).label;
  const { endpoint: voicesEndpoint, voices, loading: voicesLoading, error: voicesError, retry: retryVoices } = useVoiceCatalogue(effectiveProvider);

  return (
    <div className="grid-2" style={{ gap: 16 }}>
      <div>
        <label className="label">{tr("Fournisseur de voix (optionnel)", "Voice provider (optional)")}</label>
        <select className="input" value={voiceProvider} onChange={(e) => onVoiceProviderChange(e.target.value)}>
          <option value="">{tr(`vide = global (${voiceProviderMeta(globalVoiceProvider).label})`, `empty = global (${voiceProviderMeta(globalVoiceProvider).label})`)}</option>
          {VOICE_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.selectLabel}</option>)}
        </select>
        <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
          {tr(
            "Fixe le moteur de voix pour cette chaîne, quel que soit le réglage global — nécessaire pour qu'un ID ai33/ai84 fonctionne si l'app entière n'utilise pas ce fournisseur.",
            "Pins the voice engine for this channel regardless of the global setting — needed for an ai33/ai84 id to actually work unless the whole app is on that provider."
          )}
        </div>
      </div>
      <div>
        <label className="label">{`${voiceLabel} ${tr("(optionnel — voix de cette chaîne)", "(optional — this channel's voice)")}`}</label>
        {voicesEndpoint ? (
          <VoiceSelect
            voices={voices}
            value={voiceId.trim() || null}
            onChange={(id) => onVoiceIdChange(id ?? "")}
            loading={voicesLoading}
            error={voicesError}
            onRetry={retryVoices}
            where="channel"
            providerLabel={voiceProviderLabel}
          />
        ) : (
          <input className="input" value={voiceId} onChange={(e) => onVoiceIdChange(e.target.value)}
            placeholder={tr("vide = voix globale (Paramètres)", "empty = global voice (Settings)")} />
        )}
        {voiceId.trim() && (
          <div className="faint" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>
            {tr(
              `Cet identifiant sera envoyé à ${voiceProviderLabel} et remplacera la voix globale. S'il provient d'un autre fournisseur, videz ce champ.`,
              `This id will be sent to ${voiceProviderLabel} and overrides the global voice. If it came from a different provider, clear this field.`
            )}
          </div>
        )}
      </div>
    </div>
  );
}

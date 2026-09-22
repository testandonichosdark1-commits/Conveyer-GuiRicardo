"use client";

import { useT } from "@/app/_i18n";
import { VoiceSelect } from "@/app/_components/VoiceSelect";
import { useVoiceCatalogue } from "@/app/_components/useVoiceCatalogue";

/**
 * A channel's ai33.pro voice id — the ONLY voice provider a channel pins directly (see
 * channels.ts's module doc comment). A real component, not inlined into the parent's
 * `fields()` closure: it calls useVoiceCatalogue(), a hook, and `fields()` is invoked a
 * variable number of times per render (the create draft, plus one call per channel
 * currently being edited) — calling a hook there directly would violate the Rules of
 * Hooks the moment the edited channel changes (this bit the earlier, more generic
 * ChannelVoiceFields it replaces).
 *
 * Whenever this has a value, the API routes set the channel's voice_provider to "ai33"
 * automatically (deriveVoiceProvider() in channels.ts) — there is no separate provider
 * selector to keep in sync.
 */
export function ChannelAi33VoiceField({
  voiceId,
  onChange,
}: {
  voiceId: string;
  onChange: (v: string) => void;
}) {
  const tr = useT();
  const { endpoint, voices, loading, error, retry } = useVoiceCatalogue("ai33");

  return (
    <div>
      <label className="label">{tr("ai33.pro — voice_id (optionnel)", "ai33.pro — voice_id (optional)")}</label>
      {endpoint ? (
        <VoiceSelect
          voices={voices}
          value={voiceId.trim() || null}
          onChange={(id) => onChange(id ?? "")}
          loading={loading}
          error={error}
          onRetry={retry}
          where="channel"
          providerLabel="ai33.pro"
        />
      ) : (
        <input className="input" value={voiceId} onChange={(e) => onChange(e.target.value)}
          placeholder={tr("ex. edge:en-US-GuyNeural", "e.g. edge:en-US-GuyNeural")} />
      )}
      <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
        {tr(
          "Vide = cette chaîne n'utilise PAS ai33 — elle narre avec le fournisseur global (Paramètres). Une valeur ici fait passer TOUTES les vidéos de cette chaîne sur ai33.pro, avec cette voix.",
          "Empty = this channel does NOT use ai33 — it narrates with the global provider (Settings). A value here switches EVERY video on this channel to ai33.pro, with this voice."
        )}
      </div>
    </div>
  );
}

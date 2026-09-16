"use client";
import { useState } from "react";
import { useT } from "../../_i18n";
import type { VoicesEndpoint } from "@/lib/providers";
import type { Val, Set } from "./useSettings";

interface Voice { voice_id: string; name: string }

/**
 * Voice-id input with a "Load voices" button that fetches the provider's voice
 * library and offers a dropdown. Each instance owns its own fetch state.
 *
 * `which` IS the /api/voices/<x> route segment, straight from the provider registry —
 * so a provider that declares `voicesEndpoint` gets a working picker with no mapping
 * table here to fall out of sync.
 */
export function VoicePicker({
  label,
  settingKey,
  which,
  params,
  val,
  set,
}: {
  label: string;
  settingKey: string;
  which: VoicesEndpoint;
  /** Extra query for providers whose library depends on another setting (AI84's engine). */
  params?: Record<string, string>;
  val: Val;
  set: Set;
}) {
  const tr = useT();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadVoices() {
    setLoading(true);
    try {
      const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
      const r = await fetch(`/api/voices/${which}${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(`${tr("Impossible de charger les voix", "Couldn't load voices")} : ${j.error || r.statusText}`);
        return;
      }
      setVoices(j.voices ?? []);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <label className="label">{label}</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="input" style={{ flex: 1 }} value={val(settingKey)} onChange={(e) => set(settingKey, e.target.value)} placeholder="voice_id" />
        <button className="btn btn-ghost" style={{ fontSize: 12.5, whiteSpace: "nowrap" }} disabled={loading} onClick={loadVoices}>
          {loading ? "…" : tr("Charger les voix", "Load voices")}
        </button>
      </div>
      {voices && voices.length > 0 && (
        <select className="input" style={{ marginTop: 8 }} value="" onChange={(e) => e.target.value && set(settingKey, e.target.value)}>
          <option value="">{tr(`— choisir une voix (${voices.length}) —`, `— pick a voice (${voices.length}) —`)}</option>
          {voices.map((v) => <option key={v.voice_id} value={v.voice_id}>{v.name}</option>)}
        </select>
      )}
      {/* A successful call that returns nothing is a real state (an account with no voices
          yet). Saying so beats a button that appears to do nothing. */}
      {voices && voices.length === 0 && (
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          {tr(
            "Aucune voix trouvée sur ce compte — créez-en une chez le fournisseur, ou collez un voice_id ci-dessus.",
            "No voices found on this account — create one at the provider, or paste a voice_id above."
          )}
        </div>
      )}
    </div>
  );
}

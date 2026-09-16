"use client";
import { useEffect, useState, useCallback } from "react";
import { useT } from "../_i18n";
import { providerVoiceLabel, voiceProviderMeta } from "@/lib/providers";
import { AvatarSelect, type AvatarLite } from "../_components/AvatarSelect";
import { VoiceSelect } from "../_components/VoiceSelect";
import { useVoiceCatalogue } from "../_components/useVoiceCatalogue";

interface Channel {
  id: number;
  name: string;
  visual_mode: "ai" | "real" | "mix";
  ai_style: string | null;
  visual_prompt: string | null;
  voice_id: string | null;
  voice_speed: number | null;
  interval_sec: number;
  format: string;
  avatar_id: number | null;
}

interface Draft {
  name: string;
  // Kept in state (so saved values round-trip and aren't wiped) but no longer
  // exposed in the UI — channels default these to global settings at run time.
  visual_mode: "ai" | "real" | "mix";
  ai_style: string;
  visual_prompt: string;
  interval_sec: number;
  format: string;
  // User-facing:
  voice_id: string;
  voice_speed: string;
  avatar_id: number | null;
}

const EMPTY: Draft = { name: "", visual_mode: "mix", ai_style: "", visual_prompt: "", interval_sec: 4.5, format: "1920x1080", voice_id: "", voice_speed: "", avatar_id: null };

export default function ChainesPage() {
  const tr = useT();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [avatars, setAvatars] = useState<AvatarLite[]>([]);
  const [voiceProvider, setVoiceProvider] = useState("elevenlabs");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [edit, setEdit] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);

  const voiceLabel = providerVoiceLabel(voiceProvider); // e.g. "GenAIPro Voice ID"
  // The short provider name ("AI84"), for saying which service this channel's voice id
  // is actually sent to — the column is provider-blind (see lib/voice-select.ts).
  const voiceProviderLabel = voiceProviderMeta(voiceProvider).label;
  const {
    endpoint: voicesEndpoint,
    voices,
    loading: voicesLoading,
    error: voicesError,
    retry: retryVoices,
  } = useVoiceCatalogue(voiceProvider);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/channels");
      const j = r.ok ? await r.json() : [];
      setChannels(Array.isArray(j) ? j : []);
    } catch {
      setChannels([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Avatars for the picker + global voice provider for the dynamic Voice-ID label.
  useEffect(() => {
    fetch("/api/avatars").then((r) => (r.ok ? r.json() : null)).then((rows) => { if (Array.isArray(rows)) setAvatars(rows); }).catch(() => {});
    fetch("/api/settings").then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (s && typeof s === "object" && !Array.isArray(s) && typeof s.VOICEOVER_PROVIDER === "string" && s.VOICEOVER_PROVIDER) setVoiceProvider(s.VOICEOVER_PROVIDER);
    }).catch(() => {});
  }, []);

  function bodyOf(d: Draft) {
    return {
      name: d.name.trim(),
      voice_id: d.voice_id,
      voice_speed: d.voice_speed,
      avatar_id: d.avatar_id,
      // Preserved from existing/default values — not user-editable here anymore.
      visual_mode: d.visual_mode,
      ai_style: d.ai_style,
      visual_prompt: d.visual_prompt,
      interval_sec: d.interval_sec,
      format: d.format,
    };
  }

  async function create() {
    if (!draft.name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyOf(draft)) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(`${tr("Impossible de créer la chaîne", "Couldn't create the channel")} :\n\n${j.error || r.statusText}`); return; }
      setDraft(EMPTY);
      await load();
    } finally { setBusy(false); }
  }

  function startEdit(c: Channel) {
    setEditingId(c.id);
    setEdit({
      name: c.name,
      visual_mode: c.visual_mode,
      ai_style: c.ai_style ?? "",
      visual_prompt: c.visual_prompt ?? "",
      interval_sec: c.interval_sec,
      format: c.format,
      voice_id: c.voice_id ?? "",
      voice_speed: c.voice_speed != null ? String(c.voice_speed) : "",
      avatar_id: c.avatar_id,
    });
  }

  async function saveEdit() {
    if (editingId == null || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/channels/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyOf(edit)) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(`${tr("Erreur", "Error")} : ${j.error || r.statusText}`); return; }
      setEditingId(null);
      await load();
    } finally { setBusy(false); }
  }

  async function remove(id: number, label: string) {
    if (!confirm(tr(`Supprimer la chaîne « ${label} » ?`, `Delete channel "${label}"?`))) return;
    await fetch(`/api/channels/${id}`, { method: "DELETE" });
    if (editingId === id) setEditingId(null);
    await load();
  }

  const fields = (d: Draft, set: (d: Draft) => void) => (
    <>
      <div className="grid-2" style={{ gap: 16 }}>
        <div>
          <label className="label">{tr("Nom", "Name")}</label>
          <input className="input" value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} placeholder={tr("Ma chaîne", "My channel")} />
        </div>
        <div>
          <label className="label">{tr("Avatar par défaut", "Default avatar")}</label>
          <AvatarSelect avatars={avatars} value={d.avatar_id} onChange={(id) => set({ ...d, avatar_id: id })} noneLabel={tr("Aucun — voix seule / choisi au lancement", "None — voice only / chosen at run")} />
        </div>
      </div>

      <div>
        <label className="label">{`${voiceLabel} ${tr("(optionnel — voix de cette chaîne)", "(optional — this channel's voice)")}`}</label>
        {/* A list where the provider can serve one, the original free-text box where it
            can't (genaipro / 69labs / minimax have no listing endpoint at all).

            Typing an id by hand was the only option here, which is how channels ended up on
            voices whose AI84 engine nobody could see. The run now derives the engine from the
            voice either way, but a list is what stops the mismatch being invisible until a
            video fails. */}
        {voicesEndpoint ? (
          <VoiceSelect
            voices={voices}
            value={d.voice_id.trim() || null}
            onChange={(id) => set({ ...d, voice_id: id ?? "" })}
            loading={voicesLoading}
            error={voicesError}
            onRetry={retryVoices}
            where="channel"
            providerLabel={voiceProviderLabel}
          />
        ) : (
          <input className="input" value={d.voice_id} onChange={(e) => set({ ...d, voice_id: e.target.value })}
            placeholder={tr("vide = voix globale (Paramètres)", "empty = global voice (Settings)")} />
        )}
        {/* This ONE column is sent to whichever voice provider is selected, and it OVERRIDES
            that provider's global voice — so an id entered while another provider was active
            is silently reused by the next one. The label above already names the current
            provider; this says out loud which service the value will actually be sent to,
            because a mismatch only shows up as a failed run. Display-only. */}
        {d.voice_id.trim() && (
          <div className="faint" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>
            {tr(
              `Cet identifiant sera envoyé à ${voiceProviderLabel} et remplacera la voix globale. S'il provient d'un autre fournisseur, videz ce champ.`,
              `This id will be sent to ${voiceProviderLabel} and overrides the global voice. If it came from a different provider, clear this field.`
            )}
          </div>
        )}
      </div>

      <div>
        <label className="label">{tr("Vitesse de la voix (optionnel)", "Voiceover speed (optional)")}</label>
        <input className="input" type="number" step="0.01" min="0.7" max="1.2" value={d.voice_speed}
          onChange={(e) => set({ ...d, voice_speed: e.target.value })}
          placeholder={tr("vide = vitesse globale · 0.7 lent – 1.2 rapide", "empty = global speed · 0.7 slow – 1.2 fast")} />
      </div>
    </>
  );

  return (
    <div>
      <h1>{tr("Chaînes", "Channels")}</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: 14 }}>
        {tr(
          "Une chaîne = un nom, une voix et un avatar par défaut. Les autres réglages utilisent les valeurs par défaut ou se choisissent au lancement.",
          "A channel = a name, a default voice and a default avatar. Other settings use sensible defaults or are chosen at run time."
        )}
      </p>

      <div className="card" style={{ display: "grid", gap: 16, marginBottom: 22 }}>
        {fields(draft, setDraft)}
        <div>
          <button className="btn" onClick={create} disabled={busy || !draft.name.trim()}>
            {busy ? tr("Création…", "Creating…") : tr("Créer la chaîne", "Create channel")}
          </button>
        </div>
      </div>

      {channels.length > 0 && (
        <div style={{ display: "grid", gap: 10 }}>
          {channels.map((c) => {
            const avatarName = c.avatar_id != null ? avatars.find((a) => a.id === c.avatar_id)?.name : undefined;
            return (
              <div key={c.id} className="card" style={{ padding: editingId === c.id ? 16 : "12px 16px", display: "grid", gap: editingId === c.id ? 16 : 0 }}>
                {editingId === c.id ? (
                  <>
                    {fields(edit, setEdit)}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn" onClick={saveEdit} disabled={busy}>{tr("Enregistrer", "Save")}</button>
                      <button className="btn btn-ghost" onClick={() => setEditingId(null)}>{tr("Annuler", "Cancel")}</button>
                      <button className="btn btn-ghost" style={{ marginLeft: "auto", color: "#b91c1c" }} onClick={() => remove(c.id, c.name)}>{tr("Supprimer", "Delete")}</button>
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ fontSize: 13.5, minWidth: 0 }}>
                      <strong>{c.name}</strong>
                      <span className="faint"> — {tr("voix", "voice")} {c.voice_id ? "✓" : tr("défaut", "default")}{avatarName ? ` · ${avatarName}` : ""}</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => startEdit(c)}>{tr("Modifier", "Edit")}</button>
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 12px", color: "#b91c1c" }} onClick={() => remove(c.id, c.name)}>{tr("Supprimer", "Delete")}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

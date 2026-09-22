"use client";
import { useEffect, useState, useCallback } from "react";
import { useT } from "../_i18n";
import { AvatarSelect, type AvatarLite } from "../_components/AvatarSelect";
import { CharacterReferenceField } from "../settings/_components/CharacterReferenceField";
import { ChannelApiKeysField } from "./_components/ChannelApiKeysField";
import { ChannelAi33VoiceField } from "./_components/ChannelAi33VoiceField";

interface Channel {
  id: number;
  name: string;
  visual_mode: "ai" | "real" | "mix";
  ai_style: string | null;
  visual_prompt: string | null;
  voice_id: string | null;
  voice_speed: number | null;
  voice_provider: string | null;
  api_keys: Record<string, string>;
  interval_sec: number;
  format: string;
  avatar_id: number | null;
}

interface Draft {
  name: string;
  // Kept in state (so saved values round-trip and aren't wiped) but no longer
  // exposed in the UI — channels default these to global settings at run time.
  visual_mode: "ai" | "real" | "mix";
  visual_prompt: string;
  interval_sec: number;
  format: string;
  // User-facing:
  ai_style: string;
  voice_id: string; // ai33.pro voice id — see ChannelAi33VoiceField
  voice_speed: string;
  avatar_id: number | null;
  api_keys: Record<string, string>; // CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / AI33_API_KEY
}

const EMPTY: Draft = {
  name: "",
  visual_mode: "mix",
  visual_prompt: "",
  interval_sec: 4.5,
  format: "1920x1080",
  ai_style: "",
  voice_id: "",
  voice_speed: "",
  avatar_id: null,
  api_keys: {},
};

export default function ChainesPage() {
  const tr = useT();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [avatars, setAvatars] = useState<AvatarLite[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [edit, setEdit] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    fetch("/api/avatars").then((r) => (r.ok ? r.json() : null)).then((rows) => { if (Array.isArray(rows)) setAvatars(rows); }).catch(() => {});
  }, []);

  function bodyOf(d: Draft) {
    return {
      name: d.name.trim(),
      voice_id: d.voice_id, // voice_provider is derived server-side from this — see deriveVoiceProvider()
      voice_speed: d.voice_speed,
      avatar_id: d.avatar_id,
      api_keys: d.api_keys,
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
      api_keys: c.api_keys ?? {},
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

  const fields = (d: Draft, set: (d: Draft) => void, channelId: number | null) => (
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

      <ChannelAi33VoiceField voiceId={d.voice_id} onChange={(v) => set({ ...d, voice_id: v })} />

      <div>
        <label className="label">{tr("Vitesse de la voix (optionnel)", "Voiceover speed (optional)")}</label>
        <input className="input" type="number" step="0.01" min="0.7" max="1.2" value={d.voice_speed}
          onChange={(e) => set({ ...d, voice_speed: e.target.value })}
          placeholder={tr("vide = vitesse globale · 0.7 lent – 1.2 rapide", "empty = global speed · 0.7 slow – 1.2 fast")} />
      </div>

      <div>
        <label className="label">{tr("Style d'image IA par défaut (optionnel)", "Default AI image style (optional)")}</label>
        <textarea
          className="input"
          rows={2}
          value={d.ai_style}
          onChange={(e) => set({ ...d, ai_style: e.target.value })}
          placeholder={tr(
            "ex. « cinematic, muted colors, 35mm film grain »",
            "e.g. \"cinematic, muted colors, 35mm film grain\""
          )}
        />
        <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
          {tr("Ajouté au prompt de chaque plan IA (image et vidéo) généré pour cette chaîne.", "Appended to every AI beat's prompt (image and video) generated for this channel.")}
        </div>
      </div>

      {channelId != null && (
        <CharacterReferenceField
          endpoint={`/api/channels/${channelId}/character-reference`}
          label={tr("Personnage de référence de cette chaîne (optionnel)", "Character reference image (optional)")}
          hint={tr(
            "Utilisée pour TOUTES les vidéos de cette chaîne.",
            "Used for every video on this channel."
          )}
        />
      )}

      <ChannelApiKeysField value={d.api_keys} onChange={(next) => set({ ...d, api_keys: next })} />
    </>
  );

  return (
    <div>
      <h1>{tr("Chaînes", "Channels")}</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: 14 }}>
        {tr(
          "Une chaîne = configuration au niveau du projet/client : Cloudflare, ai33.pro (clé + voix), personnage de référence et style d'image IA. Tout le reste vient des Paramètres globaux.",
          "A channel = project/client-level config: Cloudflare, ai33.pro (key + voice), character reference, and AI image style. Everything else comes from the global Settings."
        )}
      </p>

      <div className="card" style={{ display: "grid", gap: 16, marginBottom: 22 }}>
        {fields(draft, setDraft, null)}
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
                    {fields(edit, setEdit, c.id)}
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
                      <span className="faint">
                        {avatarName ? ` · ${avatarName}` : ""}
                        {c.voice_provider === "ai33" ? ` · ${tr("voix ai33", "ai33 voice")}` : ""}
                        {Object.values(c.api_keys || {}).some((v) => v.trim()) ? ` · ${tr("comptes propres", "own accounts")}` : ""}
                      </span>
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

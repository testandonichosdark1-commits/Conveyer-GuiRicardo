"use client";
import { useEffect, useState, useCallback } from "react";
import { useT } from "../_i18n";
import { providerVoiceLabel } from "@/lib/providers";
import { AvatarSelect, type AvatarLite } from "../_components/AvatarSelect";

interface Channel {
  id: number;
  name: string;
  visual_mode: "ai" | "real" | "mix";
  ai_style: string | null;
  visual_prompt: string | null;
  voice_id: string | null;
  interval_sec: number;
  format: string;
  avatar_id: number | null;
  real_ratio_percent: number | null;
  footage_source_tiers: string | null;
}

const FOOTAGE_PROVIDER_HINT = "pexels, pixabay, openverse, wikimedia, archive, web";

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
  avatar_id: number | null;
  // "" = null = use the global REAL_RATIO_PERCENT default.
  real_ratio_percent: string;
  // One entry per priority tier, each a comma-separated list of provider keys
  // (e.g. "openverse,wikimedia"). Empty rows are dropped on save. YouTube is
  // intentionally not offered here — it's already the pipeline's automatic
  // last-resort after every tier is exhausted.
  footage_tiers: string[];
}

function parseFootageTiers(raw: string | null): string[] {
  if (!raw) return ["", ""];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) return arr.map((t) => String(t));
  } catch { /* ignore malformed value */ }
  return ["", ""];
}

const EMPTY: Draft = {
  name: "", visual_mode: "mix", ai_style: "", visual_prompt: "", interval_sec: 4.5, format: "1920x1080",
  voice_id: "", avatar_id: null, real_ratio_percent: "", footage_tiers: ["", ""],
};

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
    const tiers = d.footage_tiers
      .map((row) => row.split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))
      .filter((tier) => tier.length > 0)
      .map((tier) => tier.join(","));
    return {
      name: d.name.trim(),
      voice_id: d.voice_id,
      avatar_id: d.avatar_id,
      // Preserved from existing/default values — not user-editable here anymore.
      visual_mode: d.visual_mode,
      ai_style: d.ai_style,
      visual_prompt: d.visual_prompt,
      interval_sec: d.interval_sec,
      format: d.format,
      real_ratio_percent: d.real_ratio_percent.trim() === "" ? null : Math.max(0, Math.min(100, Number(d.real_ratio_percent))),
      footage_source_tiers: tiers.length > 0 ? JSON.stringify(tiers) : null,
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
      avatar_id: c.avatar_id,
      real_ratio_percent: c.real_ratio_percent != null ? String(c.real_ratio_percent) : "",
      footage_tiers: parseFootageTiers(c.footage_source_tiers),
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
        <input className="input" value={d.voice_id} onChange={(e) => set({ ...d, voice_id: e.target.value })}
          placeholder={tr("vide = voix globale (Paramètres)", "empty = global voice (Settings)")} />
      </div>

      <div>
        <label className="label">{tr("% b-roll réel (vide = défaut global)", "% real b-roll (empty = global default)")}</label>
        <input className="input" type="number" min={0} max={100} value={d.real_ratio_percent}
          onChange={(e) => set({ ...d, real_ratio_percent: e.target.value })}
          placeholder={tr("ex. 90 = 90% réel / 10% IA", "e.g. 90 = 90% real / 10% AI")} />
      </div>

      <div>
        <label className="label">{tr("Priorité des sources de b-roll (vide = défaut global)", "B-roll source priority (empty = global default)")}</label>
        <p className="faint" style={{ fontSize: 12, marginTop: -4, marginBottom: 8 }}>
          {tr(
            `Chaque ligne = un palier, essayé dans l'ordre (le suivant seulement si rien n'est trouvé). Clés valides : ${FOOTAGE_PROVIDER_HINT}. YouTube est déjà le dernier recours automatique — inutile de l'ajouter.`,
            `Each row = one tier, tried in order (the next one only if nothing is found). Valid keys: ${FOOTAGE_PROVIDER_HINT}. YouTube is already the automatic last resort — no need to add it.`
          )}
        </p>
        {d.footage_tiers.map((row, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <input className="input" value={row}
              placeholder={tr(`Palier ${i + 1} — ex. openverse,wikimedia`, `Tier ${i + 1} — e.g. openverse,wikimedia`)}
              onChange={(e) => {
                const next = [...d.footage_tiers];
                next[i] = e.target.value;
                set({ ...d, footage_tiers: next });
              }} />
            <button type="button" className="btn-ghost" style={{ padding: "5px 12px" }}
              onClick={() => set({ ...d, footage_tiers: d.footage_tiers.filter((_, j) => j !== i) })}>
              {tr("Retirer", "Remove")}
            </button>
          </div>
        ))}
        <button type="button" className="btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }}
          onClick={() => set({ ...d, footage_tiers: [...d.footage_tiers, ""] })}>
          {tr("+ Ajouter un palier", "+ Add tier")}
        </button>
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

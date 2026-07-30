"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useT } from "../_i18n";

/** Voice library — create/preview/delete Voicebox (local, free) voice profiles. */

interface VoiceProfile {
  id: string;
  name: string;
  description: string | null;
  voice_type: string;
  default_engine: string | null;
  preset_engine: string | null;
  preset_voice_id: string | null;
  sample_count: number;
}
interface PresetVoice { voice_id: string; name: string; gender: string; language: string }

const CLONING_ENGINES = [
  { id: "chatterbox", label: "Chatterbox" },
  { id: "chatterbox_turbo", label: "Chatterbox Turbo" },
  { id: "luxtts", label: "LuxTTS" },
];
const PRESET_ENGINES = [
  { id: "kokoro", label: "Kokoro" },
  { id: "qwen_custom_voice", label: "Qwen CustomVoice" },
];

export default function VoicesPage() {
  const tr = useT();
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [voiceboxDirSet, setVoiceboxDirSet] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"clone" | "preset">("preset");
  const [engine, setEngine] = useState("kokoro");
  const [presetOptions, setPresetOptions] = useState<PresetVoice[]>([]);
  const [presetVoiceId, setPresetVoiceId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [referenceText, setReferenceText] = useState("");
  const [busy, setBusy] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/voices/voicebox");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setLoadError((j as { error?: string }).error || tr("Échec du chargement", "Failed to load")); return; }
      if (Array.isArray(j)) { setVoices(j); setLoadError(null); }
    } catch {
      setLoadError(tr("Échec du chargement", "Failed to load"));
    }
  }, [tr]);

  useEffect(() => { load(); }, [load]);

  // VOICEBOX_DIR isn't set → /settings shows the setup hint instead of a bare
  // empty grid, mirroring how the parametres page nudges the operator.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && typeof j === "object") setVoiceboxDirSet(Boolean((j as Record<string, string>).VOICEBOX_DIR?.trim())); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (mode !== "preset") return;
    fetch(`/api/voicebox-presets/${engine}`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
      .then((j) => setPresetOptions(Array.isArray(j) ? j : []));
  }, [mode, engine]);

  async function create() {
    if (!name.trim()) return;
    if (mode === "clone" && (!file || !referenceText.trim())) return;
    if (mode === "preset" && !presetVoiceId) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("name", name.trim());
      fd.set("engine", engine);
      if (mode === "clone") {
        fd.set("sample", file as File);
        fd.set("referenceText", referenceText.trim());
      } else {
        fd.set("presetVoiceId", presetVoiceId);
      }
      const r = await fetch("/api/voices/voicebox", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(`${tr("Impossible de créer la voix", "Couldn't create the voice")} :\n\n${(j as { error?: string }).error || r.statusText}`); return; }
      setName(""); setFile(null); setReferenceText(""); setPresetVoiceId("");
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } finally { setBusy(false); }
  }

  async function seedStarterVoices() {
    setSeeding(true);
    try {
      const r = await fetch("/api/voices/voicebox/seed", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(`${tr("Échec", "Failed")} : ${(j as { error?: string }).error || r.statusText}`); return; }
      const { created, errors } = j as { created: number; errors: string[] };
      if (errors?.length) alert(`${tr("Créées", "Created")} ${created}. ${tr("Échecs", "Failures")}:\n${errors.join("\n")}`);
      await load();
    } finally {
      setSeeding(false);
    }
  }

  async function preview(id: string) {
    setPreviewingId(id);
    try {
      const r = await fetch(`/api/voices/voicebox/${id}/preview`, { method: "POST" });
      if (!r.ok) { const j = await r.json().catch(() => ({})); alert((j as { error?: string }).error || tr("Échec de la prévisualisation", "Preview failed")); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) { audioRef.current.src = url; audioRef.current.play().catch(() => {}); }
    } finally { setPreviewingId(null); }
  }

  async function remove(id: string, label: string) {
    if (!confirm(tr(`Supprimer la voix « ${label} » ?`, `Delete voice "${label}"?`))) return;
    await fetch(`/api/voices/voicebox/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div>
      <h1>{tr("Voix", "Voices")}</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: 14, lineHeight: 1.6 }}>
        {tr(
          "Bibliothèque de voix Voicebox (gratuite, locale) — clonez votre propre voix ou utilisez un preset. Écoutez avant de choisir. Sélectionnable comme fournisseur de voix (VOICEOVER_PROVIDER = voicebox) sur la page Paramètres.",
          "Voicebox voice library (free, local) — clone your own voice or use a preset. Listen before you pick one. Selectable as the voice provider (VOICEOVER_PROVIDER = voicebox) on the Settings page."
        )}
      </p>
      <audio ref={audioRef} style={{ display: "none" }} />

      {!voiceboxDirSet && (
        <div className="card" style={{ marginBottom: 18, fontSize: 13, lineHeight: 1.6 }}>
          {tr("VOICEBOX_DIR n'est pas défini.", "VOICEBOX_DIR is not set.")}{" "}
          {tr("Clonez ", "Clone ")}<code>github.com/jamiepine/voicebox</code>{tr(" en local, définissez le chemin sur la ", ", set the path on the ")}
          <Link href="/parametres">{tr("page Paramètres", "Settings page")}</Link>
          {tr(", puis lancez ", ", then run ")}<code>npm run setup:voicebox</code>{tr(" une fois.", " once.")}
        </div>
      )}

      {loadError && (
        <div className="card" style={{ marginBottom: 18, fontSize: 13, color: "var(--warning)" }}>
          {loadError}
        </div>
      )}

      <div className="card" style={{ marginBottom: 18, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 650, fontSize: 13.5 }}>{tr("Pack de démarrage", "Starter pack")}</div>
          <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
            {tr(
              "Ajoute 10 voix féminines + 10 masculines (Kokoro, anglais, aucun échantillon requis) en un clic.",
              "Adds 10 female + 10 male voices (Kokoro, English, no sample needed) in one click."
            )}
          </div>
        </div>
        <button className="btn btn-ghost" onClick={seedStarterVoices} disabled={seeding}>
          {seeding ? tr("Ajout…", "Adding…") : tr("+ Ajouter les 20 voix", "+ Add the 20 voices")}
        </button>
      </div>

      <div className="card" style={{ display: "grid", gap: 16, marginBottom: 22 }}>
        <div className="grid-2" style={{ gap: 16 }}>
          <div>
            <label className="label">{tr("Nom", "Name")}</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("ex : Ma voix", "e.g. My voice")} />
          </div>
          <div>
            <label className="label">{tr("Type", "Type")}</label>
            <select className="input" value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setEngine(e.target.value === "clone" ? "chatterbox" : "kokoro"); }}>
              <option value="preset">{tr("Voix preset", "Preset voice")}</option>
              <option value="clone">{tr("Cloner depuis un échantillon", "Clone from a sample")}</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">{tr("Moteur", "Engine")}</label>
          <select className="input" value={engine} onChange={(e) => setEngine(e.target.value)}>
            {(mode === "clone" ? CLONING_ENGINES : PRESET_ENGINES).map((e) => (
              <option key={e.id} value={e.id}>{e.label}</option>
            ))}
          </select>
        </div>

        {mode === "clone" ? (
          <>
            <div>
              <label className="label">{tr("Échantillon audio (10-30s, voix claire)", "Audio sample (10-30s, clean speech)")}</label>
              <input ref={fileRef} className="input" type="file" accept="audio/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <div>
              <label className="label">{tr("Texte de référence (ce que dit l'échantillon)", "Reference text (what the sample says)")}</label>
              <input className="input" value={referenceText} onChange={(e) => setReferenceText(e.target.value)} />
            </div>
          </>
        ) : (
          <div>
            <label className="label">{tr("Voix preset", "Preset voice")}</label>
            <select className="input" value={presetVoiceId} onChange={(e) => setPresetVoiceId(e.target.value)}>
              <option value="">{tr("Choisir…", "Choose…")}</option>
              {presetOptions.map((p) => (
                <option key={p.voice_id} value={p.voice_id}>{p.name} ({p.gender}, {p.language})</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <button className="btn" onClick={create} disabled={busy || !name.trim() || (mode === "clone" ? (!file || !referenceText.trim()) : !presetVoiceId)}>
            {busy ? tr("Création…", "Creating…") : tr("Créer la voix", "Create voice")}
          </button>
        </div>
      </div>

      {voices.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
          {voices.map((v) => (
            <div key={v.id} className="card" style={{ padding: 12, display: "grid", gap: 9 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontWeight: 650, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</div>
                <span className="faint" style={{ fontSize: 10.5, fontWeight: 600, whiteSpace: "nowrap" }}>
                  {v.default_engine || v.preset_engine || v.voice_type}
                </span>
              </div>
              <div className="faint" style={{ fontSize: 11 }}>{v.id}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: "4px 9px" }} onClick={() => preview(v.id)} disabled={previewingId === v.id}>
                  {previewingId === v.id ? tr("Chargement…", "Loading…") : `▶ ${tr("Écouter", "Preview")}`}
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: "4px 9px", marginLeft: "auto" }} onClick={() => remove(v.id, v.name)}>
                  {tr("Supprimer", "Delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import { usePersistedState } from "../_use-persisted-state";

interface PromptPreset {
  id: number;
  name: string;
  content: string;
  description: string | null;
  animation_motion: string | null;
  image_prompt: string | null;
  heygen_voice_id: string | null;
  created_at: string;
  updated_at: string;
}

const META: { name: string; label: string; help: string; rows: number }[] = [
  {
    name: "scene_split",
    label: "Scene Split — system prompt for Gemini",
    help:
      "The DEFAULT prompt for slicing a script into scenes. Used when a run has no channel selected. " +
      "Channel profiles above each carry their own scene_split prompt that overrides this. See docs/PROMPT-GUIDE.md.",
    rows: 16,
  },
  {
    name: "animation_motion",
    label: "Animation Motion — default motion style for Grok",
    help:
      "Appended to every scene's visual_prompt before being sent to Grok. Used when a run's channel " +
      "doesn't set its own Animation Motion override.",
    rows: 4,
  },
  {
    name: "image_prompt",
    label: "Image Style — (unused — video-only mode)",
    help: "Not used in Conveyer Grok (video-only, no image stage). Kept for a possible future image mode.",
    rows: 3,
  },
];

const labelStyle: React.CSSProperties = { marginTop: 6 };

function optionalNote(text: string) {
  return <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>{text}</span>;
}

export default function PromptsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const [presets, setPresets] = useState<PromptPreset[]>([]);
  const [presetError, setPresetError] = useState<string | null>(null);

  // "Add new channel" form — persisted across navigation so a half-written
  // channel prompt survives a tab switch. Cleared on successful create.
  const [newName, setNewName] = usePersistedState("channels.new.name", "");
  const [newDescription, setNewDescription] = usePersistedState("channels.new.description", "");
  const [newVoiceId, setNewVoiceId] = usePersistedState("channels.new.voiceId", "");
  const [newContent, setNewContent] = usePersistedState("channels.new.content", "");
  const [newAnimationMotion, setNewAnimationMotion] = usePersistedState(
    "channels.new.animationMotion",
    ""
  );

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editVoiceId, setEditVoiceId] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editAnimationMotion, setEditAnimationMotion] = useState("");

  async function load() {
    const r = await fetch("/api/prompts");
    setValues(await r.json());
  }
  async function loadPresets() {
    const r = await fetch("/api/prompt-presets");
    setPresets(await r.json());
  }
  useEffect(() => {
    load();
    loadPresets();
  }, []);

  async function save() {
    await fetch("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function createPreset() {
    setPresetError(null);
    if (!newName.trim() || !newContent.trim()) {
      setPresetError("Channel name and Scene Split prompt are both required");
      return;
    }
    const r = await fetch("/api/prompt-presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName,
        content: newContent,
        description: newDescription.trim() || null,
        heygen_voice_id: newVoiceId.trim() || null,
        animation_motion: newAnimationMotion.trim() || null,
      }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setPresetError(j.error ?? `HTTP ${r.status}`);
      return;
    }
    setNewName("");
    setNewDescription("");
    setNewVoiceId("");
    setNewContent("");
    setNewAnimationMotion("");
    await loadPresets();
  }

  function startEdit(p: PromptPreset) {
    setEditingId(p.id);
    setEditName(p.name);
    setEditDescription(p.description ?? "");
    setEditVoiceId(p.heygen_voice_id ?? "");
    setEditContent(p.content);
    setEditAnimationMotion(p.animation_motion ?? "");
    setPresetError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditDescription("");
    setEditVoiceId("");
    setEditContent("");
    setEditAnimationMotion("");
  }

  async function saveEdit() {
    if (editingId == null) return;
    setPresetError(null);
    const r = await fetch(`/api/prompt-presets/${editingId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName,
        content: editContent,
        description: editDescription.trim() || null,
        heygen_voice_id: editVoiceId.trim() || null,
        animation_motion: editAnimationMotion.trim() || null,
      }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setPresetError(j.error ?? `HTTP ${r.status}`);
      return;
    }
    cancelEdit();
    await loadPresets();
  }

  async function deletePreset(id: number) {
    if (!confirm("Delete this channel profile? Past runs that used it keep their snapshot.")) return;
    await fetch(`/api/prompt-presets/${id}`, { method: "DELETE" });
    if (editingId === id) cancelEdit();
    await loadPresets();
  }

  return (
    <div>
      <h1>Channels &amp; Prompts</h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: 14, lineHeight: 1.6 }}>
        A <strong style={{ color: "var(--fg)" }}>channel profile</strong> bundles everything specific
        to one YouTube channel — its scene-split prompt, HeyGen voice, motion style. Pick a channel on
        the New Run page and all of it applies in one click. The Default prompts at the bottom are used
        only when no channel is selected.
      </p>

      {/* ─── Channels ───────────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Channels</h2>
          <span className="badge badge-neutral">{presets.length}</span>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 16, lineHeight: 1.55 }}>
          One profile per channel. Required: name + Scene Split prompt. Optional: a HeyGen voice_id
          (overrides the global voice), an Animation Motion override, and a description. Empty optional
          fields fall back to global defaults.
        </p>

        {presetError && (
          <div
            style={{
              background: "var(--danger-soft)",
              border: "1px solid rgba(248,113,113,0.3)",
              padding: "9px 12px",
              borderRadius: "var(--r-sm)",
              marginBottom: 12,
              color: "var(--danger)",
              fontSize: 13,
            }}
          >
            {presetError}
          </div>
        )}

        {presets.length === 0 && (
          <div className="muted" style={{ fontSize: 13, marginBottom: 16, fontStyle: "italic" }}>
            No channels yet. Add one below.
          </div>
        )}

        {presets.map((p) => (
          <div
            key={p.id}
            className="card-inset"
            style={{ padding: 14, marginBottom: 10 }}
          >
            {editingId === p.id ? (
              <>
                <label className="label" style={labelStyle}>
                  Channel name <span style={{ color: "var(--danger)" }}>*</span>
                </label>
                <input
                  className="input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Channel name"
                  style={{ marginBottom: 10 }}
                />
                <label className="label" style={labelStyle}>
                  Description {optionalNote("(optional note — for your reference)")}
                </label>
                <input
                  className="input"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="e.g. Longevity / Blue Zone documentary, audience 50-75"
                  style={{ marginBottom: 10 }}
                />
                <label className="label" style={labelStyle}>
                  HeyGen voice_id {optionalNote("(optional — empty uses the global HEYGEN_VOICE_ID)")}
                </label>
                <input
                  className="input"
                  value={editVoiceId}
                  onChange={(e) => setEditVoiceId(e.target.value)}
                  placeholder="e.g. 1021285c663b465bb2af8b9f9c596d0c"
                  style={{ marginBottom: 10 }}
                />
                <label className="label" style={labelStyle}>
                  Scene Split prompt <span style={{ color: "var(--danger)" }}>*</span>
                </label>
                <textarea
                  className="textarea"
                  rows={12}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  style={{ marginBottom: 10 }}
                />
                <label className="label" style={labelStyle}>
                  Animation Motion override {optionalNote("(optional — empty uses the global default)")}
                </label>
                <textarea
                  className="textarea"
                  rows={4}
                  value={editAnimationMotion}
                  onChange={(e) => setEditAnimationMotion(e.target.value)}
                  placeholder="Leave empty to inherit the default Animation Motion prompt."
                  style={{ marginBottom: 12 }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn" onClick={saveEdit}>
                    Save
                  </button>
                  <button className="btn-secondary" onClick={cancelEdit}>
                    Cancel
                  </button>
                  <button className="btn-danger" onClick={() => deletePreset(p.id)} style={{ marginLeft: "auto" }}>
                    Delete
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 650, fontSize: 14.5 }}>{p.name}</div>
                  {p.heygen_voice_id && (
                    <span className="badge badge-success" title={`Custom HeyGen voice: ${p.heygen_voice_id}`}>
                      voice
                    </span>
                  )}
                  {p.animation_motion && (
                    <span className="badge badge-accent" title="Custom Animation Motion override">
                      motion
                    </span>
                  )}
                  <div className="faint" style={{ fontSize: 11.5, marginLeft: "auto" }}>
                    {new Date(p.updated_at).toLocaleDateString()}
                  </div>
                  <button className="btn-secondary btn-sm" onClick={() => startEdit(p)}>
                    Edit
                  </button>
                </div>
                {p.description && (
                  <div style={{ color: "var(--fg-muted)", fontSize: 12.5, marginTop: 6 }}>
                    {p.description}
                  </div>
                )}
                <div className="faint" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                  {p.content.slice(0, 150)}
                  {p.content.length > 150 ? "…" : ""}
                </div>
              </>
            )}
          </div>
        ))}

        {/* New channel form */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, marginTop: 16 }}>
          <h3 style={{ marginBottom: 10 }}>Add new channel</h3>

          <label className="label" style={labelStyle}>
            Channel name <span style={{ color: "var(--danger)" }}>*</span>
          </label>
          <input
            className="input"
            placeholder="e.g. The Blue Zone Way"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ marginBottom: 10 }}
          />

          <label className="label" style={labelStyle}>
            Description {optionalNote("(optional note — for your reference)")}
          </label>
          <input
            className="input"
            placeholder="e.g. Longevity / Blue Zone documentary, audience 50-75"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            style={{ marginBottom: 10 }}
          />

          <label className="label" style={labelStyle}>
            HeyGen voice_id {optionalNote("(optional — empty uses the global HEYGEN_VOICE_ID setting)")}
          </label>
          <input
            className="input"
            placeholder="e.g. 1021285c663b465bb2af8b9f9c596d0c"
            value={newVoiceId}
            onChange={(e) => setNewVoiceId(e.target.value)}
            style={{ marginBottom: 10 }}
          />

          <label className="label" style={labelStyle}>
            Scene Split prompt <span style={{ color: "var(--danger)" }}>*</span>
          </label>
          <textarea
            className="textarea"
            rows={9}
            placeholder="Paste this channel's scene_split system prompt. See docs/PROMPT-GUIDE.md."
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <button
            className="btn-ghost btn-sm"
            onClick={() => setNewContent(values.scene_split ?? "")}
            title="Copy the current default scene_split as a starting point"
            style={{ marginBottom: 12 }}
          >
            ↓ Copy scene_split from default
          </button>

          <label className="label" style={labelStyle}>
            Animation Motion override {optionalNote("(optional — empty uses the global default)")}
          </label>
          <textarea
            className="textarea"
            rows={3}
            placeholder="Leave empty to inherit the default. Fill in for a per-channel motion style."
            value={newAnimationMotion}
            onChange={(e) => setNewAnimationMotion(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <button
            className="btn-ghost btn-sm"
            onClick={() => setNewAnimationMotion(values.animation_motion ?? "")}
            title="Copy the current default Animation Motion as a starting point"
            style={{ marginBottom: 14 }}
          >
            ↓ Copy motion from default
          </button>

          <div>
            <button className="btn" onClick={createPreset}>
              Add channel
            </button>
          </div>
        </div>
      </div>

      {/* ─── Default prompts ────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Default prompts</h2>
        <button className="btn btn-sm" onClick={save}>
          {saved ? "Saved ✓" : "Save all prompts"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 14, lineHeight: 1.5 }}>
        Used when a run has no channel selected, or when a channel leaves a field empty. Changes take
        effect on the next run — no restart needed.
      </p>
      {META.map((m) => (
        <div key={m.name} className="card" style={{ marginBottom: 14 }}>
          <h3 style={{ marginBottom: 4 }}>{m.label}</h3>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.5 }}>
            {m.help}
          </p>
          <textarea
            className="textarea"
            rows={m.rows}
            value={values[m.name] ?? ""}
            onChange={(e) => setValues({ ...values, [m.name]: e.target.value })}
          />
        </div>
      ))}
    </div>
  );
}

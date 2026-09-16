"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useT } from "./_i18n";
import { AvatarSelect } from "./_components/AvatarSelect";

interface AvatarLite {
  id: number;
  name: string;
  status: "pending" | "training" | "ready" | "error";
  channel_id: number | null;
}
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
}
type VisualMode = "ai" | "real" | "mix";
/** Where the narration comes from: we synthesize it, or the operator already recorded it. */
type InputSource = "script" | "upload";
/** What POST /api/uploads/voiceover returns, plus the local filename for display. */
interface UploadedVoiceover {
  uploadId: string;
  durationSec: number;
  sizeBytes: number;
  codec: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  filename: string;
}

const DRAFT_KEY = "fvg.createDraft";

/** "2m 14s" — mirrors the server's formatDurationHuman so both read the same. */
function humanDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export default function CreerVideoPage() {
  const router = useRouter();
  const tr = useT();
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  // Narration source. "script" is the default and leaves every existing control exactly
  // as it was; "upload" swaps ONLY the script box for the file picker.
  const [inputSource, setInputSource] = useState<InputSource>("script");
  const [upload, setUpload] = useState<UploadedVoiceover | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Whether a Groq key is set, read from /api/settings so the upload callout can nag only
  // while it's missing. null = not yet known (don't flash either state before the fetch lands).
  const [groqConfigured, setGroqConfigured] = useState<boolean | null>(null);
  // Drag-over highlight for the dropzone. Counted rather than boolean: dragging across a
  // child element fires dragleave on the parent, which would flicker the highlight off.
  const [dragDepth, setDragDepth] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatars, setAvatars] = useState<AvatarLite[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [avatarId, setAvatarId] = useState<number | null>(null);
  const [visualMode, setVisualMode] = useState<VisualMode>("mix");
  const [realPercent, setRealPercent] = useState(50);
  const [secondsPerVisual, setSecondsPerVisual] = useState(4.5);
  const [avatarPercent, setAvatarPercent] = useState(15);
  const [sceneTransitions, setSceneTransitions] = useState(false);
  // Informational Overlays (Stage 1) — per-run, default OFF. Same shape as sceneTransitions.
  const [overlays, setOverlays] = useState(false);
  // Real Footage fallback behavior — per-run (POST body → runs.config_json), not a global
  // setting, so a Resume replays the mode this run was created with. "ai" = unchanged.
  const [realFallback, setRealFallback] = useState<"ai" | "strict">("ai");
  // AI Media / Real Footage Media — global settings (KIE_AI_MEDIA / REAL_MEDIA) surfaced here
  // contextually per visual mode. Seeded from /api/settings; a change persists back to the same
  // key, so they stay the single source of truth (no per-run plumbing, pipeline unchanged).
  const [aiMedia, setAiMedia] = useState("image");
  const [realMedia, setRealMedia] = useState("auto");
  // Photo/video split of the AI b-roll — PER-RUN, unlike the two dropdowns above: it is a
  // ratio the operator sets for this video, so it travels in the POST body into
  // config_json rather than editing a global. Only sent while AI media is "auto"; the
  // "image"/"video" modes are hard overrides and this must not weaken them.
  const [aiVideoPercent, setAiVideoPercent] = useState(30);
  const [busy, setBusy] = useState(false);
  // Whether a saved draft already chose the avatar — so the avatars fetch below
  // doesn't auto-select the first one over the user's restored choice.
  const draftChoseAvatar = useRef(false);
  const restored = useRef(false);

  // Restore an in-progress draft when returning to this page (navigating to
  // another tab and back used to wipe everything the user had typed).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) { restored.current = true; return; }
      const d = JSON.parse(raw);
      if (typeof d.title === "string") setTitle(d.title);
      if (typeof d.script === "string") setScript(d.script);
      if (d.channelId === null || typeof d.channelId === "number") setChannelId(d.channelId);
      if (d.avatarId === null || typeof d.avatarId === "number") { setAvatarId(d.avatarId); draftChoseAvatar.current = true; }
      if (d.visualMode === "ai" || d.visualMode === "real" || d.visualMode === "mix") setVisualMode(d.visualMode);
      if (Number.isFinite(d.realPercent)) setRealPercent(d.realPercent);
      if (Number.isFinite(d.aiVideoPercent)) setAiVideoPercent(d.aiVideoPercent);
      // secondsPerVisual is intentionally NOT restored from the draft — it is seeded
      // from the global SECONDS_PER_VISUAL below so the on-screen value is the single,
      // visible source of truth (a stale draft must not silently resurrect an old value).
      if (Number.isFinite(d.avatarPercent)) setAvatarPercent(d.avatarPercent);
      if (typeof d.sceneTransitions === "boolean") setSceneTransitions(d.sceneTransitions);
      if (typeof d.overlays === "boolean") setOverlays(d.overlays);
      if (d.realFallback === "ai" || d.realFallback === "strict") setRealFallback(d.realFallback);
      // A File can't be serialized, but the staged uploadId can — so a draft restores the
      // already-uploaded voiceover without re-sending the audio.
      if (d.inputSource === "script" || d.inputSource === "upload") setInputSource(d.inputSource);
      if (d.upload && typeof d.upload.uploadId === "string") setUpload(d.upload as UploadedVoiceover);
      // A draft written before the per-video voice control was removed may still carry
      // `voiceId`/`voiceBackend`. Ignoring them is deliberate: the voice now comes from the
      // channel, and silently narrating a video with a choice made in an interface that no
      // longer exists is exactly the kind of invisible state this page must not keep.
    } catch { /* ignore corrupt draft */ }
    restored.current = true;
  }, []);

  // Persist the draft as the user edits (skipped until the restore pass ran, so
  // we never overwrite a saved draft with the initial empty state).
  useEffect(() => {
    if (!restored.current) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ title, script, channelId, avatarId, visualMode, realPercent, aiVideoPercent, avatarPercent, sceneTransitions, overlays, realFallback, inputSource, upload }));
    } catch { /* quota / private mode */ }
  }, [title, script, channelId, avatarId, visualMode, realPercent, aiVideoPercent, avatarPercent, sceneTransitions, overlays, realFallback, inputSource, upload]);

  useEffect(() => {
    fetch("/api/avatars")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows: AvatarLite[] | null) => {
        if (!Array.isArray(rows)) return; // transient error → keep what we have
        setAvatars(rows);
        const firstReady = rows.find((a) => a.status === "ready");
        if (firstReady && !draftChoseAvatar.current) setAvatarId(firstReady.id);
      })
      .catch(() => {});
    fetch("/api/channels")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows: Channel[] | null) => { if (Array.isArray(rows)) setChannels(rows); })
      .catch(() => {});
    // Seed the on-screen "Seconds per visual" default from the global setting, so the
    // visible control is the single source of truth (initialized from the global, not
    // a hardcoded 4.5 and not a stale draft). The user can still override it per run.
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        const n = Number(s?.SECONDS_PER_VISUAL); if (Number.isFinite(n) && n > 0) setSecondsPerVisual(n);
        // Seed the media dropdowns from the stored global settings (same keys as before).
        if (s?.KIE_AI_MEDIA === "image" || s?.KIE_AI_MEDIA === "auto" || s?.KIE_AI_MEDIA === "video") setAiMedia(s.KIE_AI_MEDIA);
        if (s?.REAL_MEDIA === "image" || s?.REAL_MEDIA === "auto" || s?.REAL_MEDIA === "video") setRealMedia(s.REAL_MEDIA);
        // Groq presence only — the value is masked (secrets come back as "…"), so a non-empty
        // string means a key is set. Drives the upload callout's warning-vs-confirmed state.
        setGroqConfigured(typeof s?.GROQ_API_KEY === "string" && s.GROQ_API_KEY.trim().length > 0);
      })
      .catch(() => {});
  }, []);

  // Persist a global media setting via the existing settings endpoint (the same one the
  // settings page uses) — these dropdowns are a live editor of KIE_AI_MEDIA / REAL_MEDIA.
  function persistSetting(key: "KIE_AI_MEDIA" | "REAL_MEDIA", value: string) {
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    }).catch(() => {});
  }

  function applyChannel(id: number | null) {
    setChannelId(id);
    const ch = channels.find((c) => c.id === id);
    if (!ch) return;
    setVisualMode(ch.visual_mode);
    // Channel no longer overrides seconds-per-visual — the on-screen control (seeded
    // from the global setting) is the single source of truth.
    if (ch.avatar_id) setAvatarId(ch.avatar_id);
  }

  const preparing = avatars.filter((a) => a.status === "pending" || a.status === "training");
  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;

  /**
   * Send the audio to /api/uploads/voiceover and keep only the returned id.
   * The raw file NEVER goes to /api/studio — that stays a small JSON request.
   * Passing the File straight as the body streams it (no base64, no multipart bloat).
   */
  async function uploadVoiceover(file: File | null) {
    if (!file) return;
    setUploadError(null);
    setUpload(null);
    setUploading(true);
    try {
      const r = await fetch(`/api/uploads/voiceover?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setUploadError(j.error || r.statusText);
        return;
      }
      setUpload({ ...(j as Omit<UploadedVoiceover, "filename">), filename: file.name });
    } catch {
      setUploadError(tr("Échec de l'envoi du fichier.", "The file could not be uploaded."));
    } finally {
      setUploading(false);
    }
  }

  /** Script mode needs a script; upload mode needs a validated upload. */
  const canStart = inputSource === "upload" ? !!upload : !!script.trim();
  const dragging = dragDepth > 0;

  async function start() {
    if (!canStart || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/studio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          // Exactly one narration source. In script mode this spreads to `script` in the
          // same position it always occupied, so the request is unchanged.
          ...(inputSource === "upload" && upload ? { voiceoverUploadId: upload.uploadId } : { script }),
          avatarId,
          channelId,
          visualMode,
          realPercent: visualMode === "mix" ? realPercent : undefined,
          // Only while the slider is actually on screen. Omitted otherwise, which leaves the
          // per-beat planner verdict in charge exactly as before — an "images only" or
          // "video only" run must not carry a ratio that contradicts it.
          aiVideoPercent:
            (visualMode === "ai" || visualMode === "mix") && aiMedia === "auto" ? aiVideoPercent : undefined,
          secondsPerVisual,
          avatarPercent,
          // visualPrompt is no longer user-facing; the channel's saved prompt (or
          // the system default) applies automatically via the studio route.
          sceneTransitions,
          overlays,
          // Only meaningful in "real" mode — send "ai" otherwise so a stale strict choice
          // can't ride along after the user switches to mix/ai.
          realFallback: visualMode === "real" || visualMode === "mix" ? realFallback : "ai",
          // No voice is sent from here: it comes from the channel (or Settings), and
          // /api/studio works out which AI84 engine that voice needs on its own. The route
          // still ACCEPTS `voiceId`/`voiceBackend` for API callers — see its Body type.
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(`${tr("Impossible de démarrer la vidéo", "Couldn't start the video")} :\n\n${j.error || r.statusText}`);
        return;
      }
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      router.push(`/runs/${j.id}`);
    } finally {
      setBusy(false);
    }
  }

  const srcSeg = (src: InputSource, label: string, desc: string) => {
    const on = inputSource === src;
    return (
      <button key={src} type="button" onClick={() => setInputSource(src)} className="card"
        aria-pressed={on}
        style={{ textAlign: "left", padding: "12px 14px", cursor: "pointer",
          // A selected source is a mode switch, not a preference — give it a ring so it
          // reads as "this is what the form below is now showing".
          border: `1.5px solid ${on ? "var(--accent)" : "var(--border)"}`,
          boxShadow: on ? "0 0 0 3px var(--accent-soft)" : "none",
          background: on ? "var(--surface-2)" : "var(--surface)",
          transition: "border-color .15s var(--ease), box-shadow .15s var(--ease), background .15s var(--ease)" }}>
        <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 2 }}>{label}</div>
        <div className="faint" style={{ fontSize: 12, lineHeight: 1.4 }}>{desc}</div>
      </button>
    );
  };

  const seg = (mode: VisualMode, label: string, desc: string) => (
    <button key={mode} type="button" onClick={() => setVisualMode(mode)} className="card"
      style={{ textAlign: "left", padding: "12px 14px", cursor: "pointer",
        borderColor: visualMode === mode ? "var(--accent)" : "var(--border)",
        background: visualMode === mode ? "var(--surface-2)" : "var(--surface)" }}>
      <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 2 }}>{label}</div>
      <div className="faint" style={{ fontSize: 12, lineHeight: 1.4 }}>{desc}</div>
    </button>
  );

  return (
    <div>
      <h1>{tr("Créer une vidéo", "Create a video")}</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: 14, lineHeight: 1.6 }}>
        {tr(
          "Collez un script, choisissez un avatar récurrent et la source des visuels — ElevenLabs narre, HeyGen anime l'avatar, et le reste est illustré par du vrai footage ou de l'IA.",
          "Paste a script, pick a recurring avatar and the visual source — ElevenLabs narrates, HeyGen animates the avatar, and the rest is illustrated with real footage or AI."
        )}
      </p>

      <div className="card" style={{ display: "grid", gap: 18 }}>
        <div className="grid-2" style={{ gap: 16 }}>
          <div>
            <label className="label">{tr("Titre (optionnel)", "Title (optional)")}</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr("ex : Le secret amish oublié", "e.g. The forgotten Amish secret")} />
          </div>
          <div>
            <label className="label">{tr("Chaîne", "Channel")}</label>
            <select className="input" value={channelId ?? ""} onChange={(e) => applyChannel(e.target.value === "" ? null : Number(e.target.value))}>
              <option value="">{tr("Aucune — réglages manuels", "None — manual settings")}</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {(() => {
              const ch = channels.find((c) => c.id === channelId);
              if (!ch) return (
                <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
                  {tr("Aucune chaîne = la voix, le prompt et les réglages de chaîne ne s'appliquent PAS.", "No channel = the channel's voice, prompt and defaults do NOT apply.")}
                </div>
              );
              return (
                <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
                  {tr("Cette chaîne applique : ", "This channel applies: ")}
                  {tr("voix", "voice")} {ch.voice_id ? "✓" : tr("par défaut", "default")} · prompt {ch.visual_prompt ? "✓" : "—"} · {ch.interval_sec}s · {ch.visual_mode} · {ch.format}
                </div>
              );
            })()}
          </div>
        </div>

        {/* No voice picker here, deliberately. The voice belongs to the CHANNEL — /channels
            has the list, clones first — and a run snapshots it at create time, so videos on
            different channels narrate with different voices (and different AI84 engines) at
            the same time. That is what a per-video picker was originally asked for, and the
            channel does it without putting a control on this page that shows an error line
            on every install whose voice catalogue can't be reached. */}

        {/* Narration source. Two cards, same idiom as the visual-mode selector below. */}
        <div>
          <label className="label">{tr("Source de la narration", "Narration source")}</label>
          <div className="grid-2" style={{ gap: 10 }}>
            {srcSeg("script", tr("✍  Script → voix", "✍  Script → voiceover"), tr("Nous générons la narration.", "We generate the narration."))}
            {srcSeg("upload", tr("🎙  Importer une voix", "🎙  Upload voiceover"), tr("Vous fournissez l'audio.", "You supply the audio."))}
          </div>
        </div>

        {inputSource === "script" ? (
          <div>
            <label className="label">{tr("Script", "Script")}</label>
            <textarea className="input" value={script} onChange={(e) => setScript(e.target.value)}
              placeholder={tr("Collez ici le script complet de la narration…", "Paste the full narration script here…")} rows={9}
              style={{ resize: "vertical", lineHeight: 1.55, fontFamily: "inherit" }} />
            <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
              {wordCount} {tr("mots", "words")} · ≈ {Math.max(1, Math.round(wordCount / 150))} {tr("min de narration", "min of narration")}
            </div>
          </div>
        ) : (
          <div>
            <label className="label">{tr("Fichier de narration", "Voiceover file")}</label>

            {/* The whole area is the target: drag & drop OR click anywhere to browse. The
                accent outline makes it the page's visual focus once Upload is chosen — the
                small native picker it replaces was too easy to miss. */}
            <div
              role="button"
              tabIndex={0}
              aria-label={tr("Déposer ou choisir un fichier audio", "Drop or choose an audio file")}
              onClick={() => !uploading && fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !uploading) {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragEnter={(e) => { e.preventDefault(); setDragDepth((d) => d + 1); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
              onDrop={(e) => {
                e.preventDefault();
                setDragDepth(0);
                if (!uploading) uploadVoiceover(e.dataTransfer.files?.[0] ?? null);
              }}
              style={{
                position: "relative",
                display: "grid",
                justifyItems: "center",
                gap: 8,
                textAlign: "center",
                padding: "30px 20px",
                cursor: uploading ? "progress" : "pointer",
                borderRadius: "var(--r-lg)",
                border: `1.5px dashed ${dragging ? "var(--accent-hover)" : "var(--accent)"}`,
                background: dragging ? "var(--accent-soft)" : "var(--surface-2)",
                boxShadow: dragging ? "0 0 0 4px var(--accent-ring)" : "0 0 0 3px var(--accent-soft)",
                transition: "background .15s var(--ease), border-color .15s var(--ease), box-shadow .15s var(--ease)",
              }}
            >
              <input
                ref={fileInputRef}
                id="voiceover-file"
                type="file"
                accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus"
                disabled={uploading}
                onChange={(e) => uploadVoiceover(e.target.files?.[0] ?? null)}
                style={{ display: "none" }}
              />

              {upload && !uploading ? (
                /* Uploaded — the zone becomes the receipt, and stays clickable to replace. */
                <>
                  <div style={{ fontSize: 30, lineHeight: 1, color: "var(--success)" }}>✓</div>
                  <div style={{ fontWeight: 650, fontSize: 15, wordBreak: "break-all" }}>{upload.filename}</div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {humanDuration(upload.durationSec)}
                    {` • ${(upload.sizeBytes / 1024 / 1024).toFixed(1)} MB`}
                    {upload.sampleRateHz ? ` • ${(upload.sampleRateHz / 1000).toFixed(1)} kHz` : ""}
                    {upload.channels ? ` • ${upload.channels === 1 ? tr("mono", "mono") : tr("stéréo", "stereo")}` : ""}
                  </div>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    style={{ marginTop: 4 }}
                  >
                    {tr("Choisir un autre fichier", "Choose a different file")}
                  </button>
                </>
              ) : uploading ? (
                <>
                  <div style={{ fontSize: 34, lineHeight: 1 }}>⏳</div>
                  <div style={{ fontWeight: 650, fontSize: 15 }}>{tr("Envoi et analyse…", "Uploading and checking…")}</div>
                  <div className="faint" style={{ fontSize: 12.5 }}>
                    {tr("Vérification du format et de la durée.", "Checking the format and length.")}
                  </div>
                </>
              ) : (
                <>
                  {/* Inline SVG, not an emoji: the system ⬆️ glyph renders blue-grey and
                      fought both the dark surface and the red accent. */}
                  <svg width="46" height="46" viewBox="0 0 24 24" fill="none" aria-hidden="true"
                    stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 16V4" />
                    <path d="M7 9l5-5 5 5" />
                    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                  </svg>
                  <div style={{ fontWeight: 650, fontSize: 15.5 }}>
                    {tr("Déposez un fichier audio ici, ou cliquez pour parcourir", "Drop an audio file here, or click to browse")}
                  </div>
                  <div className="faint" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                    <div>{tr("Formats : mp3, wav, m4a, aac, flac, ogg", "Formats: mp3, wav, m4a, aac, flac, ogg")}</div>
                    <div>{tr("Durée maximale : 50 minutes", "Maximum length: 50 minutes")}</div>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    style={{ marginTop: 6, padding: "11px 22px", fontSize: 14 }}
                  >
                    {tr("Choisir un fichier", "Choose file")}
                  </button>
                </>
              )}
            </div>

            {uploadError && (
              <div style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.45, color: "var(--warning)" }}>
                ⚠ {uploadError}
              </div>
            )}

            {upload && !uploading && (
              <div className="faint" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.55 }}>
                <div>
                  {tr(
                    "Nous transcrirons votre narration avec Groq Whisper pour synchroniser les visuels.",
                    "We'll transcribe your narration with Groq Whisper to synchronize the visuals."
                  )}
                </div>
                <div>
                  {tr(
                    "Aucun coût de génération vocale — vous fournissez l'audio.",
                    "No voiceover generation cost — you provide the audio."
                  )}
                </div>
              </div>
            )}

            {/* The Groq requirement isn't obvious — a first-time user would only discover it
                as a 409 after picking a file. Surface it the moment Upload is chosen. Adaptive:
                warn (with a route to Settings) while the key is missing, and once it's set fall
                back to a quiet confirmation instead of nagging. Held until the settings fetch
                resolves so neither state flashes. */}
            <div
              style={{
                marginTop: 12,
                padding: 14,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--r)",
              }}
            >
              <div style={{ fontWeight: 650, fontSize: 14 }}>
                🎙 {tr("Importer une voix", "Upload Voiceover")}
              </div>
              <div className="faint" style={{ fontSize: 12.5, marginTop: 5, lineHeight: 1.5 }}>
                {tr(
                  "Importez votre narration et nous synchroniserons les visuels avec Groq Whisper.",
                  "Upload your narration and we'll synchronize the visuals using Groq Whisper."
                )}
              </div>

              {groqConfigured === false && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--warning)", fontWeight: 600, fontSize: 13 }}>
                    <span aria-hidden="true">⚠</span>
                    {tr("Clé API Groq requise", "Groq API Key required")}
                  </div>
                  <div className="faint" style={{ fontSize: 12.5, marginTop: 5, lineHeight: 1.5 }}>
                    <div>
                      {tr(
                        "Pour utiliser cette fonctionnalité, ajoutez votre clé API Groq dans les Paramètres.",
                        "To use this feature, add your Groq API Key in Settings."
                      )}
                    </div>
                    <div style={{ marginTop: 4 }}>
                      {tr(
                        "Groq propose une offre gratuite : vous pouvez utiliser cette fonctionnalité sans acheter de crédits.",
                        "Groq offers a free API tier, so you can use this feature without purchasing credits."
                      )}
                    </div>
                  </div>
                  <Link
                    href="/settings"
                    className="btn-secondary"
                    style={{ marginTop: 11, textDecoration: "none" }}
                  >
                    {tr("Ouvrir les Paramètres", "Open Settings")}
                  </Link>
                </div>
              )}

              {groqConfigured === true && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 10, color: "var(--success)", fontSize: 12.5, fontWeight: 600 }}>
                  <span aria-hidden="true">✅</span>
                  {tr(
                    "Clé API Groq configurée. L'importation de voix est prête à l'emploi.",
                    "Groq API Key configured. Upload Voiceover is ready to use."
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div>
          <label className="label">{tr("Avatar", "Avatar")}</label>
          <AvatarSelect avatars={avatars} value={avatarId} onChange={setAvatarId} />
          <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
            {preparing.length > 0 && `${preparing.length} ${tr("avatar(s) en préparation", "avatar(s) preparing")} · `}
            <Link href="/avatars">{tr("Créer ou gérer les avatars →", "Create or manage avatars →")}</Link>
          </div>
          {(() => {
            // Picking an avatar does NOT pick its channel — a tester assumed it
            // does and lost the channel's voice/prompt. Offer the one-click fix.
            const av = avatars.find((a) => a.id === avatarId);
            const ch = av?.channel_id != null ? channels.find((c) => c.id === av.channel_id) : undefined;
            if (!ch || channelId === ch.id) return null;
            return (
              <div style={{ fontSize: 12.5, color: "#b45309", marginTop: 6 }}>
                ⚠ {tr(`Cet avatar appartient à la chaîne « ${ch.name} », mais elle n'est pas sélectionnée — sa voix et son prompt ne s'appliqueront pas.`,
                       `This avatar belongs to channel "${ch.name}", but that channel isn't selected — its voice and prompt won't apply.`)}{" "}
                <button type="button" onClick={() => applyChannel(ch.id)}
                  style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontSize: 12.5, textDecoration: "underline" }}>
                  {tr(`Utiliser la chaîne « ${ch.name} »`, `Use channel "${ch.name}"`)}
                </button>
              </div>
            );
          })()}
        </div>

        {/* Everything below is optional — a picked channel already sets it.
            Collapsed by default so the common flow is just script + avatar +
            channel + Generate (tester asked for a simpler screen). */}
        {/* Always expanded, deliberately. These are not "advanced" in practice — visual mode,
            the real/AI balance and the fallback behaviour are chosen on essentially every run,
            and hiding them behind a disclosure meant operators shipped videos on defaults they
            never saw. Kept as a plain section rather than an open <details> so it can't be
            collapsed by a stray click. */}
        <section style={{ border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "10px 14px", background: "var(--surface)" }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>
            {tr("Réglages de la vidéo", "Video settings")}
          </div>
          <div className="faint" style={{ fontSize: 12, margin: "4px 0 14px" }}>
            {tr(
              "Inutile si vous avez choisi une chaîne — elle applique déjà ces réglages.",
              "Not needed if you picked a channel — it already applies these settings."
            )}
          </div>
          <div style={{ display: "grid", gap: 16 }}>
            <div>
              <label className="label">{tr("Mode visuel", "Visual mode")}</label>
              <div className="grid-3" style={{ gap: 10 }}>
                {seg("ai", tr("100% IA", "Full AI"), tr("B-roll généré (nano-banana / Veo)", "Generated b-roll (nano-banana / Veo)"))}
                {seg("real", tr("Vrai footage", "Real footage"), tr("Vidéos & images réelles d'internet", "Real videos & images from the internet"))}
                {seg("mix", tr("Mix", "Mix"), tr("Mélange réel + IA", "Blend real + AI"))}
              </div>
            </div>

            {(visualMode === "ai" || visualMode === "mix") && (
              <div>
                <label className="label">{tr("Média IA", "AI media")}</label>
                <select className="input" value={aiMedia}
                  onChange={(e) => { setAiMedia(e.target.value); persistSetting("KIE_AI_MEDIA", e.target.value); }}>
                  <option value="image">{tr("Images seulement (photos + zoom)", "Images only (photos + zoom)")}</option>
                  <option value="auto">{tr("Auto (photos et vidéo)", "Auto (photos + video)")}</option>
                  <option value="video">{tr("Vidéo seulement (+ réaliste, + cher)", "Video only (more realistic, pricier)")}</option>
                </select>
                <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
                  {tr("S'applique au b-roll IA. Par défaut : images seulement (le moins cher).", "Applies to AI b-roll. Default: images only (cheapest).")}
                </div>
              </div>
            )}

            {(visualMode === "ai" || visualMode === "mix") && aiMedia === "auto" && (
              <div>
                <label className="label">
                  {tr("Équilibre photo / vidéo IA", "AI photo / video balance")} — {100 - aiVideoPercent}% {tr("photo", "photo")} / {aiVideoPercent}% {tr("vidéo", "video")}
                </label>
                <input type="range" min={0} max={100} step={5} value={aiVideoPercent}
                  onChange={(e) => setAiVideoPercent(Number(e.target.value))} style={{ width: "100%" }} />
                <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
                  {tr(
                    "Part des plans IA rendus en vidéo générée. La vidéo coûte plus cher et ajoute quelques minutes par plan.",
                    "Share of the AI shots rendered as generated video. Video costs more and adds a few minutes per shot."
                  )}
                </div>
              </div>
            )}

            {(visualMode === "real" || visualMode === "mix") && (
              <div>
                <label className="label">{tr("Média footage réel", "Real footage media")}</label>
                <select className="input" value={realMedia}
                  onChange={(e) => { setRealMedia(e.target.value); persistSetting("REAL_MEDIA", e.target.value); }}>
                  <option value="image">{tr("Photos seulement", "Photos only")}</option>
                  <option value="auto">{tr("Photos + vidéos", "Photos + videos")}</option>
                  <option value="video">{tr("Vidéos seulement", "Videos only")}</option>
                </select>
                <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
                  {tr("Types de footage réel autorisés. Par défaut : photos + vidéos.", "Which real assets may be used. Default: photos + videos.")}
                </div>
              </div>
            )}

            {/* Fallback behavior — offered in "real" AND "mix". Per-run (goes in the POST body,
                not a global setting) so a Resume replays the mode the run was created with.
                It governs ONLY what happens to a beat the planner assigned to REAL footage when
                no candidate clears the relevance bar (visual-source gates on `beat.source ===
                "real"`), so in mix the AI half is untouched — blending is still the point of mix.
                It matters most in mix, in fact: an operator whose AI provider is out of credits
                got a third of his video filled with duplicated neighbouring shots, while real
                clips scoring 65% sat discarded. "Real footage only" spends those instead. */}
            {(visualMode === "real" || visualMode === "mix") && (
              <div>
                <label className="label">{tr("Comportement de repli", "Fallback behavior")}</label>
                {/* In mix the AI share is generated by design, so "never generates AI" would be a
                    lie there — the setting only ever governs beats assigned to REAL footage.
                    Say which share it touches, and word the strict option for the mode. */}
                {visualMode === "mix" && (
                  <div className="faint" style={{ fontSize: 12, margin: "-2px 0 8px" }}>
                    {tr(
                      `S'applique uniquement à la part de footage réel (${realPercent} %) — la part IA n'est pas affectée.`,
                      `Applies only to the real-footage share (${realPercent}%) — the AI share is unaffected.`
                    )}
                  </div>
                )}
                <div style={{ display: "grid", gap: 8 }}>
                  {([
                    {
                      v: "ai" as const,
                      title: tr("Autoriser le repli IA (recommandé)", "Allow AI fallback (Recommended)"),
                      desc: tr(
                        "Si aucun footage réel adapté n'est trouvé, des médias générés par IA peuvent être utilisés pour quelques scènes.",
                        "If suitable real footage cannot be found, AI-generated media may be used for a few scenes."
                      ),
                    },
                    {
                      v: "strict" as const,
                      title: visualMode === "mix"
                        ? tr("Footage réel uniquement (part réelle)", "Real footage only (for the real share)")
                        : tr("Footage réel uniquement", "Real footage only"),
                      desc: visualMode === "mix"
                        ? tr(
                            "Ces scènes ne basculent jamais vers l'IA : accepte un footage moins pertinent — ou réutilise un plan réel voisin. Utile si vos crédits IA s'épuisent.",
                            "Those scenes never switch to AI: accepts less relevant footage — or reuses a neighbouring real shot. Useful if your AI credits run out."
                          )
                        : tr(
                            "Ne génère jamais d'IA. Continue de chercher et accepte un footage moins pertinent — ou réutilise un plan réel voisin.",
                            "Never generates AI. Keeps searching and accepts less relevant footage — or reuses a neighbouring real shot."
                          ),
                    },
                  ]).map((o) => (
                    <label
                      key={o.v}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                        border: `1.5px solid ${realFallback === o.v ? "var(--accent)" : "var(--border)"}`,
                        borderRadius: "var(--r-sm)", padding: "10px 12px",
                        background: realFallback === o.v ? "var(--surface)" : "transparent",
                      }}
                    >
                      <input
                        type="radio"
                        name="realFallback"
                        checked={realFallback === o.v}
                        onChange={() => setRealFallback(o.v)}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>{o.title}</span>
                        <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 2, lineHeight: 1.4 }}>{o.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {visualMode === "mix" && (
              <div>
                <label className="label">
                  {tr("Équilibre réel / IA", "Real / AI balance")} — {realPercent}% {tr("réel", "real")} / {100 - realPercent}% {tr("IA", "AI")}
                </label>
                <input type="range" min={0} max={100} step={5} value={realPercent} onChange={(e) => setRealPercent(Number(e.target.value))} style={{ width: "100%" }} />
              </div>
            )}

            <div>
              <label className="label">{tr("Intervalle par visuel (s)", "Seconds per visual")}</label>
              <input className="input" type="number" min={1.5} max={20} step={0.5} value={secondsPerVisual}
                onChange={(e) => { const n = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(n)) setSecondsPerVisual(n); }} />
            </div>

            <div>
              <label className="label">{tr("Avatar à l'écran", "Avatar on screen")} — {avatarPercent}% {tr("des plans", "of beats")}</label>
              <input type="range" min={0} max={60} step={5} value={avatarPercent} disabled={avatarId == null}
                onChange={(e) => setAvatarPercent(Number(e.target.value))} style={{ width: "100%", opacity: avatarId == null ? 0.4 : 1 }} />
              <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
                {avatarId == null ? tr("Choisissez un avatar pour activer.", "Pick an avatar to enable.") : tr("Fréquence d'apparition de l'avatar.", "How often the avatar appears.")}
              </div>
            </div>

            <div>
              <label className="label" style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={sceneTransitions} onChange={(e) => setSceneTransitions(e.target.checked)} />
                {tr("Transitions entre scènes (fondu au noir)", "Scene transitions (dip to black)")}
              </label>
              <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
                {tr(
                  "Court fondu au noir entre chaque plan. Désactivé = coupures franches (par défaut). Durée réglable dans Réglages avancés.",
                  "A brief dip to black between beats. Off = hard cuts (default). Duration is set in Advanced settings."
                )}
              </div>
            </div>

            <div>
              <label className="label" style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={overlays} onChange={(e) => setOverlays(e.target.checked)} />
                {tr("Cartes d'information", "Informational overlays")}
              </label>
              <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
                {tr(
                  "Cartes contextuelles automatiques (dates, noms, faits, titres de section) affichées quelques secondes aux moments clés. Désactivé par défaut.",
                  "Automatic context cards (dates, names, facts, section titles) shown for a few seconds at key moments. Off by default."
                )}
              </div>
            </div>
          </div>
        </section>

        <div>
          <button className="btn" onClick={start} disabled={busy || uploading || !canStart}>
            {busy ? tr("Démarrage…", "Starting…") : tr("Créer la vidéo", "Create the video")}
          </button>
        </div>
      </div>
    </div>
  );
}

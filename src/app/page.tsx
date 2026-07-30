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
  real_ratio_percent: number | null;
  footage_source_tiers: string | null;
}
type VisualMode = "ai" | "real" | "mix";

const DRAFT_KEY = "fvg.createDraft";

export default function CreerVideoPage() {
  const router = useRouter();
  const tr = useT();
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [avatars, setAvatars] = useState<AvatarLite[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [avatarId, setAvatarId] = useState<number | null>(null);
  const [visualMode, setVisualMode] = useState<VisualMode>("mix");
  const [realPercent, setRealPercent] = useState(50);
  // Set only via applyChannel (from the selected channel's footage_source_tiers) —
  // no standalone UI control; null = global FOOTAGE_SOURCES default.
  const [footageSourceTiers, setFootageSourceTiers] = useState<string | null>(null);
  const [secondsPerVisual, setSecondsPerVisual] = useState(4.5);
  const [avatarPercent, setAvatarPercent] = useState(15);
  const [sceneTransitions, setSceneTransitions] = useState(false);
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
      if (d.footageSourceTiers === null || typeof d.footageSourceTiers === "string") setFootageSourceTiers(d.footageSourceTiers);
      // secondsPerVisual is intentionally NOT restored from the draft — it is seeded
      // from the global SECONDS_PER_VISUAL below so the on-screen value is the single,
      // visible source of truth (a stale draft must not silently resurrect an old value).
      if (Number.isFinite(d.avatarPercent)) setAvatarPercent(d.avatarPercent);
      if (typeof d.sceneTransitions === "boolean") setSceneTransitions(d.sceneTransitions);
    } catch { /* ignore corrupt draft */ }
    restored.current = true;
  }, []);

  // Persist the draft as the user edits (skipped until the restore pass ran, so
  // we never overwrite a saved draft with the initial empty state).
  useEffect(() => {
    if (!restored.current) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ title, script, channelId, avatarId, visualMode, realPercent, avatarPercent, sceneTransitions, footageSourceTiers }));
    } catch { /* quota / private mode */ }
  }, [title, script, channelId, avatarId, visualMode, realPercent, avatarPercent, sceneTransitions, footageSourceTiers]);

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
      .then((s) => { const n = Number(s?.SECONDS_PER_VISUAL); if (Number.isFinite(n) && n > 0) setSecondsPerVisual(n); })
      .catch(() => {});
  }, []);

  function applyChannel(id: number | null) {
    setChannelId(id);
    const ch = channels.find((c) => c.id === id);
    if (!ch) return;
    setVisualMode(ch.visual_mode);
    // Channel no longer overrides seconds-per-visual — the on-screen control (seeded
    // from the global setting) is the single source of truth.
    if (ch.avatar_id) setAvatarId(ch.avatar_id);
    if (ch.real_ratio_percent != null) setRealPercent(ch.real_ratio_percent);
    setFootageSourceTiers(ch.footage_source_tiers);
  }

  const preparing = avatars.filter((a) => a.status === "pending" || a.status === "training");
  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;

  async function start() {
    if (!script.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/studio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          script,
          avatarId,
          channelId,
          visualMode,
          realPercent: visualMode === "mix" ? realPercent : undefined,
          secondsPerVisual,
          avatarPercent,
          // visualPrompt is no longer user-facing; the channel's saved prompt (or
          // the system default) applies automatically via the studio route.
          sceneTransitions,
          footageSourceTiers,
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
          "Collez un script, choisissez un avatar récurrent et la source des visuels — ElevenLabs narre, HeyGen anime l'avatar, et le reste est illustré par du vrai footage ou des images IA.",
          "Paste a script, pick a recurring avatar and the visual source — ElevenLabs narrates, HeyGen animates the avatar, and the rest is illustrated with real footage or AI images."
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

        <div>
          <label className="label">{tr("Script", "Script")}</label>
          <textarea className="input" value={script} onChange={(e) => setScript(e.target.value)}
            placeholder={tr("Collez ici le script complet de la narration…", "Paste the full narration script here…")} rows={9}
            style={{ resize: "vertical", lineHeight: 1.55, fontFamily: "inherit" }} />
          <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
            {wordCount} {tr("mots", "words")} · ≈ {Math.max(1, Math.round(wordCount / 150))} {tr("min de narration", "min of narration")}
          </div>
        </div>

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
        <details style={{ border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "10px 14px", background: "var(--surface)" }}>
          <summary style={{ cursor: "pointer", fontSize: 13.5, fontWeight: 600, userSelect: "none" }}>
            {tr("Options avancées (optionnel)", "Advanced options (optional)")}
          </summary>
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
                {seg("ai", tr("Images IA", "AI images"), tr("B-roll généré (nano-banana / Veo)", "Generated b-roll (nano-banana / Veo)"))}
                {seg("real", tr("Vrai footage", "Real footage"), tr("Vidéos & images réelles d'internet", "Real videos & images from the internet"))}
                {seg("mix", tr("Mix", "Mix"), tr("Mélange réel + IA", "Blend real + AI"))}
              </div>
            </div>

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
          </div>
        </details>

        <div>
          <button className="btn" onClick={start} disabled={busy || !script.trim()}>
            {busy ? tr("Démarrage…", "Starting…") : tr("Créer la vidéo", "Create the video")}
          </button>
        </div>
      </div>
    </div>
  );
}

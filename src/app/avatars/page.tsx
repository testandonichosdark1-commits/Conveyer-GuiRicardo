"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useT } from "../_i18n";

interface Avatar {
  id: number;
  name: string;
  description: string | null;
  engine: "talking_photo" | "photo_avatar_group";
  status: "pending" | "training" | "ready" | "error";
  error: string | null;
  use_avatar_iv: string | null;
  channel_id: number | null;
  created_at: string;
}
interface Channel { id: number; name: string }
interface LogLine { id?: number; ts: string; level: string; message: string }

const STATUS_COLOR: Record<Avatar["status"], { color: string; bg: string }> = {
  pending: { color: "#b45309", bg: "rgba(245,158,11,0.14)" },
  training: { color: "#b45309", bg: "rgba(245,158,11,0.14)" },
  ready: { color: "#15803d", bg: "rgba(34,197,94,0.15)" },
  error: { color: "#b91c1c", bg: "rgba(239,68,68,0.15)" },
};

export default function AvatarsPage() {
  const tr = useT();
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  // "Photo Avatar Group" (trained) was removed from the create UI — HeyGen animates a
  // trained look more statically (near-frozen body, neck-detach artifacts) than the
  // Talking Photo engine, so it looked worse, not better. Talking Photo is now the only
  // creation engine. The backend still supports photo_avatar_group so any pre-existing
  // trained avatars keep rendering.
  const engine = "talking_photo";
  const [useIv, setUseIv] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [heygenId, setHeygenId] = useState("");
  const [importType, setImportType] = useState<"avatar" | "talking_photo">("avatar");
  const [busy, setBusy] = useState(false);
  const [logsOpen, setLogsOpen] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const fileRef = useRef<HTMLInputElement>(null);

  const statusLabel = (s: Avatar["status"]) =>
    s === "ready" ? tr("Prêt", "Ready")
    : s === "error" ? tr("Erreur", "Error")
    : s === "training" ? tr("Entraînement…", "Training…")
    : tr("Préparation…", "Preparing…");

  const load = useCallback(async () => {
    // Never clear the list on a transient error — a momentary fetch failure used
    // to blank the grid and read as "my avatars disappeared". Only replace it
    // when the API actually returns an array.
    try {
      const r = await fetch("/api/avatars");
      if (!r.ok) return;
      const j = await r.json();
      if (Array.isArray(j)) setAvatars(j);
    } catch {
      /* keep the current list */
    }
  }, []);

  useEffect(() => {
    load();
    fetch("/api/channels")
      .then((r) => (r.ok ? r.json() : []))
      .then((j) => setChannels(Array.isArray(j) ? j : []))
      .catch(() => {});
  }, [load]);

  const anyWorking = avatars.some((a) => a.status === "pending" || a.status === "training");

  useEffect(() => {
    if (!anyWorking) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [anyWorking, load]);

  // Tick a clock while something is ingesting, to drive the "taking longer than
  // usual" hint without extra fetches.
  useEffect(() => {
    if (!anyWorking) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [anyWorking]);

  // Refresh the open diagnostics panel alongside the status poll.
  useEffect(() => {
    if (logsOpen == null) return;
    let alive = true;
    const fetchLogs = () =>
      fetch(`/api/avatars/${logsOpen}/logs`)
        .then((r) => (r.ok ? r.json() : { logs: [] }))
        .then((j) => { if (alive) setLogs(Array.isArray(j.logs) ? j.logs : []); })
        .catch(() => {});
    fetchLogs();
    const t = setInterval(fetchLogs, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [logsOpen, avatars]);

  async function retry(id: number) {
    const r = await fetch(`/api/avatars/${id}/retry`, { method: "POST" });
    if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || tr("Échec", "Failed")); return; }
    await load();
  }

  function elapsedMin(a: Avatar): number {
    const started = Date.parse(a.created_at.includes("Z") ? a.created_at : a.created_at + "Z");
    return Number.isFinite(started) ? (now - started) / 60000 : 0;
  }
  // Talking Photo should be ready in seconds; trained groups in a few minutes.
  function isSlow(a: Avatar): boolean {
    if (a.status !== "pending" && a.status !== "training") return false;
    return elapsedMin(a) > (a.engine === "photo_avatar_group" ? 6 : 1.5);
  }

  async function create() {
    const importing = heygenId.trim().length > 0;
    if (!name.trim() || (!importing && !file && !description.trim())) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("name", name.trim());
      fd.set("useAvatarIv", useIv ? "1" : "");
      if (channelId != null) fd.set("channelId", String(channelId));
      if (importing) {
        // Register an existing HeyGen avatar by id — no upload / no training.
        fd.set("heygenId", heygenId.trim());
        fd.set("importType", importType);
      } else {
        fd.set("description", description.trim());
        fd.set("engine", engine);
        if (file) fd.set("image", file);
      }
      const r = await fetch("/api/avatars", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(`${tr("Impossible de créer l'avatar", "Couldn't create the avatar")} :\n\n${j.error || r.statusText}`); return; }
      setName(""); setDescription(""); setFile(null); setHeygenId("");
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } finally { setBusy(false); }
  }

  async function remove(id: number, label: string) {
    if (!confirm(tr(`Supprimer l'avatar « ${label} » ?`, `Delete avatar "${label}"?`))) return;
    await fetch(`/api/avatars/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div>
      <h1>{tr("Avatars", "Avatars")}</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: 14, lineHeight: 1.6 }}>
        {tr(
          "Créez un avatar récurrent à partir d'une image OU d'une description. Il est mémorisé et réutilisable.",
          "Create a recurring avatar from an image OR a description. It's memorized and reusable."
        )}
      </p>

      <div className="card" style={{ display: "grid", gap: 16, marginBottom: 22 }}>
        <div className="grid-2" style={{ gap: 16 }}>
          <div>
            <label className="label">{tr("Nom", "Name")}</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("ex : Narrateur Alex", "e.g. Narrator Alex")} />
          </div>
          <div>
            <label className="label">{tr("Chaîne (optionnel)", "Channel (optional)")}</label>
            <select className="input" value={channelId ?? ""} onChange={(e) => setChannelId(e.target.value === "" ? null : Number(e.target.value))}>
              <option value="">{tr("Toutes", "All")}</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={useIv} onChange={(e) => setUseIv(e.target.checked)} />
          {tr("Moteur Avatar IV (plus réaliste, + de crédits)", "Avatar IV engine (more realistic, more credits)")}
        </label>

        <div>
          <label className="label">{tr("Image de référence (upload)", "Reference image (upload)")}</label>
          <div onClick={() => fileRef.current?.click()}
            style={{ border: `1.5px dashed ${file ? "var(--accent)" : "var(--border-strong)"}`, borderRadius: "var(--r-sm)",
              padding: "16px", textAlign: "center", cursor: "pointer", background: "var(--surface)" }}>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file ? <div style={{ fontWeight: 600, fontSize: 13.5 }}>{file.name}</div>
              : <div className="faint" style={{ fontSize: 13 }}>{tr("Choisir le fichier — portrait net, de face", "Choose a file — sharp, front-facing portrait")}</div>}
          </div>
        </div>

        <div>
          <div className="faint" style={{ textAlign: "center", fontSize: 12, margin: "-4px 0 6px" }}>{tr("— ou —", "— or —")}</div>
          <label className="label">{tr("Description textuelle (génère l'image via nano-banana)", "Text description (generates the image via nano-banana)")}</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="a friendly man in his 30s, short brown hair, blue shirt" />
        </div>

        <div>
          <div className="faint" style={{ textAlign: "center", fontSize: 12, margin: "-4px 0 6px" }}>{tr("— ou —", "— or —")}</div>
          <label className="label">{tr("Importer un avatar HeyGen existant (ID)", "Import an existing HeyGen avatar (ID)")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" style={{ flex: 1 }} value={heygenId} onChange={(e) => setHeygenId(e.target.value)}
              placeholder={tr("Collez l'ID de l'avatar HeyGen", "Paste your HeyGen avatar ID")} />
            <select className="input" style={{ width: "auto" }} value={importType} onChange={(e) => setImportType(e.target.value as typeof importType)}>
              <option value="avatar">Avatar</option>
              <option value="talking_photo">Talking Photo</option>
            </select>
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
            {tr(
              "Avatar créé directement sur HeyGen ? Collez son ID — on vérifie qu'il existe sur votre compte HeyGen et on détecte le type automatiquement (aucun upload ni entraînement).",
              "Made an avatar directly on HeyGen? Paste its ID — we verify it exists on your HeyGen account and auto-detect the type (no upload, no training)."
            )}
          </div>
        </div>

        <div>
          <button className="btn" onClick={create} disabled={busy || !name.trim() || (!file && !description.trim() && !heygenId.trim())}>
            {busy ? tr("Création…", "Creating…") : tr("Créer l'avatar", "Create avatar")}
          </button>
          {/* A disabled button looks like "the button does nothing" to a
              non-technical user — spell out exactly what's missing. */}
          {!busy && (!name.trim() || (!file && !description.trim() && !heygenId.trim())) && (
            <div style={{ fontSize: 12.5, color: "#b45309", marginTop: 8, lineHeight: 1.5 }}>
              ⚠ {tr("Pour activer le bouton, ajoutez", "To enable the button, add")}
              {": "}
              {[
                !name.trim() ? tr("un nom (champ « Nom »)", "a name (the \"Name\" field)") : null,
                !file && !description.trim() && !heygenId.trim() ? tr("une image, une description OU un ID HeyGen", "an image, a description OR a HeyGen ID") : null,
              ].filter(Boolean).join(" + ")}
            </div>
          )}
        </div>
      </div>

      {avatars.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 }}>
          {avatars.map((a) => {
            const st = STATUS_COLOR[a.status];
            return (
              <div key={a.id} className="card" style={{ padding: 12, display: "grid", gap: 9 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/avatars/${a.id}/image`} alt={a.name}
                  onError={(e) => {
                    const t = e.currentTarget;
                    t.onerror = null;
                    t.src =
                      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='%23242a31'/><circle cx='60' cy='48' r='22' fill='%233a424c'/><rect x='28' y='78' width='64' height='34' rx='17' fill='%233a424c'/></svg>";
                  }}
                  style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: "var(--r-sm)", background: "var(--surface-2)" }} />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontWeight: 650, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: st.color, background: st.bg, padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>{statusLabel(a.status)}</span>
                </div>
                {a.status === "error" && a.error && <div style={{ fontSize: 11, color: "#b91c1c", lineHeight: 1.4 }}>{a.error}</div>}
                {isSlow(a) && (
                  <div style={{ fontSize: 11, color: "#b45309", lineHeight: 1.4 }}>
                    {tr("Plus long que d'habitude — voir les logs.", "Taking longer than usual — check the logs.")}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: "4px 9px" }}
                    onClick={() => { setLogsOpen(logsOpen === a.id ? null : a.id); setLogs([]); }}>
                    {logsOpen === a.id ? tr("Masquer les logs", "Hide logs") : tr("Logs", "Logs")}
                  </button>
                  {(a.status === "error" || isSlow(a)) && (
                    <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: "4px 9px" }} onClick={() => retry(a.id)}>
                      {tr("Réessayer", "Retry")}
                    </button>
                  )}
                  <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: "4px 9px", marginLeft: "auto" }} onClick={() => remove(a.id, a.name)}>{tr("Supprimer", "Delete")}</button>
                </div>
                {logsOpen === a.id && (
                  <pre style={{ fontSize: 10.5, lineHeight: 1.5, background: "var(--surface-2)", borderRadius: "var(--r-sm)", padding: 8, margin: 0, maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap" }}>
                    {logs.length === 0 ? tr("Aucun log pour l'instant…", "No logs yet…")
                      : logs.map((l) => `${new Date(l.ts).toLocaleTimeString()}  ${l.level.toUpperCase()}  ${l.message}`).join("\n")}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

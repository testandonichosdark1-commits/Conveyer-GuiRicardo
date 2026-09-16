"use client";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useT } from "../_i18n";

interface Avatar {
  id: number;
  name: string;
  description: string | null;
  engine: "talking_photo" | "photo_avatar_group";
  status: "pending" | "training" | "ready" | "error";
  error: string | null;
  use_avatar_iv: string | null;
  /** "avatar_v" when the operator chose Avatar V (v3); null = the v2 path. */
  api_engine: string | null;
  channel_id: number | null;
  created_at: string;
}
interface Channel { id: number; name: string }
/**
 * A HeyGen avatar that supports Avatar V (from /api/avatars/looks). The list is already
 * filtered by HeyGen's live supported_api_engines, so every entry is compatible — there
 * is no eligibility flag to carry, and no incompatible option to warn about.
 */
interface CompatibleAvatar { id: string; name: string; previewUrl: string | null }

/** Sentinel for a fetch that never reached the server — translated at render. */
const AVATARS_UNREACHABLE = "__compatible_avatars_unreachable__";

/**
 * Which engine the operator is creating for — and therefore which inputs the form shows.
 *
 * This is the SINGLE source of truth for creation mode. It used to be inferred from
 * whichever field happened to be filled (`picked ? … : heygenId ? import : upload`),
 * which meant three places independently deciding what mode we were in, with an implicit
 * precedence between them. One explicit value instead: pick the engine, get its inputs.
 *
 *  - "iv" / "legacy" → rendered on v2; differ ONLY by use_avatar_iv_model.
 *  - "avatar_v"      → rendered on v3. Availability is per-avatar and decided solely by
 *    HeyGen's live supported_api_engines, so this mode can only pick from avatars that
 *    already exist on HeyGen and report support — never an upload we haven't created yet.
 */
type CreateMode = "iv" | "legacy" | "avatar_v";
interface LogLine { id?: number; ts: string; level: string; message: string }

/**
 * The engine this avatar is configured to render on — read from stored intent, never from
 * what HeyGen currently reports as available.
 *
 * There is no single `render_engine` column: the choice lives in TWO stored columns, and
 * this reproduces the renderer's own decision rather than inventing a parallel one.
 *  - `api_engine === "avatar_v"` → rendered on v3 (`POST /v3/videos`).
 *  - otherwise v2, where studio-pipeline.ts does `useAvatarIv: row.avatar_use_iv === "1"`.
 *
 * That strict `=== "1"` is why NULL means Legacy and not "unset": rows predating the
 * use_avatar_iv column render WITHOUT use_avatar_iv_model, so "Legacy" is what they
 * actually do, not a default we picked. Keep this in lockstep with readAvatar — if the two
 * ever disagree, the card is lying about what the operator will be billed for.
 */
function engineLabel(a: Pick<Avatar, "api_engine" | "use_avatar_iv">): string {
  if (a.api_engine === "avatar_v") return "Avatar V";
  return a.use_avatar_iv === "1" ? "Avatar IV" : "Legacy";
}

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
  const [mode, setMode] = useState<CreateMode>("iv");
  // Derived, never stored: Avatar IV is one of the v2 modes, so the wire flag follows
  // from the mode rather than living beside it as a second thing to keep in sync.
  const useIv = mode === "iv";
  const twinMode = mode === "avatar_v";
  const [file, setFile] = useState<File | null>(null);
  const [heygenId, setHeygenId] = useState("");
  const [importType, setImportType] = useState<"avatar" | "talking_photo">("avatar");
  // Avatar V picker: the operator's HeyGen avatars that support Avatar V.
  const [compatible, setCompatible] = useState<CompatibleAvatar[] | null>(null);
  const [compatError, setCompatError] = useState<string | null>(null);
  const [compatLoading, setCompatLoading] = useState(false);
  const [pickedAvatarId, setPickedAvatarId] = useState("");
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

  /**
   * A transport failure carries no server message, so store a sentinel and translate it
   * at render. Keeping tr() OUT of loadCompatible is load-bearing, not style: useT() returns a
   * NEW function on every render, so a `tr` dependency gave loadCompatible a new identity every
   * render, which re-fired the mount effect, which set state, which re-rendered… Each turn
   * of that loop was a live HeyGen call (57 of them in 12s from one page view) — enough to
   * rate-limit the account by itself. Every dep of loadCompatible must stay referentially stable.
   */
  const loadCompatible = useCallback(async () => {
    setCompatLoading(true);
    setCompatError(null);
    try {
      const r = await fetch("/api/avatars/looks");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // The server's messages are already user-facing (bad key, rate limit, …).
        setCompatError(j?.error || AVATARS_UNREACHABLE);
        return;
      }
      setCompatible(Array.isArray(j?.looks) ? j.looks : []);
    } catch {
      setCompatError(AVATARS_UNREACHABLE);
    } finally {
      setCompatLoading(false);
    }
  }, []);

  /**
   * Fetch the twin list exactly ONCE per mount, and never automatically again — not on
   * re-render, and above all not after a failure: every attempt is a live HeyGen call, so
   * auto-retrying a 429 only deepens the rate limit. Refresh is the sole other trigger.
   *
   * The ref makes that a property of the component rather than of this dependency array:
   * a future dep churn (or React's StrictMode double-invoke) can't turn it back into a
   * request storm.
   */
  const compatRequested = useRef(false);
  useEffect(() => {
    if (compatRequested.current) return;
    compatRequested.current = true;
    loadCompatible();
  }, [loadCompatible]);

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

  /** The mode alone decides whether the form is submittable — never "which field is filled". */
  /**
   * Names that appear more than once, so the picker can disambiguate ONLY those rows.
   * HeyGen names most photo avatars "Photo Avatar", so this is usually every row — but
   * a uniquely-named avatar shouldn't carry an id it doesn't need. Presentation only:
   * nothing is stored, and the id shown is a prefix, never the handle we submit.
   */
  const ambiguous = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of compatible ?? []) seen.set(a.name, (seen.get(a.name) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([n]) => n));
  }, [compatible]);

  const canCreate = name.trim().length > 0 && (twinMode ? pickedAvatarId.length > 0 : !!file || !!description.trim() || !!heygenId.trim());

  async function create() {
    if (!canCreate) return;
    const importing = !twinMode && heygenId.trim().length > 0;

    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("name", name.trim());
      if (channelId != null) fd.set("channelId", String(channelId));
      if (twinMode) {
        // Avatar V reuses the ordinary import-by-id flow — the picker just supplies an id
        // it knows is compatible. Two fields are deliberately NOT sent: `useAvatarIv` (a v2
        // flag with no meaning on v3 — the engine here is apiEngine), and `description`
        // (its input isn't shown in this mode, so anything still in state was typed for a
        // DIFFERENT mode and must not ride along). The server re-checks compatibility.
        fd.set("heygenId", pickedAvatarId);
        fd.set("apiEngine", "avatar_v");
      } else if (importing) {
        // Register an existing HeyGen avatar by id — no upload / no training.
        fd.set("useAvatarIv", useIv ? "1" : "");
        fd.set("heygenId", heygenId.trim());
        fd.set("importType", importType);
      } else {
        fd.set("useAvatarIv", useIv ? "1" : "");
        fd.set("description", description.trim());
        fd.set("engine", engine);
        if (file) fd.set("image", file);
      }
      const r = await fetch("/api/avatars", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(`${tr("Impossible de créer l'avatar", "Couldn't create the avatar")} :\n\n${j.error || r.statusText}`); return; }
      setName(""); setDescription(""); setFile(null); setHeygenId(""); setPickedAvatarId("");
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

        {/* Avatar engine — step 1, and the ONLY thing that decides which inputs appear below.
            Two of the three are HeyGen's /v2/video/generate motion engines: "AvatarIV"
            (use_avatar_iv_model, valid for both the talking_photo and avatar character types,
            so it applies to imported avatars too) and the one HeyGen calls "Unlimited" (flag
            omitted), surfaced to operators as "Legacy" because it is the older, pre-Avatar-IV
            renderer — UI label only; the wire format and the COST_HEYGEN_UNLIMITED_* rate keep
            HeyGen's name. Avatar V is the third: v3-only, and available per-avatar according to
            HeyGen's live supported_api_engines. Choosing it swaps the form to a picker because
            we cannot know whether a photo we haven't uploaded yet will be supported — avatars
            created through our own flow arrive WITHOUT Avatar V (verified). Avatar IV default.
            Rates: Avatar IV Photo Avatar @1080p = $3.00/min and "$1 = 1 minute … (standard
            generation)" for Unlimited are HeyGen's published API prices; the Avatar V figure is
            an ESTIMATE (HeyGen publishes an Avatar V rate only for Digital Twin, and this
            combination is unpriced — see COST_HEYGEN_AVATAR_V_USD_PER_MIN). Indicative only —
            the Costs page computes the real estimate from the configured rates. */}
        <div>
          <label className="label">{tr("Moteur de l'avatar", "Avatar engine")}</label>
          <select
            className="input"
            style={{ maxWidth: 520 }}
            value={mode}
            onChange={(e) => setMode(e.target.value as CreateMode)}
          >
            <option value="iv">
              {tr(
                "Avatar IV (recommandé) — Réalisme maximal · Coût plus élevé (~3 $/min)",
                "Avatar IV (Recommended) — Highest realism · Higher cost (~$3/min)"
              )}
            </option>
            <option value="legacy">
              {tr(
                "Legacy — Coût réduit (~1 $/min) · Un peu moins réaliste",
                "Legacy — Lower cost (~$1/min) · Slightly less realistic"
              )}
            </option>
            {/* "Estimated" rather than the "~" the other two use, because the difference is
                real: $3/min and $1/min are HeyGen's published API prices, $4/min is our own
                upper-bound guess for an unpriced combination. Same hedge on both would hide
                which number HeyGen actually stands behind. */}
            <option value="avatar_v">
              {tr(
                "Avatar V — Qualité maximale · Avatars HeyGen compatibles uniquement · Estimé 4 $/min",
                "Avatar V — Highest quality · Compatible HeyGen avatars only · Estimated $4/min"
              )}
            </option>
          </select>
          {mode === "legacy" && (
            <p className="faint" style={{ fontSize: 11.5, marginTop: 3, lineHeight: 1.4 }}>
              {tr(
                "Recommandé si réduire les coûts de génération compte plus que le réalisme maximal.",
                "Recommended if reducing generation costs is more important than maximum realism."
              )}
            </p>
          )}
        </div>

        {/* The v2 inputs (Avatar IV / Legacy). One fragment gated on the mode, so the
            Avatar IV and Avatar V controls can never be on screen at the same time. */}
        {!twinMode && (
        <>
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
          {/* Videos always render 16:9, whatever shape the reference photo is — so a square or
              portrait photo leaves HeyGen to pad the sides itself (that shows up as bars in the
              finished video). Nothing enforces a ratio, so say it here: two operators in a row
              uploaded square/3:4 photos and only found out from the rendered result. */}
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
            {tr("16:9 (paysage) recommandé — la vidéo est rendue en 16:9.", "16:9 (landscape) recommended — videos are rendered in 16:9.")}
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
        </>
        )}

        {/* Avatar V picker — the whole form for this mode. Lists the operator's HeyGen avatars
            filtered by the live supported_api_engines, so an incompatible one is never offered
            and there is no downgrade to ask about. The id it yields feeds the ORDINARY
            import-by-id flow (a v3 look id IS a v2 avatar id — same avatar, two APIs), which is
            why Avatar V adds no second workflow. No leading "— or —": in this mode there is
            nothing to be "or" with. */}
        {twinMode && (
        // Indented under the engine selector: the picker exists BECAUSE Avatar V was chosen,
        // and the rule reads as a line drawn from that choice down to its consequence.
        <div style={{ marginLeft: 10, paddingLeft: 14, borderLeft: "2px solid var(--border)" }}>
          <label className="label">
            {tr("Sélectionnez un avatar compatible Avatar V", "Select a compatible Avatar V avatar")}
          </label>

          {compatError ? (
            <div className="faint" style={{ fontSize: 12, color: "var(--warning)" }}>
              {compatError === AVATARS_UNREACHABLE ? tr("Impossible de joindre HeyGen.", "Couldn't reach HeyGen.") : compatError}
              {/* No auto-retry: the next attempt is the operator's to make. */}{" "}
              {tr("Utilisez « Actualiser » ci-dessous pour réessayer.", "Use Refresh below to try again.")}
            </div>
          ) : compatible && compatible.length === 0 ? (
            // Only what the API told us. We deliberately do NOT suggest how to obtain a
            // compatible avatar: HeyGen doesn't document how support is granted, and every
            // hypothesis we could test was falsified. Inventing advice here would be a guess.
            <div className="faint" style={{ fontSize: 12 }}>
              {tr(
                "Aucun avatar compatible Avatar V n'a été trouvé pour ce compte HeyGen.",
                "No Avatar V compatible avatars were found for this HeyGen account."
              )}
            </div>
          ) : (
            // A list of thumbnails, NOT a <select>: HeyGen names nearly every photo avatar
            // "Photo Avatar", so a text dropdown shows N identical rows. Short ids would make
            // them unique but still unrecognizable — you'd pick one to find out who it is.
            // The face is the only thing that identifies these, and an <option> cannot hold
            // an image. Radios keep it a real form control: keyboard-navigable, one choice,
            // same pickedAvatarId as before.
            <div role="radiogroup" aria-label={tr("Avatars compatibles Avatar V", "Compatible Avatar V avatars")}
              style={{ border: "1px solid var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface)", overflow: "hidden" }}>
              <div style={{ maxHeight: 260, overflowY: "auto" }}>
                {compatLoading && !compatible ? (
                  <div className="faint" style={{ fontSize: 12, padding: "14px 12px" }}>{tr("Chargement de vos avatars…", "Loading your avatars…")}</div>
                ) : (compatible ?? []).map((a, i) => {
                  const picked = pickedAvatarId === a.id;
                  return (
                    <label key={a.id}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", cursor: "pointer",
                        borderTop: i === 0 ? "none" : "1px solid var(--border)",
                        background: picked ? "var(--accent-soft)" : "transparent",
                        // An OUTLINE, not a border: it paints over the row separators instead of
                        // being interrupted by them, and costs no layout, so selecting a card
                        // can't shift the rows below it by a pixel.
                        outline: picked ? "2px solid var(--accent)" : "none",
                        outlineOffset: "-2px" }}>
                      <input type="radio" name="avatar-v-pick" value={a.id} checked={picked}
                        onChange={() => setPickedAvatarId(a.id)}
                        style={{ margin: 0, flexShrink: 0, accentColor: "var(--accent)" }} />
                      {a.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.previewUrl} alt="" style={{ width: 40, height: 40, borderRadius: "var(--r-sm)", objectFit: "cover", border: "1px solid var(--border)", flexShrink: 0 }} />
                      ) : (
                        // HeyGen occasionally returns no preview. Hold the row's shape rather
                        // than letting one avatar's text jump left out of the column.
                        <div style={{ width: 40, height: 40, borderRadius: "var(--r-sm)", border: "1px solid var(--border)", flexShrink: 0,
                          display: "grid", placeItems: "center", fontSize: 15, opacity: 0.5 }} aria-hidden>🖼</div>
                      )}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: picked ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                        {/* Only where the name is genuinely ambiguous — a short id under a
                            uniquely-named avatar is noise. Labelled "ID" because a bare
                            "87a11dc1…" under a name reads as a serial number, a date, anything;
                            the label is what makes it self-explaining. Never the full id: it
                            identifies nothing to the operator and would wrap the row. */}
                        {ambiguous.has(a.name) && (
                          <div className="faint" style={{ fontSize: 11 }}>
                            ID <span className="mono">{a.id.slice(0, 8)}…</span>
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
              {/* Refresh lives INSIDE the picker's frame — attached to the thing it reloads,
                  rather than floating up by the section title where it read as a page action. */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 6px 10px",
                borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
                <span className="faint" style={{ fontSize: 11.5, flex: 1 }}>
                  {compatible
                    ? tr(`${compatible.length} avatar${compatible.length > 1 ? "s" : ""} compatible${compatible.length > 1 ? "s" : ""}`,
                         `${compatible.length} compatible avatar${compatible.length > 1 ? "s" : ""}`)
                    : ""}
                </span>
                <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: "3px 8px" }} onClick={loadCompatible} disabled={compatLoading}>
                  {compatLoading ? tr("Chargement…", "Loading…") : tr("↻ Actualiser", "↻ Refresh")}
                </button>
              </div>
            </div>
          )}
          {compatError && (
            <div style={{ marginTop: 6 }}>
              <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: "3px 8px" }} onClick={loadCompatible} disabled={compatLoading}>
                {compatLoading ? tr("Chargement…", "Loading…") : tr("↻ Actualiser", "↻ Refresh")}
              </button>
            </div>
          )}
          <div className="faint" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.45 }}>
            {tr(
              "Seuls les avatars compatibles Avatar V de votre compte HeyGen sont affichés ici.",
              "Only Avatar V compatible avatars from your HeyGen account are shown here."
            )}
          </div>
        </div>
        )}

        <div>
          <button className="btn" onClick={create} disabled={busy || !canCreate}>
            {busy ? tr("Création…", "Creating…") : tr("Créer l'avatar", "Create avatar")}
          </button>
          {/* A disabled button looks like "the button does nothing" to a
              non-technical user — spell out exactly what's missing, for THIS mode: naming
              inputs that aren't on screen (an image, in Avatar V mode) is worse than saying
              nothing at all. */}
          {!busy && !canCreate && (
            <div style={{ fontSize: 12.5, color: "#b45309", marginTop: 8, lineHeight: 1.5 }}>
              ⚠ {tr("Pour activer le bouton, ajoutez", "To enable the button, add")}
              {": "}
              {[
                !name.trim() ? tr("un nom (champ « Nom »)", "a name (the \"Name\" field)") : null,
                twinMode
                  ? !pickedAvatarId
                    ? tr("un avatar compatible sélectionné", "a selected compatible avatar")
                    : null
                  : !file && !description.trim() && !heygenId.trim()
                    ? tr("une image, une description OU un ID HeyGen", "an image, a description OR a HeyGen ID")
                    : null,
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
                {/* Name → engine, as one block: the engine sits directly under the name on
                    EVERY card, in the same place with the same type. It used to appear only
                    on Avatar V cards, which made the engine look like a property some avatars
                    have — when in fact every avatar renders on exactly one. The status badge
                    moved out of the name row to below this block, so the engine is never
                    separated from the name it describes (and a long name gets the full width).
                    Every engine renders now, so "Ready" means the same thing on every card and
                    no card carries a caveat. */}
                <div style={{ display: "grid", gap: 2 }}>
                  <div style={{ fontWeight: 650, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                  <div className="faint" style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.4 }}>{engineLabel(a)}</div>
                </div>
                <div>
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

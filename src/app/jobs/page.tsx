"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useT } from "../_i18n";

interface Run {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  output_path: string | null;
  config_json: string | null;
}

const PAGE_SIZE = 10;

function modeOf(cfg: string | null): string | null {
  if (!cfg) return null;
  try {
    const j = JSON.parse(cfg) as { visualMode?: string };
    return j.visualMode ?? null;
  } catch {
    return null;
  }
}

function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 MB";
  const gb = n / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}

function fmtDate(s: string): string {
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const BADGE: Record<string, { color: string; bg: string }> = {
  done: { color: "#15803d", bg: "rgba(34,197,94,0.15)" },
  running: { color: "#1d4ed8", bg: "rgba(59,130,246,0.15)" },
  pending: { color: "#b45309", bg: "rgba(245,158,11,0.14)" },
  error: { color: "#b91c1c", bg: "rgba(239,68,68,0.15)" },
  cancelled: { color: "#6b7280", bg: "rgba(107,114,128,0.15)" },
};

export default function JobsPage() {
  const tr = useT();
  const [runs, setRuns] = useState<Run[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [storage, setStorage] = useState<{ totalBytes: number; jobCount: number } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Size of the run whose delete dialog is open — null while still loading.
  const [confirmSize, setConfirmSize] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Track how many rows are loaded so polling can refresh the same slice.
  const loadedCount = useRef(PAGE_SIZE);

  const loadStorage = useCallback(async () => {
    try {
      const r = await fetch("/api/runs/storage");
      if (r.ok) setStorage(await r.json());
    } catch {
      /* ignore */
    }
  }, []);

  // Refresh the currently-loaded slice (newest N rows) — used on mount + polling.
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/runs?limit=${loadedCount.current}`);
      const j = r.ok ? await r.json() : [];
      const arr = Array.isArray(j) ? (j as Run[]) : [];
      setRuns(arr);
      setHasMore(arr.length >= loadedCount.current);
    } catch {
      setRuns([]);
    }
  }, []);

  const loadMore = useCallback(async () => {
    const oldest = runs[runs.length - 1]?.created_at;
    if (!oldest) return;
    try {
      const r = await fetch(`/api/runs?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest)}`);
      const j = r.ok ? await r.json() : [];
      const arr = Array.isArray(j) ? (j as Run[]) : [];
      setRuns((prev) => [...prev, ...arr]);
      loadedCount.current += arr.length;
      setHasMore(arr.length >= PAGE_SIZE);
    } catch {
      /* ignore */
    }
  }, [runs]);

  useEffect(() => {
    refresh();
    loadStorage();
  }, [refresh, loadStorage]);

  useEffect(() => {
    if (!runs.some((r) => r.status === "running" || r.status === "pending")) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [runs, refresh]);

  // Re-sync when the tab regains focus. The list otherwise only polls while a run
  // is active, so a job deleted in another tab/session would linger here with a
  // stale ⬇ mp4 anchor that now 404s — refreshing on focus drops it promptly.
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState === "visible") {
        refresh();
        loadStorage();
      }
    };
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, [refresh, loadStorage]);

  // Open the delete dialog for a run + fetch that folder's size once.
  const askDelete = useCallback((id: string) => {
    setConfirmId(id);
    setConfirmSize(null);
    fetch(`/api/runs/${id}/size`)
      .then((r) => (r.ok ? r.json() : { bytes: 0 }))
      .then((j) => setConfirmSize(typeof j.bytes === "number" ? j.bytes : 0))
      .catch(() => setConfirmSize(0));
  }, []);

  const cancelRun = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await fetch(`/api/runs/${id}/cancel`, { method: "POST" });
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  const deleteJob = useCallback(
    async (id: string) => {
      setBusyId(id);
      setConfirmId(null);
      try {
        const r = await fetch(`/api/runs/${id}/delete`, { method: "POST" });
        if (r.ok) {
          await refresh();
          await loadStorage();
        }
      } finally {
        setBusyId(null);
      }
    },
    [refresh, loadStorage]
  );

  return (
    <div>
      <h1>{tr("Jobs", "Jobs")}</h1>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 18,
          flexWrap: "wrap",
        }}
      >
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>
          {tr("Historique des rendus.", "Render history.")}
        </p>
        {storage && (
          <span className="faint" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
            📦 {fmtBytes(storage.totalBytes)} {tr("utilisés", "used")} · {storage.jobCount}{" "}
            {tr("rendus", "jobs")}
          </span>
        )}
      </div>

      {runs.length === 0 ? (
        <p className="faint" style={{ fontSize: 13.5 }}>
          {tr("Aucun rendu pour l'instant.", "No renders yet.")}
        </p>
      ) : (
        <>
          <div className="card" style={{ display: "grid", gap: 2, padding: 8 }}>
            {runs.map((r) => {
              const b = BADGE[r.status] ?? BADGE.pending;
              const mode = modeOf(r.config_json);
              const active = r.status === "running" || r.status === "pending";
              const busy = busyId === r.id;
              return (
                <div
                  key={r.id}
                  className="jobs-row"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 8,
                    opacity: busy ? 0.5 : 1,
                    // The row is a grid item of the .card grid; grid items also
                    // default to min-width:auto, so without this the row expands
                    // to fit a nowrap title and overflows the page. min-width:0
                    // lets the row stay within its track so the title can clip.
                    minWidth: 0,
                  }}
                >
                  <div className="jobs-row-main" style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: b.color,
                        background: b.bg,
                        padding: "2px 8px",
                        borderRadius: 999,
                        textTransform: "uppercase",
                        flexShrink: 0,
                      }}
                    >
                      {r.status}
                    </span>
                    <span
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        // Flex items default to min-width:auto, which for nowrap
                        // text is the full title — so the span refuses to shrink
                        // and a pasted-script title stretches the row. min-width:0
                        // lets it shrink so overflow/ellipsis below can clip it.
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.title || r.id.slice(0, 12)}
                    </span>
                    {mode && (
                      <span className="faint" style={{ fontSize: 12, flexShrink: 0 }}>
                        · {mode}
                      </span>
                    )}
                    {r.created_at && (
                      <span className="faint" style={{ fontSize: 12, flexShrink: 0 }}>
                        · {fmtDate(r.created_at)}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
                    {r.status === "done" && (
                      <a
                        href={`/api/runs/${r.id}/file?p=final.mp4&download=1`}
                        style={{ fontSize: 13 }}
                      >
                        ⬇ mp4
                      </a>
                    )}
                    <Link href={`/runs/${r.id}`} style={{ fontSize: 13 }}>
                      {tr("Suivre", "Follow")}
                    </Link>
                    {/* Destructive action is always last, to reduce accidental clicks:
                        Cancel for in-flight runs, Delete for terminal ones. */}
                    {active ? (
                      <button
                        type="button"
                        onClick={() => cancelRun(r.id)}
                        disabled={busy}
                        style={linkBtn("#b91c1c")}
                      >
                        {tr("Annuler", "Cancel")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => askDelete(r.id)}
                        disabled={busy}
                        style={linkBtn("#b91c1c")}
                      >
                        🗑 {tr("Supprimer", "Delete")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {hasMore && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
              <button type="button" className="btn" onClick={loadMore}>
                {tr("Afficher plus", "Show more")}
              </button>
            </div>
          )}
        </>
      )}

      {confirmId && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setConfirmId(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
            padding: 20,
          }}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 420, padding: 22 }}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: 16 }}>
              {tr("Supprimer ce rendu ?", "Delete this job?")}
            </h3>
            <p className="muted" style={{ fontSize: 13.5, margin: "0 0 18px", lineHeight: 1.5 }}>
              {tr(
                `Libère environ ${confirmSize === null ? "…" : fmtBytes(confirmSize)}. La vidéo finale, les ressources et les logs sont supprimés — l'historique des coûts est conservé. Action irréversible.`,
                `Frees about ${confirmSize === null ? "…" : fmtBytes(confirmSize)}. The final video, assets and logs are removed — cost history is kept. This can't be undone.`
              )}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" className="btn" onClick={() => setConfirmId(null)}>
                {tr("Annuler", "Cancel")}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => deleteJob(confirmId)}
                style={{ background: "#b91c1c", borderColor: "#b91c1c", color: "#fff" }}
              >
                🗑 {tr("Supprimer", "Delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function linkBtn(color: string): CSSProperties {
  return {
    fontSize: 13,
    color,
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
  };
}

"use client";
import { useEffect, useState } from "react";
import { useT } from "../../_i18n";
import type { Val, Set } from "./useSettings";

const ALL_FOOTAGE: { id: string; label: string; disabled?: boolean; needsKey?: boolean; optIn?: boolean }[] = [
  { id: "pexels", label: "Pexels" },
  { id: "storyblocks", label: "Storyblocks (paid)", needsKey: true },
  { id: "pixabay", label: "Pixabay" },
  { id: "openverse", label: "Openverse" },
  { id: "wikimedia", label: "Wikimedia" },
  { id: "archive", label: "Archive.org" },
  // Web (Google CSE) — needs GOOGLE_CSE_KEY + GOOGLE_CSE_CX to return results.
  { id: "web", label: "Web (Google)" },
  { id: "youtube", label: "YouTube (clips)" },
  // Photos only, served by a local daemon. ON by default since 2026-08-11 — so it belongs in
  // the fallback below like every other shipped source. (`optIn` stays in the type: it is the
  // mechanism for a source that must never be switched on for someone; nothing uses it now.)
  { id: "wigolo", label: "Wigolo (web photos)" },
];

/**
 * Real-footage source checkboxes (stored as the FOOTAGE_SOURCES CSV the pipeline
 * reads). Ticking YouTube also flips YT_DLP_ENABLED and reveals a copyright
 * warning, since YouTube clips carry usage-rights risk.
 */
export function FootageSources({ val, set }: { val: Val; set: Set }) {
  const tr = useT();

  const footageList = (): string[] => {
    const raw = val("FOOTAGE_SOURCES") || "pexels,pixabay,openverse,wikimedia";
    const list = raw
      .split(/[,\n;]+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => ALL_FOOTAGE.some((f) => f.id === x));
    // Nothing recognised → fall back to the built-in sources. `optIn` ones are excluded on
    // purpose: this branch must never be able to switch a source on that the operator did
    // not choose, and it is reachable from any DB whose FOOTAGE_SOURCES holds only values
    // this build doesn't know.
    return list.length ? Array.from(new Set(list)) : ALL_FOOTAGE.filter((f) => !f.optIn).map((f) => f.id);
  };
  const writeFootage = (list: string[]) => set("FOOTAGE_SOURCES", list.join(","));
  const toggleFootage = (id: string) => {
    if (ALL_FOOTAGE.find((f) => f.id === id)?.disabled) return;
    const list = footageList();
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    if (next.length > 0) writeFootage(next); // never disable all
    if (id === "youtube") set("YT_DLP_ENABLED", next.includes("youtube") ? "1" : "0");
  };

  const youtubeOn = footageList().includes("youtube");
  const wigoloOn = footageList().includes("wigolo");

  /**
   * Wigolo needs a separate local process to be running. When it isn't, the source simply
   * returns nothing — which looks identical to "the web had no good photo for this shot", so
   * without this indicator a stopped daemon is invisible until someone wonders why results
   * got worse. Probed once on mount; `tr` is deliberately NOT a dependency (useT returns a
   * new function every render, and depending on it re-fires the effect on every render).
   */
  const [daemonUp, setDaemonUp] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/wigolo/health")
      .then((r) => r.json())
      .then((d: { ok?: boolean }) => {
        if (alive) setDaemonUp(d?.ok === true);
      })
      .catch(() => {
        if (alive) setDaemonUp(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <label className="label">{tr("Sources de footage réel", "Real footage sources")}</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", marginBottom: 8 }}>
        {ALL_FOOTAGE.map((src) => (
          <label
            key={src.id}
            title={src.disabled ? tr("Bientôt — fonctionnalité en cours de développement", "Coming soon — feature in development") : undefined}
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: src.disabled ? "not-allowed" : "pointer", opacity: src.disabled ? 0.55 : 1 }}
          >
            <input type="checkbox" checked={!src.disabled && footageList().includes(src.id)} disabled={src.disabled} onChange={() => toggleFootage(src.id)} />
            {src.label}
            {src.disabled && (
              <span className="badge" style={{ background: "var(--warning-soft)", color: "var(--warning)", fontSize: 9.5, padding: "1px 6px" }}>
                {tr("en développement", "in development")}
              </span>
            )}
          </label>
        ))}
      </div>

      {youtubeOn && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            background: "var(--warning-soft)",
            color: "var(--warning)",
            border: "1px solid var(--warning)",
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 12.5,
            marginBottom: 8,
          }}
        >
          <span aria-hidden>⚠️</span>
          <span>
            {tr(
              "L'utilisation de clips YouTube peut poser des problèmes de droits d'auteur. Vous êtes responsable de vous assurer des droits d'utilisation.",
              "Using YouTube clips may involve copyright issues. You are responsible for ensuring usage rights."
            )}
          </span>
        </div>
      )}

      {wigoloOn && daemonUp === false && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            background: "var(--warning-soft)",
            color: "var(--warning)",
            border: "1px solid var(--warning)",
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 12.5,
            marginBottom: 8,
          }}
        >
          <span aria-hidden>⚠️</span>
          <span>
            {tr(
              "Wigolo est coché mais son service local ne répond pas — cette source ne renverra aucune photo. Relancez l'application pour le démarrer.",
              "Wigolo is ticked but its local service isn't responding — this source will return no photos. Restart the app to start it."
            )}
          </span>
        </div>
      )}

      <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
        {tr(
          "Cochez les sources à utiliser. Pour CHAQUE plan, la plateforme cherche dans TOUTES les sources cochées, puis l'IA (vision) choisit la meilleure correspondance.",
          "Tick the sources to use. For EACH shot the platform searches ALL ticked sources, then the AI (vision) picks the best match."
        )}
      </div>
    </div>
  );
}

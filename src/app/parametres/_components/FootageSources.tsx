"use client";
import { useT } from "../../_i18n";
import type { Val, Set } from "./useSettings";

const ALL_FOOTAGE: { id: string; label: string; disabled?: boolean }[] = [
  { id: "pexels", label: "Pexels" },
  { id: "pixabay", label: "Pixabay" },
  { id: "openverse", label: "Openverse" },
  { id: "wikimedia", label: "Wikimedia" },
  { id: "archive", label: "Archive.org" },
  // Web (Google CSE) isn't client-ready yet — kept disabled "in development".
  { id: "web", label: "Web (Google)", disabled: true },
  { id: "youtube", label: "YouTube (clips)" },
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
    return list.length ? Array.from(new Set(list)) : ALL_FOOTAGE.map((f) => f.id);
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

      <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
        {tr(
          "Cochez les sources à utiliser. Pour CHAQUE plan, la plateforme cherche dans TOUTES les sources cochées, puis l'IA (vision) choisit la meilleure correspondance.",
          "Tick the sources to use. For EACH shot the platform searches ALL ticked sources, then the AI (vision) picks the best match."
        )}
      </div>
    </div>
  );
}

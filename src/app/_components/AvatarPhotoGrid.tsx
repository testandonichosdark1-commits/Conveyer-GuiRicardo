"use client";
import { useT } from "../_i18n";

export interface AvatarPhotoLite {
  id: number;
  name: string;
  status: "pending" | "training" | "ready" | "error";
}

/**
 * Visual avatar picker — a grid of photo cards (via /api/avatars/{id}/image) instead of
 * a text <select>. Two shapes in one component so Channels (link several avatars to a
 * channel) and Create-a-video (pick exactly one for this run) never drift apart:
 *   - multi=true:  `selected` is number[], clicking a card TOGGLES it in/out.
 *   - multi=false: `selected` is number|null, clicking a card REPLACES the selection
 *     (clicking the already-selected card clears it — the single-select "None" affordance).
 */
export function AvatarPhotoGrid({
  avatars,
  selected,
  onChange,
  multi,
  emptyHint,
}: {
  avatars: AvatarPhotoLite[];
  selected: number[] | number | null;
  onChange: (next: number[] | number | null) => void;
  multi: boolean;
  emptyHint?: string;
}) {
  const tr = useT();
  const selectedSet = new Set(multi ? (selected as number[]) : selected != null ? [selected as number] : []);

  function toggle(id: number) {
    if (multi) {
      const cur = selected as number[];
      onChange(selectedSet.has(id) ? cur.filter((x) => x !== id) : [...cur, id]);
    } else {
      onChange(selected === id ? null : id);
    }
  }

  const statusLabel = (s: AvatarPhotoLite["status"]) =>
    s === "ready" ? null
    : s === "error" ? tr("erreur", "error")
    : s === "training" ? tr("entraînement…", "training…")
    : tr("préparation…", "preparing…");

  if (avatars.length === 0) {
    return (
      <div className="faint" style={{ fontSize: 12.5, padding: "10px 0" }}>
        {emptyHint ?? tr("Aucun avatar disponible.", "No avatars available.")}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 10 }}>
      {avatars.map((a) => {
        const picked = selectedSet.has(a.id);
        const disabled = a.status !== "ready";
        const badge = statusLabel(a.status);
        return (
          <button
            key={a.id}
            type="button"
            disabled={disabled}
            onClick={() => toggle(a.id)}
            title={a.name}
            style={{
              display: "grid",
              gap: 4,
              padding: 0,
              background: "transparent",
              border: "none",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.5 : 1,
              textAlign: "left",
            }}
          >
            <div
              style={{
                position: "relative",
                aspectRatio: "1 / 1",
                borderRadius: "var(--r-sm)",
                overflow: "hidden",
                border: picked ? "2px solid var(--accent)" : "1px solid var(--border)",
                outline: picked ? "2px solid var(--accent)" : "none",
                outlineOffset: 1,
                background: "var(--surface-2)",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/avatars/${a.id}/image`}
                alt={a.name}
                onError={(e) => {
                  const t = e.currentTarget;
                  t.onerror = null;
                  t.src =
                    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='%23242a31'/><circle cx='60' cy='48' r='22' fill='%233a424c'/><rect x='28' y='78' width='64' height='34' rx='17' fill='%233a424c'/></svg>";
                }}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
              {picked && (
                <div
                  aria-hidden
                  style={{
                    position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: 999,
                    background: "var(--accent)", color: "#fff", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700,
                  }}
                >
                  ✓
                </div>
              )}
            </div>
            <div style={{ fontSize: 11.5, fontWeight: picked ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {a.name}
            </div>
            {badge && <div className="faint" style={{ fontSize: 10.5 }}>{badge}</div>}
          </button>
        );
      })}
    </div>
  );
}

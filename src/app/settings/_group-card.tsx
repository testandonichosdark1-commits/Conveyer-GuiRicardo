"use client";
import type { Group } from "./_groups";

interface GroupCardProps {
  group: Group;
  values: Record<string, string>;
  setValues: (next: Record<string, string>) => void;
}

/** Renders one settings group as a single card with all its fields. */
export function GroupCard({ group, values, setValues }: GroupCardProps) {
  return (
    <div
      className="card"
      style={{
        marginBottom: 14,
        borderColor: group.required ? "rgba(248,113,113,0.4)" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>{group.title}</h2>
        {group.required && (
          <span className="badge" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
            REQUIRED
          </span>
        )}
      </div>
      {group.subtitle && (
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 16, lineHeight: 1.55 }}>
          {group.subtitle}
        </p>
      )}
      <div style={{ display: "grid", gap: 16 }}>
        {group.fields.map((f) => {
          const missing = f.required && !values[f.key];
          return (
            <div key={f.key}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                <label
                  className="label"
                  style={{
                    margin: 0,
                    color: f.required ? "var(--danger)" : "var(--fg)",
                    fontWeight: 600,
                    letterSpacing: "0.01em",
                  }}
                >
                  {f.label ?? f.key}
                </label>
                {f.required && (
                  <span style={{ color: "var(--danger)", fontSize: 10.5, fontWeight: 700 }}>
                    required
                  </span>
                )}
              </div>
              {f.options ? (
                <select
                  className="input"
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  style={{ borderColor: missing ? "var(--danger)" : undefined, cursor: "pointer" }}
                >
                  <option value="">(default)</option>
                  {f.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : f.multiline ? (
                <textarea
                  className="textarea"
                  value={values[f.key] ?? ""}
                  placeholder={f.examples ? `e.g. ${f.examples}` : ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  rows={Math.max(2, Math.min(6, (values[f.key] ?? "").split(/\n/).length + 1))}
                  style={{ borderColor: missing ? "var(--danger)" : undefined }}
                />
              ) : (
                <input
                  className="input"
                  value={values[f.key] ?? ""}
                  placeholder={f.examples ? `e.g. ${f.examples}` : ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  style={{ borderColor: missing ? "var(--danger)" : undefined }}
                />
              )}
              {/* Multi-key fields (69labs, Pexels) accept several keys separated by
                  newline/comma/semicolon — the SAME split the backend pool uses. Show
                  a live count so it's obvious every key was recognized. */}
              {(f.key === "LABS69_API_KEY" || f.key === "PEXELS_API_KEY") && values[f.key] && (() => {
                const n = values[f.key].split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean).length;
                return (
                  <div style={{ color: "var(--accent-hover)", fontSize: 12, marginTop: 6 }}>
                    <strong>{n}</strong> key{n === 1 ? "" : "s"} configured — the app rotates between them automatically
                  </div>
                );
              })()}
              <div
                style={{
                  color: "var(--fg-muted)",
                  fontSize: 12,
                  marginTop: 6,
                  lineHeight: 1.5,
                  whiteSpace: "pre-line",
                }}
              >
                {f.desc}
              </div>
              {f.examples && (
                <div className="mono faint" style={{ fontSize: 11, marginTop: 3 }}>
                  {f.examples}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

"use client";
import type { ReactNode } from "react";

/** Collapsible "Advanced" wrapper — keeps the ~80% of complex controls out of view. */
export function AdvancedSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <summary
        className="faint"
        style={{ cursor: "pointer", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", userSelect: "none" }}
      >
        {title}
      </summary>
      <div style={{ display: "grid", gap: 16, marginTop: 14 }}>{children}</div>
    </details>
  );
}

"use client";
import { useT } from "../../_i18n";
import { SettingsField } from "./SettingsField";
import type { Val, Set } from "./useSettings";

/**
 * Persistent, always-visible Magnific configuration block. Rendered regardless of
 * which AI provider is selected, so Magnific (an additional provider / fallback)
 * can be configured without switching the primary AI provider. Reuses the existing
 * MAGNIFIC_* settings — no new keys, no duplicated controls.
 *
 * The Image/Video MODEL selectors are NOT here — they're rendered by
 * ProviderModelFields (driven by the provider registry in src/lib/providers.ts), so
 * the model lists live in exactly one place. This block owns only the Magnific
 * controls the registry doesn't: API key, enable/fallback, retries, concurrency.
 */
export function MagnificBlock({ val, set }: { val: Val; set: Set }) {
  const tr = useT();
  const hasKey = (val("MAGNIFIC_API_KEY") || "").trim() !== "";
  const enabled = (val("MAGNIFIC_ENABLED") || "1") !== "0";

  const status = !hasKey
    ? { dot: "🔴", text: tr("Clé API requise", "API key required"), color: "var(--danger)", bg: "var(--danger-soft)" }
    : enabled
      ? { dot: "🟢", text: tr("Connecté", "Connected"), color: "var(--success)", bg: "var(--success-soft)" }
      : { dot: "🟡", text: tr("Désactivé", "Disabled"), color: "var(--warning)", bg: "var(--warning-soft)" };

  return (
    <div style={{ display: "grid", gap: 16, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="faint" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {tr("Magnific AI (secours / fallback)", "Magnific AI (fallback)")}
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            fontWeight: 700,
            color: status.color,
            background: status.bg,
            padding: "3px 10px",
            borderRadius: 999,
          }}
        >
          <span aria-hidden="true">{status.dot}</span> {status.text}
        </span>
      </div>

      <div className="faint" style={{ fontSize: 12, marginTop: -6, lineHeight: 1.5 }}>
        {tr(
          "Fournisseur IA de secours optionnel (images / vidéo).",
          "Optional fallback AI provider for image/video generation."
        )}
      </div>

      <SettingsField label={tr("Magnific AI — clé API", "Magnific AI — API key")} settingKey="MAGNIFIC_API_KEY" val={val} set={set} />

      <div>
        <label className="label">{tr("Activer le secours", "Enable fallback")}</label>
        <select className="input" value={enabled ? "1" : "0"} onChange={(e) => set("MAGNIFIC_ENABLED", e.target.value)}>
          <option value="1">{tr("Activé (fournisseur + secours)", "On (provider + fallback)")}</option>
          <option value="0">{tr("Désactivé", "Off")}</option>
        </select>
      </div>

      <details className="card-inset" style={{ padding: 14 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>{tr("Avancé", "Advanced")}</summary>
        <div style={{ display: "grid", gap: 16, marginTop: 14 }}>
          <div className="faint" style={{ fontSize: 12 }}>
            {tr(
              "Les modèles image / vidéo se choisissent ci-dessus (Modèle image / Modèle vidéo).",
              "Image / video models are chosen above (Image model / Video model)."
            )}
          </div>
          <div className="grid-2" style={{ gap: 16 }}>
            <SettingsField label={tr("Tentatives (retries)", "Retries")} settingKey="MAGNIFIC_RETRIES" val={val} set={set} placeholder="3" />
            <SettingsField label={tr("Concurrence", "Concurrency")} settingKey="MAGNIFIC_CONCURRENCY" val={val} set={set} placeholder="2" />
          </div>
        </div>
      </details>
    </div>
  );
}

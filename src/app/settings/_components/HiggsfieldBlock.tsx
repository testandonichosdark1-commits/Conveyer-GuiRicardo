"use client";
import { useT } from "../../_i18n";
import { SettingsField } from "./SettingsField";
import type { Val, Set } from "./useSettings";

/**
 * Persistent Higgsfield configuration block, shown when Higgsfield is the selected AI
 * provider (mirrors MagnificBlock). Owns the controls the provider registry doesn't:
 * the TWO-part API key (id + secret), enable/fallback, retries, concurrency. The
 * Image/Video MODEL selectors are rendered by ProviderModelFields from the registry, so
 * the model lists live in exactly one place — this block never duplicates them.
 *
 * Higgsfield auth is a two-part key (`Authorization: Key {id}:{secret}`), so BOTH the
 * key and the secret must be present before it counts as configured.
 */
export function HiggsfieldBlock({ val, set }: { val: Val; set: Set }) {
  const tr = useT();
  const hasKey = (val("HIGGSFIELD_API_KEY") || "").trim() !== "" && (val("HIGGSFIELD_API_SECRET") || "").trim() !== "";
  const enabled = (val("HIGGSFIELD_ENABLED") || "1") !== "0";

  const status = !hasKey
    ? { dot: "🔴", text: tr("Clé + secret requis", "API key + secret required"), color: "var(--danger)", bg: "var(--danger-soft)" }
    : enabled
      ? { dot: "🟢", text: tr("Connecté", "Connected"), color: "var(--success)", bg: "var(--success-soft)" }
      : { dot: "🟡", text: tr("Désactivé", "Disabled"), color: "var(--warning)", bg: "var(--warning-soft)" };

  return (
    <div style={{ display: "grid", gap: 16, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="faint" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {tr("Higgsfield (Soul / DoP)", "Higgsfield (Soul / DoP)")}
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
          "Fournisseur IA optionnel (images / vidéo). Une seule clé donne accès à Soul, DoP et aux modèles tiers (Kling, Seedance…).",
          "Optional AI provider for image / video generation. One key fronts Soul, DoP and third-party models (Kling, Seedance…)."
        )}
      </div>

      <div className="grid-2" style={{ gap: 16 }}>
        <SettingsField label={tr("Higgsfield — clé API (id)", "Higgsfield — API key (id)")} settingKey="HIGGSFIELD_API_KEY" val={val} set={set} />
        <SettingsField label={tr("Higgsfield — secret API", "Higgsfield — API secret")} settingKey="HIGGSFIELD_API_SECRET" val={val} set={set} />
      </div>

      <div>
        <label className="label">{tr("Activer le secours", "Enable fallback")}</label>
        <select className="input" value={enabled ? "1" : "0"} onChange={(e) => set("HIGGSFIELD_ENABLED", e.target.value)}>
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
            <SettingsField label={tr("Tentatives (retries)", "Retries")} settingKey="HIGGSFIELD_RETRIES" val={val} set={set} placeholder="3" />
            <SettingsField label={tr("Concurrence", "Concurrency")} settingKey="HIGGSFIELD_CONCURRENCY" val={val} set={set} placeholder="2" />
          </div>
        </div>
      </details>
    </div>
  );
}

"use client";
import { useT } from "../../_i18n";
import { SettingsField } from "./SettingsField";
import type { Val, Set } from "./useSettings";

/**
 * Persistent "Local GPU" configuration block, shown when AI_PROVIDER=local (mirrors
 * HiggsfieldBlock/MagnificBlock). Two independent free backends live under this one
 * provider id: image generation goes through the operator's own logged-in ChatGPT
 * browser tab (no API key — see chatgpt-browser.ts), video generation goes through a
 * local ComfyUI instance running LTX-Video on the operator's own GPU (COMFYUI_URL).
 * Neither backend has a cloud credential, so there's no key field here — only the
 * ComfyUI connection address and timeouts.
 */
export function LocalGpuBlock({ val, set }: { val: Val; set: Set }) {
  const tr = useT();
  const comfyUrl = (val("COMFYUI_URL") || "").trim();

  return (
    <div style={{ display: "grid", gap: 16, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="faint" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {tr("GPU locale (ChatGPT + LTX-Video)", "Local GPU (ChatGPT + LTX-Video)")}
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            fontWeight: 700,
            color: "var(--warning)",
            background: "var(--warning-soft)",
            padding: "3px 10px",
            borderRadius: 999,
          }}
        >
          <span aria-hidden="true">🟡</span> {tr("Expérimental — vérifiez manuellement", "Experimental — verify manually")}
        </span>
      </div>

      <div className="faint" style={{ fontSize: 12, marginTop: -6, lineHeight: 1.5 }}>
        {tr(
          "Image : générée via l'onglet ChatGPT déjà connecté dans le navigateur (aucune clé, aucun coût). Vidéo : LTX-Video sur votre propre GPU via ComfyUI local. Les deux tournent sur votre machine — plus lent et de qualité variable par rapport aux fournisseurs cloud.",
          "Image: generated through the ChatGPT tab already logged into your browser (no key, no cost). Video: LTX-Video on your own GPU through a local ComfyUI instance. Both run on your machine — slower and more variable in quality than the cloud providers."
        )}
      </div>

      <SettingsField
        label={tr("URL du ComfyUI local", "Local ComfyUI URL")}
        settingKey="COMFYUI_URL"
        val={val}
        set={set}
        placeholder="http://127.0.0.1:8188"
      />
      {!comfyUrl && (
        <div className="faint" style={{ fontSize: 12, color: "var(--warning)" }}>
          {tr(
            "Vide = les beats vidéo échoueront jusqu'à ce que ComfyUI tourne et que cette URL soit renseignée.",
            "Empty = video beats will fail until ComfyUI is running and this URL is set."
          )}
        </div>
      )}

      <details className="card-inset" style={{ padding: 14 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>{tr("Avancé", "Advanced")}</summary>
        <div style={{ display: "grid", gap: 16, marginTop: 14 }}>
          <div className="grid-2" style={{ gap: 16 }}>
            <SettingsField label={tr("Délai ComfyUI (s)", "ComfyUI timeout (sec)")} settingKey="COMFYUI_TIMEOUT_SEC" val={val} set={set} placeholder="600" />
            <SettingsField label={tr("Délai image ChatGPT (s)", "ChatGPT image timeout (sec)")} settingKey="CHATGPT_IMAGE_TIMEOUT_SEC" val={val} set={set} placeholder="180" />
          </div>
          <SettingsField label={tr("URL ChatGPT", "ChatGPT URL")} settingKey="CHATGPT_URL" val={val} set={set} placeholder="https://chatgpt.com/" />
        </div>
      </details>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useT } from "../../_i18n";
import { SettingsField } from "./SettingsField";
import type { Val, Set } from "./useSettings";

export function FlowBrowserBlock({ val, set }: { val: Val; set: Set }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function openSession() {
    setBusy(true);
    setStatus("");
    try {
      // The session endpoint runs on the server and therefore reads persisted settings.
      // Save the current URL first so "Open" works even before the page-wide Save button.
      const saveResponse = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ FLOW_PROJECT_URL: val("FLOW_PROJECT_URL") }),
      });
      if (!saveResponse.ok) {
        const saved = await saveResponse.json().catch(() => ({}));
        throw new Error(saved.error || `Settings HTTP ${saveResponse.status}`);
      }
      const response = await fetch("/api/flow-browser", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setStatus(data.message || (data.ready ? "Flow ready." : "Chrome opened."));
    } catch (error) {
      setStatus(`${tr("Erreur", "Error")}: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 10 }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 13 }}>
          {tr("Google Flow via navigateur (expérimental)", "Google Flow through browser (experimental)")}
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.5 }}>
          {tr(
            "Ouvre le Chrome normal et s'y connecte localement, une image à la fois, avec une session Google persistante. Le premier login est manuel; les exécutions suivantes sont automatiques. Flow peut changer son interface ou demander une nouvelle vérification.",
            "Opens normal Chrome and connects to it locally, one image at a time, with a persistent Google session. The first login is manual; later runs are automatic. Flow may change its UI or request verification again."
          )}
        </div>
      </div>

      <SettingsField
        label={tr("URL du projet Google Flow", "Google Flow project URL")}
        settingKey="FLOW_PROJECT_URL"
        val={val}
        set={set}
        placeholder="https://labs.google/fx/tools/flow/project/..."
      />

      <div className="grid-2" style={{ gap: 12 }}>
        <div>
          <label className="label">{tr("En cas d'échec de Flow", "If Flow fails")}</label>
          <select className="input" value={val("FLOW_FALLBACK_PROVIDER") || "none"} onChange={(e) => set("FLOW_FALLBACK_PROVIDER", e.target.value)}>
            <option value="none">{tr("Mettre en pause / échouer (aucun coût)", "Pause / fail (no paid fallback)")}</option>
            <option value="kie">{tr("Utiliser kie.ai Nano Banana", "Use kie.ai Nano Banana")}</option>
          </select>
        </div>
        <div>
          <label className="label">{tr("Tentatives par image", "Attempts per image")}</label>
          <select className="input" value={val("FLOW_REGEN_ATTEMPTS") || "1"} onChange={(e) => set("FLOW_REGEN_ATTEMPTS", e.target.value)}>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn secondary" type="button" onClick={openSession} disabled={busy}>
          {busy ? tr("Ouverture…", "Opening…") : tr("Ouvrir Flow / tester la session", "Open Flow / test session")}
        </button>
        <span className="faint" style={{ fontSize: 12 }}>
          {tr("Ce test ne génère aucune image et ne consomme aucun crédit.", "This test generates no image and spends no credits.")}
        </span>
      </div>
      {status && <div style={{ fontSize: 12, lineHeight: 1.5 }}>{status}</div>}
    </div>
  );
}

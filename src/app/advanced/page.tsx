"use client";
import { useEffect, useState } from "react";
import { ADVANCED_GROUPS } from "../full-settings/_groups";
import { GroupCard } from "../full-settings/_group-card";

/**
 * Advanced settings page. Pipeline behavior — TTS, video model, FFmpeg,
 * concurrency, alternative providers. Reads/writes the same /api/settings
 * endpoint as /settings; fields are just regrouped.
 */
export default function AdvancedSettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [revealing, setRevealing] = useState(false);

  async function load(reveal = false) {
    const data = await fetch(`/api/settings${reveal ? "?reveal=1" : ""}`).then((r) => r.json());
    setValues(data);
    setRevealing(reveal);
  }
  useEffect(() => {
    load(false);
  }, []);

  async function save() {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      const isSecret = k.includes("KEY") || k.includes("TOKEN") || k.includes("SECRET");
      if (isSecret && typeof v === "string" && v.includes("…")) continue;
      cleaned[k] = v;
    }
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleaned),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}) as { error?: string });
      alert(`Save failed: ${j.error || r.statusText}`);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    load(revealing);
  }

  return (
    <div>
      <h1>Advanced settings</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: 14 }}>
        Pipeline behavior — TTS, video model, FFmpeg, concurrency. Main API keys live in{" "}
        <a href="/full-settings">Keys &amp; Settings</a>.
      </p>

      <div
        className="page-toolbar"
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 18,
          background: "var(--bg)",
          padding: "10px 0",
          zIndex: 10,
        }}
      >
        <button className="btn-secondary" onClick={() => load(!revealing)}>
          {revealing ? "Hide secret values" : "Reveal secret values"}
        </button>
        <button className="btn" onClick={save}>
          {saved ? "Saved ✓" : "Save all changes"}
        </button>
      </div>

      {ADVANCED_GROUPS.map((g) => (
        <GroupCard key={g.title} group={g} values={values} setValues={setValues} />
      ))}
    </div>
  );
}

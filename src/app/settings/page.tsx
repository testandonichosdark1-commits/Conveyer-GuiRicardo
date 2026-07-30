"use client";
import { useEffect, useState } from "react";
import { MAIN_GROUPS } from "./_groups";
import { GroupCard } from "./_group-card";

interface StatsResp {
  keyCount: number;
  perKey: { image: number; tts: number; anim: number };
  total: { image: number; tts: number; anim: number };
  assembleConcurrency: number;
  xfadeChunks: number;
  animationEnabled: boolean;
  animationRatio: number;
}

type GdriveErrorKind = "api_not_enabled" | "auth_invalid" | "network" | "other";

interface GdriveStatus {
  connected: boolean;
  email?: string;
  error?: string;
  errorKind?: GdriveErrorKind;
  enableUrl?: string;
  syncEnabled: boolean;
  credentialsConfigured: boolean;
}

export default function SettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [stats, setStats] = useState<StatsResp | null>(null);
  const [gdrive, setGdrive] = useState<GdriveStatus | null>(null);

  async function load(reveal = false) {
    const [settingsR, statsR, gdriveR] = await Promise.all([
      fetch(`/api/settings${reveal ? "?reveal=1" : ""}`).then((r) => r.json()),
      fetch("/api/stats").then((r) => r.json()).catch(() => null),
      fetch("/api/gdrive/status").then((r) => r.json()).catch(() => null),
    ]);
    setValues(settingsR);
    setStats(statsR);
    setGdrive(gdriveR);
    setRevealing(reveal);
  }

  useEffect(() => {
    load(false);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gd = params.get("gdrive");
    if (!gd) return;
    if (gd === "connected") {
      alert("Google Drive connected ✓");
    } else if (gd === "error") {
      alert(`Drive connection failed: ${params.get("reason") || "unknown error"}`);
    }
    window.history.replaceState({}, "", "/settings");
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function disconnectGdrive() {
    if (!confirm("Disconnect Google Drive? You'll need to re-authorize to upload again.")) return;
    await fetch("/api/gdrive/disconnect", { method: "POST" });
    load(revealing);
  }

  function connectGdrive() {
    if (!gdrive?.credentialsConfigured) {
      alert("Fill GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET, then click 'Save all changes' before connecting.");
      return;
    }
    window.location.href = "/api/gdrive/oauth/start";
  }

  return (
    <div>
      <h1>Keys &amp; Settings</h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: 14 }}>
        The keys below are the minimum to run the pipeline. Everything else (TTS, video model,
        concurrency, FFmpeg) lives in <a href="/advanced">Advanced settings</a>.
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

      {/* ─── Parallel capacity ──────────────────────────────────────────── */}
      {stats && stats.keyCount > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <h2 style={{ margin: 0 }}>Parallel capacity</h2>
                {stats.keyCount >= 2 && (
                  <span className="badge badge-success">× {stats.keyCount} keys</span>
                )}
              </div>
              <div style={{ color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.6 }}>
                <strong style={{ color: "var(--fg)" }}>{stats.total.anim}</strong> video jobs ·{" "}
                <strong style={{ color: "var(--fg)" }}>{stats.total.tts}</strong> TTS jobs running at once
              </div>
              {stats.keyCount === 1 && (
                <div style={{ color: "var(--warning)", fontSize: 12, marginTop: 7 }}>
                  Add a second / third 69labs key below to multiply parallel capacity — with 3 keys,
                  generation is roughly 3× faster.
                </div>
              )}
              {stats.keyCount >= 2 && (
                <div style={{ color: "var(--success)", fontSize: 12, marginTop: 7 }}>
                  Multi-key mode active — generation runs ~{stats.keyCount}× faster than with one key.
                </div>
              )}
            </div>
            <div className="faint" style={{ fontSize: 11, textAlign: "right" }}>
              FFmpeg: {stats.assembleConcurrency} parallel clips
              <br />
              xfade chunks: {stats.xfadeChunks}
            </div>
          </div>
        </div>
      )}

      {/* ─── Required API keys ──────────────────────────────────────────── */}
      {MAIN_GROUPS.map((g) => (
        <GroupCard key={g.title} group={g} values={values} setValues={setValues} />
      ))}

      {/* ─── Google Drive Sync ──────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Google Drive Sync</h2>
          <span className="badge badge-accent">OPTIONAL</span>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.55 }}>
          Auto-upload finished runs to your Google Drive. Final videos go to one folder, raw scene
          clips plus metadata go to another — so the AI can later find relevant clips from past runs
          to reuse.
        </p>

        {gdrive && (
          <div
            style={{
              padding: "11px 13px",
              borderRadius: "var(--r-sm)",
              marginBottom: 16,
              background: gdrive.connected
                ? "var(--success-soft)"
                : gdrive.error
                  ? "var(--danger-soft)"
                  : "var(--surface-2)",
              border: `1px solid ${
                gdrive.connected
                  ? "rgba(74,222,128,0.3)"
                  : gdrive.error
                    ? "rgba(248,113,113,0.3)"
                    : "var(--border)"
              }`,
            }}
          >
            {gdrive.connected ? (
              <span style={{ color: "var(--success)", fontWeight: 600, fontSize: 13 }}>
                ✓ Connected as <span style={{ color: "var(--fg)" }}>{gdrive.email || "(unknown email)"}</span>
              </span>
            ) : gdrive.error ? (
              <div>
                {gdrive.errorKind === "api_not_enabled" ? (
                  <>
                    <div style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13 }}>
                      Google Drive API is not enabled in your Google Cloud project
                    </div>
                    <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
                      Open the link below, click <strong>Enable</strong>, wait ~1 min, then refresh:
                    </div>
                    {gdrive.enableUrl && (
                      <a
                        href={gdrive.enableUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 12, marginTop: 6, display: "inline-block", wordBreak: "break-all" }}
                      >
                        {gdrive.enableUrl}
                      </a>
                    )}
                  </>
                ) : gdrive.errorKind === "auth_invalid" ? (
                  <div style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13 }}>
                    Token expired or revoked — click <strong>Reconnect</strong>
                  </div>
                ) : gdrive.errorKind === "network" ? (
                  <div style={{ color: "var(--warning)", fontWeight: 600, fontSize: 13 }}>
                    Network error reaching Google — check your connection and refresh
                  </div>
                ) : (
                  <div style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13 }}>
                    Drive connection issue — see details below
                  </div>
                )}
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", color: "var(--fg-muted)", fontSize: 11 }}>
                    Raw error
                  </summary>
                  <div
                    className="mono"
                    style={{ color: "var(--fg-muted)", fontSize: 11, marginTop: 4, whiteSpace: "pre-wrap" }}
                  >
                    {gdrive.error}
                  </div>
                </details>
              </div>
            ) : gdrive.credentialsConfigured ? (
              <span style={{ color: "var(--warning)", fontWeight: 600, fontSize: 13 }}>
                Not connected — click <strong>Connect Google Drive</strong> below
              </span>
            ) : (
              <span style={{ color: "var(--fg-muted)", fontWeight: 600, fontSize: 13 }}>
                Fill <code>GDRIVE_CLIENT_ID</code> + <code>GDRIVE_CLIENT_SECRET</code> below, click{" "}
                <strong>Save all changes</strong>, then come back to connect.
              </span>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {gdrive?.connected ? (
            <>
              <button className="btn-secondary" onClick={connectGdrive}>
                Reconnect (switch account)
              </button>
              <button className="btn-danger" onClick={disconnectGdrive}>
                Disconnect
              </button>
            </>
          ) : (
            <button className="btn" onClick={connectGdrive} disabled={!gdrive?.credentialsConfigured}>
              Connect Google Drive
            </button>
          )}
        </div>

        <div
          className="card-inset"
          style={{
            marginBottom: 16,
            padding: "11px 13px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <label
            style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
          >
            <input
              type="checkbox"
              checked={values.GDRIVE_SYNC_ENABLED === "1"}
              onChange={(e) => setValues({ ...values, GDRIVE_SYNC_ENABLED: e.target.checked ? "1" : "" })}
              style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
            />
            <span>Auto-upload finished runs to Drive</span>
          </label>
          <span className="faint" style={{ fontSize: 11 }}>
            Uploads final video + raw clips + metadata after each run. Saves with <strong>Save all changes</strong>.
          </span>
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          {[
            {
              key: "GDRIVE_CLIENT_ID",
              desc: "OAuth Client ID from Google Cloud Console (Web Application type).",
              examples: "Format: 123456789-abc.apps.googleusercontent.com",
            },
            {
              key: "GDRIVE_CLIENT_SECRET",
              desc: "OAuth Client Secret from the same credential. Treated as a secret — masked after save.",
              examples: "Format: GOCSPX-xxxxxxxxxxxxxxxx",
            },
            {
              key: "GDRIVE_FINAL_VIDEOS_FOLDER_ID",
              desc: "Drive folder ID for finished videos. Leave empty to auto-create `Conveyer Grok/Final Videos/` on first sync.",
              examples: "From folder URL: drive.google.com/drive/folders/<THIS_PART>",
            },
            {
              key: "GDRIVE_CLIPS_LIBRARY_FOLDER_ID",
              desc: "Drive folder ID for per-run sub-folders with raw clips + metadata. Leave empty to auto-create `Conveyer Grok/Clips Library/`.",
              examples: "Same format as above",
            },
          ].map((f) => (
            <div key={f.key}>
              <label className="label" style={{ fontWeight: 600, letterSpacing: "0.01em" }}>
                {f.key}
              </label>
              <input
                className="input"
                value={values[f.key] ?? ""}
                placeholder={`e.g. ${f.examples}`}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
              <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>{f.desc}</div>
              <div className="mono faint" style={{ fontSize: 11, marginTop: 3 }}>
                {f.examples}
              </div>
            </div>
          ))}
        </div>

        <details
          className="card-inset"
          style={{ marginTop: 16, padding: 14 }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
            First-time setup — how to get Client ID / Secret
          </summary>
          <ol style={{ marginTop: 10, paddingLeft: 20, color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.75 }}>
            <li>
              Open <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">Google Cloud Console</a>
            </li>
            <li>Create a new project (or reuse an existing one)</li>
            <li>APIs &amp; Services → Library → enable <strong>Google Drive API</strong></li>
            <li>OAuth consent screen → <strong>External</strong> → add your Gmail to <strong>Test users</strong></li>
            <li>Credentials → Create OAuth client → <strong>Web Application</strong></li>
            <li>
              Authorized redirect URI:{" "}
              <code style={{ background: "var(--bg-deep)", padding: "2px 6px", borderRadius: 4 }}>
                http://localhost:3000/api/gdrive/oauth/callback
              </code>
            </li>
            <li>Copy <strong>Client ID</strong> + <strong>Client Secret</strong> into the fields above</li>
            <li>Click <strong>Save all changes</strong> at the top</li>
            <li>Then click <strong>Connect Google Drive</strong> — approve access in the browser tab</li>
          </ol>
        </details>
      </div>
    </div>
  );
}

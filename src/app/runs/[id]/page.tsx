"use client";
import { useEffect, useRef, useState, use } from "react";

interface LogEntry {
  id?: number;
  ts: string;
  level: "info" | "warn" | "error" | "success" | "debug";
  stage?: string;
  message: string;
  data?: unknown;
}
interface Run {
  id: string;
  title: string | null;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  output_path: string | null;
}
interface SceneAsset {
  index: number;
  audio?: { name: string; size: number };
  image?: { name: string; size: number };
  animation?: { name: string; size: number };
  clip?: { name: string; size: number };
}
interface AssetsResponse {
  runDir: string;
  scenes: SceneAsset[];
  finalExists: boolean;
  finalSize: number;
}
interface DriveStatus {
  syncEnabled: boolean;
  connected: boolean;
  synced: boolean;
  syncedAt?: string;
  clipsFolderId?: string;
  finalVideoId?: string;
  clipsFolderLink?: string;
  finalVideoLink?: string;
  canRetry: boolean;
  rawClipsRemainCount: number;
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [assets, setAssets] = useState<AssetsResponse | null>(null);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [uploadingDrive, setUploadingDrive] = useState(false);
  const [resuming, setResuming] = useState(false);
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function tick() {
      // A deleted job 404s here — surface a clean "deleted" state and STOP polling
      // (otherwise the interval would 404 this endpoint forever, and any child
      // request like the <video> src / download would keep hitting a gone file).
      const runResp = await fetch(`/api/runs/${id}`);
      if (!alive) return;
      if (runResp.status === 404) {
        setNotFound(true);
        if (timer) clearInterval(timer);
        return;
      }
      const [runR, assetsR, driveR] = await Promise.all([
        runResp.json(),
        fetch(`/api/runs/${id}/assets`).then((r) => r.json()),
        fetch(`/api/runs/${id}/drive`).then((r) => r.json()).catch(() => null),
      ]);
      if (!alive) return;
      setRun(runR.run as Run);
      setLogs(Array.isArray(runR.logs) ? (runR.logs as LogEntry[]) : []);
      setAssets(assetsR as AssetsResponse);
      setDrive(driveR as DriveStatus | null);
    }
    tick();
    timer = setInterval(tick, 2500);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [id]);

  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  async function cancel() {
    if (!confirm("Stop this run? Already generated files stay on disk, but no new progress will be made.")) return;
    await fetch(`/api/runs/${id}/cancel`, { method: "POST" });
  }

  async function uploadToDrive() {
    setUploadingDrive(true);
    try {
      const r = await fetch(`/api/runs/${id}/drive`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}) as { error?: string });
        alert(`Upload to Drive failed:\n\n${j.error || r.statusText}`);
        return;
      }
      const fresh = await fetch(`/api/runs/${id}/drive`).then((x) => x.json());
      setDrive(fresh as DriveStatus);
    } finally {
      setUploadingDrive(false);
    }
  }

  async function openFolder() {
    try {
      const r = await fetch(`/api/runs/${id}/open-folder`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) {
        alert(`Failed to open folder: ${j.error}\n\nPath: ${j.runDir || ""}`);
        return;
      }
    } catch (e) {
      alert(`Error: ${(e as Error).message}`);
    }
  }

  async function resume() {
    setResuming(true);
    try {
      const r = await fetch(`/api/runs/${id}/reassemble`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}) as { error?: string });
        alert(`Couldn't resume this run:\n\n${j.error || r.statusText}`);
      }
      // on success the run flips to "running" and the log stream takes over
    } finally {
      setResuming(false);
    }
  }

  async function recoverFromDrive() {
    if (
      !confirm(
        "Recover this run from Drive?\n\n" +
          "Downloads every clip from the Drive Clips Library folder back to local disk, " +
          "then re-assembles and re-uploads. Costs ZERO 69labs credits — only Drive download. " +
          "Use this when local assets were lost but Drive still has them."
      )
    )
      return;
    setResuming(true);
    try {
      const r = await fetch(`/api/runs/${id}/recover-from-drive`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}) as { error?: string });
        alert(`Couldn't recover from Drive:\n\n${j.error || r.statusText}`);
      }
    } finally {
      setResuming(false);
    }
  }

  function downloadLogs() {
    const body = logs
      .map((l) => `${l.ts}  [${l.stage ?? "-"}]  ${l.level.toUpperCase()}  ${l.message}`)
      .join("\n");
    const header = `Faceless Video Generator — run ${id}\nstatus: ${run?.status ?? "?"}\ngenerated: ${new Date().toISOString()}\n\n`;
    const blob = new Blob([header + body], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `logs-${id.slice(0, 8)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  const fileUrl = (p: string, dl = false) =>
    `/api/runs/${id}/file?p=${encodeURIComponent(p)}${dl ? "&download=1" : ""}`;

  if (notFound) {
    return (
      <div>
        <h1 style={{ marginBottom: 6 }}>Job deleted</h1>
        <div className="card">
          <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
            This job was deleted — its files and logs are gone. Its cost history is preserved on the{" "}
            <a href="/costs">Costs</a> page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 18,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1 style={{ marginBottom: 2 }}>{run?.title || `Run ${id.slice(0, 8)}`}</h1>
          <div className="mono faint" style={{ fontSize: 11.5 }}>{id}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {(run?.status === "running" || run?.status === "pending") && (
            <button className="btn-danger btn-sm" onClick={cancel}>
              Stop
            </button>
          )}
          {run && <span className={`tag tag-${run.status}`}>{run.status}</span>}
        </div>
      </div>

      {/* ─── Resume banner — failed/cancelled run with assets on disk ────── */}
      {(run?.status === "error" || run?.status === "cancelled") &&
        assets &&
        assets.scenes.length > 0 &&
        !assets.finalExists && (
          <div
            className="card"
            style={{ marginBottom: 14, borderColor: "rgba(252,211,77,0.4)" }}
          >
            <h2 style={{ marginBottom: 6 }}>Run incomplete — can be resumed</h2>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.55 }}>
              {assets.scenes.length} scene{assets.scenes.length === 1 ? "" : "s"} already have
              assets on disk. <strong style={{ color: "var(--fg)" }}>Resume</strong> regenerates
              only the missing scenes, then re-assembles the final video and re-uploads to Drive —
              clips you already paid for are not regenerated.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="btn" onClick={resume} disabled={resuming}>
                {resuming ? "Working…" : "Resume run"}
              </button>
              <button className="btn-secondary" onClick={recoverFromDrive} disabled={resuming}>
                {resuming ? "Working…" : "🔄 Recover from Drive"}
              </button>
            </div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
              <strong style={{ color: "var(--fg)" }}>Recover from Drive</strong> downloads every clip
              previously uploaded to the run&apos;s Drive Clips Library folder back to disk, then
              re-assembles — zero 69labs credits. Use this if local assets were cleaned up but Drive
              still has the clips.
            </div>
          </div>
        )}

      {/* ─── Final video ────────────────────────────────────────────────── */}
      {assets?.finalExists && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2 style={{ margin: 0 }}>Final video</h2>
              <div className="faint" style={{ fontSize: 12 }}>
                {(assets.finalSize / (1024 * 1024)).toFixed(2)} MB
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <a className="btn" href={fileUrl("final.mp4", true)}>
                Download MP4
              </a>
              <button className="btn-secondary" onClick={openFolder}>
                Open folder
              </button>
            </div>
          </div>
          <video
            controls
            style={{ width: "100%", maxHeight: 480, borderRadius: "var(--r-sm)", background: "#000" }}
            src={fileUrl("final.mp4")}
          />
        </div>
      )}

      {/* ─── Google Drive status ────────────────────────────────────────── */}
      {drive && assets?.finalExists && run?.status === "done" && (
        <div className="card" style={{ marginBottom: 14 }}>
          {drive.synced ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                <h2 style={{ margin: 0, color: "var(--success)" }}>Saved to Google Drive</h2>
                {drive.syncedAt && (
                  <span className="faint" style={{ fontSize: 12 }}>
                    {new Date(
                      drive.syncedAt.endsWith("Z") ? drive.syncedAt : drive.syncedAt + "Z"
                    ).toLocaleString()}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {drive.finalVideoLink && (
                  <a className="btn-secondary" href={drive.finalVideoLink} target="_blank" rel="noopener noreferrer">
                    Open final video in Drive
                  </a>
                )}
                {drive.clipsFolderLink && (
                  <a className="btn-secondary" href={drive.clipsFolderLink} target="_blank" rel="noopener noreferrer">
                    Open clips folder
                  </a>
                )}
                <button
                  className="btn-secondary"
                  onClick={uploadToDrive}
                  disabled={uploadingDrive}
                  title="Re-upload final video and refresh the manifest"
                >
                  {uploadingDrive ? "Syncing…" : "Sync again"}
                </button>
              </div>
              {!drive.canRetry && (
                <div className="faint" style={{ fontSize: 11, marginTop: 9 }}>
                  Raw scene clips have already been cleaned up locally — &quot;Sync again&quot; only
                  re-uploads the final video + manifest.
                </div>
              )}
            </>
          ) : drive.connected ? (
            <>
              <h2 style={{ marginBottom: 6 }}>Not yet in Google Drive</h2>
              <p className="muted" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
                {drive.syncEnabled
                  ? "Auto-upload is on but this run hasn't synced yet — probably finished before Drive was connected, or the upload failed."
                  : "Auto-upload is off in Settings. You can still upload this single run by hand."}
              </p>
              <button className="btn" onClick={uploadToDrive} disabled={uploadingDrive}>
                {uploadingDrive ? "Uploading…" : "Upload to Google Drive"}
              </button>
            </>
          ) : (
            <>
              <h2 style={{ marginBottom: 6, color: "var(--warning)" }}>Google Drive not connected</h2>
              <p className="muted" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
                Connect your Google account in Settings to save runs automatically and enable AI
                search across past clips.
              </p>
              <a className="btn-secondary" href="/settings">
                Open Settings →
              </a>
            </>
          )}
        </div>
      )}

      {/* ─── Logs ───────────────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 14, padding: 0, overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            fontWeight: 650,
            fontSize: 13,
            padding: "9px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span>Logs</span>
          <button
            className="btn-secondary btn-sm"
            onClick={downloadLogs}
            disabled={logs.length === 0}
            title="Download these logs as a text file to share for debugging"
          >
            ⬇ Download logs
          </button>
        </div>
        <div
          className="mono"
          style={{
            background: "var(--bg-deep)",
            maxHeight: 420,
            overflowY: "auto",
            fontSize: 11.5,
            padding: "10px 16px",
            lineHeight: 1.7,
          }}
        >
          {logs.length === 0 && <div className="faint">Waiting for logs…</div>}
          {logs.map((l, i) => (
            <div key={l.id ?? i}>
              <span className="faint">{new Date(l.ts).toLocaleTimeString()}</span>{" "}
              {l.stage && <span style={{ color: "var(--accent-hover)" }}>[{l.stage}]</span>}{" "}
              <span style={{ color: levelColor(l.level), fontWeight: 600 }}>{l.level.toUpperCase()}</span>{" "}
              <span style={{ color: "var(--fg-muted)" }}>{l.message}</span>
            </div>
          ))}
          <div ref={tail} />
        </div>
      </div>

      {/* ─── Scene assets ───────────────────────────────────────────────── */}
      {assets && assets.scenes.length > 0 && (
        <div className="card">
          <h2 style={{ marginBottom: 12 }}>Scene assets · {assets.scenes.length}</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
              gap: 10,
            }}
          >
            {assets.scenes.map((s) => (
              <div key={s.index} className="card-inset" style={{ padding: 10 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5, marginBottom: 7 }}>Scene #{s.index}</div>
                {s.image && (
                  <a href={fileUrl(`images/${s.image.name}`, true)} title="Download image">
                    <img
                      src={fileUrl(`images/${s.image.name}`)}
                      alt={`scene ${s.index}`}
                      style={{ width: "100%", borderRadius: 6, display: "block" }}
                    />
                  </a>
                )}
                {s.audio && (
                  <audio
                    controls
                    src={fileUrl(`audio/${s.audio.name}`)}
                    style={{ width: "100%", marginTop: 7 }}
                  />
                )}
                <div style={{ display: "flex", gap: 5, marginTop: 7, flexWrap: "wrap" }}>
                  {s.audio && (
                    <a href={fileUrl(`audio/${s.audio.name}`, true)} className="btn-ghost btn-sm">
                      mp3
                    </a>
                  )}
                  {s.animation && (
                    <a href={fileUrl(`animations/${s.animation.name}`, true)} className="btn-ghost btn-sm">
                      clip
                    </a>
                  )}
                  {s.clip && (
                    <a href={fileUrl(`clips/${s.clip.name}`, true)} className="btn-ghost btn-sm">
                      rendered
                    </a>
                  )}
                  {s.image && (
                    <a href={fileUrl(`images/${s.image.name}`, true)} className="btn-ghost btn-sm">
                      img
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function levelColor(l: LogEntry["level"]) {
  switch (l) {
    case "error":
      return "var(--danger)";
    case "warn":
      return "var(--warning)";
    case "success":
      return "var(--success)";
    case "debug":
      return "var(--fg-faint)";
    default:
      return "var(--accent-hover)";
  }
}

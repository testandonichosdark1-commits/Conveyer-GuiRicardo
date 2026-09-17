"use client";
import { useEffect, useMemo, useRef, useState, use } from "react";
import { parseDegraded, DEGRADE_TEXT } from "@/lib/degraded";

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
  status: "pending" | "running" | "done" | "error" | "cancelled" | "interrupted";
  /** Finished, but not as asked — a comma-joined list of codes; decode with parseDegraded. */
  degraded?: string | null;
  output_path: string | null;
  /** SQLite `datetime('now')` — UTC, no trailing "Z". */
  created_at: string;
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
  const [canResume, setCanResume] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [assets, setAssets] = useState<AssetsResponse | null>(null);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [uploadingDrive, setUploadingDrive] = useState(false);
  const [resuming, setResuming] = useState(false);
  // Incremental log streaming state (survives polls, resets on remount/refresh):
  //   lastSeenId — highest log id already in `logs`; sent as ?sinceId so each poll
  //                fetches only NEW rows (append, never re-download the history).
  //   logBox     — the scrollable log container.
  //   stickBottom— true while the user is parked at the bottom; only then do we
  //                auto-scroll on new lines, so scrolling up to read is preserved.
  const lastSeenId = useRef(0);
  const logBox = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  useEffect(() => {
    let alive = true; // false once the component unmounts
    let stop = false; // true once polling should end for good (run 404 = deleted)
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      // Ask only for logs newer than what we already have. First tick after mount
      // (or a browser refresh) has lastSeenId=0 → full history; every tick after
      // that transfers just the delta. Identical for fresh / refresh / resume.
      const runResp = await fetch(`/api/runs/${id}?sinceId=${lastSeenId.current}`);
      if (!alive) return;
      // A deleted job 404s here — surface a clean "deleted" state and STOP polling
      // (otherwise we'd 404 this endpoint forever, and any child request like the
      // <video> src / download would keep hitting a gone file).
      if (runResp.status === 404) {
        setNotFound(true);
        stop = true;
        return;
      }
      const [runR, assetsR, driveR] = await Promise.all([
        runResp.json(),
        fetch(`/api/runs/${id}/assets`).then((r) => r.json()),
        fetch(`/api/runs/${id}/drive`).then((r) => r.json()).catch(() => null),
      ]);
      if (!alive) return;
      setRun(runR.run as Run);
      setCanResume(!!runR.canResume);
      const fresh = Array.isArray(runR.logs) ? (runR.logs as LogEntry[]) : [];
      if (fresh.length) {
        // The query guarantees id > lastSeenId, so these are strictly new. Advance
        // the cursor here, at the END of a fully-completed poll — and because the
        // next poll is only scheduled AFTER this one returns (see loop() below),
        // no other request can read the cursor until it has advanced. Append,
        // never replace, so existing rows don't flicker and there are no dupes.
        lastSeenId.current = fresh[fresh.length - 1].id ?? lastSeenId.current;
        setLogs((prev) => [...prev, ...fresh]);
      }
      setAssets(assetsR as AssetsResponse);
      setDrive(driveR as DriveStatus | null);
    }

    // Self-scheduling loop instead of setInterval: the next poll is scheduled ONLY
    // after the current one has completely finished (cursor advanced), so exactly
    // one poll is ever in flight. A poll slower than the interval just delays the
    // next tick — it never launches a second, overlapping request that could reuse
    // a stale cursor and re-fetch the same id>sinceId batch (the Phase-2 dup race).
    // tick() is wrapped so a transient fetch error doesn't kill the loop (a throw
    // happens before the cursor advances, so the next tick simply retries — no gap).
    async function loop() {
      try {
        await tick();
      } catch {
        // transient network/parse error — keep polling on the next tick
      }
      if (!alive || stop) return;
      timer = setTimeout(loop, 2500);
    }
    loop();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  // Ticks once a second purely to re-render the elapsed-time counter while a run is
  // active — independent of the 2.5s log poll, so the clock doesn't visibly stutter.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (run?.status !== "running" && run?.status !== "pending") return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run?.status]);

  // Progress estimate derived from the log stream itself — no backend change needed.
  // `planner` lines are emitted exactly once per beat during planning, so the count of
  // distinct beat indices there is the total. A beat index appearing in ANY later
  // visual/avatar-stage line means work has started on it — a beat generates many such
  // lines while it's being worked on (searches, scoring, retries), so "seen at least
  // once" lags only slightly behind "fully done", close enough for a rough ETA.
  const { totalBeats, touchedBeats, assembleStartMs } = useMemo(() => {
    const planned = new Set<number>();
    const touched = new Set<number>();
    let assembleStartMs: number | null = null;
    for (const l of logs) {
      const m = /^Beat (\d+): planner /.exec(l.message);
      if (m) planned.add(Number(m[1]));
      else if (l.stage === "visual" || l.stage === "avatar_video") {
        const t = /^Beat (\d+)/.exec(l.message);
        if (t) touched.add(Number(t[1]));
      }
      // First "assemble" line ("Compositing N beats…") marks the moment beat-touch
      // progress stops meaning anything — every beat is already done and the run is
      // rendering/muxing instead. Used below to switch the ETA to a measured
      // per-beat assembly rate instead of the (by-then-meaningless) beat fraction.
      if (assembleStartMs === null && l.stage === "assemble") {
        assembleStartMs = new Date(l.ts).getTime();
      }
    }
    return { totalBeats: planned.size, touchedBeats: touched, assembleStartMs };
  }, [logs]);

  // Auto-scroll to the newest line ONLY when the user is already at the bottom,
  // so a live tail keeps following (like a fresh generation) but scrolling up to
  // read history is never yanked away. Runs on real appends only (logs identity
  // changes solely when new rows arrive), so there's no per-poll scroll churn.
  useEffect(() => {
    const el = logBox.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

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

  // What this run failed to deliver, worst first. Empty for a clean run and for every run
  // that is still going, so both the badge and the banner below key off the same list.
  const degradedCodes = parseDegraded(run?.degraded);

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
          {run &&
            (run.status === "done" && degradedCodes.length > 0 ? (
              <span className="tag tag-degraded">done ⚠</span>
            ) : (
              <span className={`tag tag-${run.status}`}>{run.status}</span>
            ))}
        </div>
      </div>

      {/* ─── Degraded banner ────────────────────────────────────────────────
          The run finished and the video is downloadable, so nothing here blocks it —
          but an avatar run that rendered faceless used to look identical to one that
          worked. This is the difference, stated where the operator collects the file
          rather than buried in a warn line halfway up the log. */}
      {run?.status === "done" && degradedCodes.length > 0 && (
        <div className="card" style={{ marginBottom: 14, borderColor: "rgba(252,211,77,0.4)" }}>
          <h2 style={{ marginBottom: 6, color: "var(--warning)" }}>
            {`Completed with warnings — ${degradedCodes.map((c) => DEGRADE_TEXT[c].heading).join(" · ")}`}
          </h2>
          {/* One paragraph per failure: a run that lost BOTH its avatar and its text cards has
              two separate things to explain, and picking one would hide the other. */}
          {degradedCodes.map((c) => (
            <p key={c} className="muted" style={{ fontSize: 13, lineHeight: 1.55, margin: "0 0 6px" }}>
              {DEGRADE_TEXT[c].detail}
            </p>
          ))}
        </div>
      )}

      {/* ─── Resume banner — resumable run (interrupted / failed / cancelled) ─
          Shown from the REAL backend capability (canResume), not from scene-asset
          layout: studio runs never create scene assets, so the old scenes.length
          gate hid Resume for every studio run. "interrupted" = a pipeline killed
          by a server/PM2/power restart, recovered on startup. */}
      {(run?.status === "interrupted" || run?.status === "error" || run?.status === "cancelled") &&
        canResume &&
        !assets?.finalExists && (
          <div
            className="card"
            style={{ marginBottom: 14, borderColor: "rgba(252,211,77,0.4)" }}
          >
            <h2 style={{ marginBottom: 6 }}>
              {run?.status === "interrupted"
                ? "Generation was interrupted — can be resumed"
                : "Run incomplete — can be resumed"}
            </h2>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.55 }}>
              Work already on disk is kept. <strong style={{ color: "var(--fg)" }}>Resume</strong>{" "}
              regenerates only what's missing, then re-assembles the final video — clips you already
              paid for are not regenerated.
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
              <a className="btn-secondary" href="/full-settings">
                Open Settings →
              </a>
            </>
          )}
        </div>
      )}

      {/* ─── Elapsed / ETA — only while the run is actually generating ────── */}
      {(run?.status === "running" || run?.status === "pending") && (() => {
        const startedAtMs = new Date(
          run.created_at.endsWith("Z") ? run.created_at : run.created_at + "Z"
        ).getTime();
        const elapsedMs = Math.max(0, nowMs - startedAtMs);
        const fraction = totalBeats > 0 ? touchedBeats.size / totalBeats : 0;
        let etaMs: number | null;
        if (assembleStartMs !== null) {
          // Beat-touch progress is meaningless here — every beat is done and ffmpeg is
          // compositing/muxing them. That phase doesn't track beats at all, so estimate
          // it from its own measured rate instead: across 16 completed runs, wall time
          // from the first "Compositing N beats" line to the run's last log line
          // averaged ~2.6s/beat (9303s / 3546 beats total, 2.2–3.5s/beat per run) —
          // count DOWN from that budget using time actually spent in this phase so far,
          // rather than the old fixed 1%-of-elapsed guess that stayed pinned at ~20–30s
          // while assembly ran for several more minutes. Still a rough average (real
          // per-run rate varies ±35%), but it lands in the right ballpark instead of off
          // by 10-20x like the old formula did.
          const ASSEMBLY_SEC_PER_BEAT = 2.62;
          const budgetMs = totalBeats * ASSEMBLY_SEC_PER_BEAT * 1000;
          const spentMs = nowMs - assembleStartMs;
          etaMs = Math.max(0, budgetMs - spentMs);
        } else {
          // Below ~2% progress the elapsed/fraction extrapolation swings wildly (e.g. one
          // beat out of 200 could imply anywhere from 3 minutes to 3 hours) — show
          // "Estimating…" instead of a number nobody should trust yet. Capped below 1 so
          // the brief gap between the last beat being touched and the assemble stage
          // actually starting doesn't zero the denominator and flash "Estimating…".
          const etaFraction = Math.min(fraction, 0.99);
          etaMs = etaFraction > 0.02 ? elapsedMs / etaFraction - elapsedMs : null;
        }
        return (
          <div
            className="card"
            style={{
              marginBottom: 14,
              display: "flex",
              gap: 24,
              flexWrap: "wrap",
              alignItems: "baseline",
            }}
          >
            <div>
              <div className="faint" style={{ fontSize: 11, marginBottom: 2 }}>Elapsed</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 650 }}>{formatDuration(elapsedMs)}</div>
            </div>
            <div>
              <div className="faint" style={{ fontSize: 11, marginBottom: 2 }}>Estimated remaining</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 650 }}>
                {etaMs === null ? "Estimating…" : `~${formatDuration(etaMs)}`}
              </div>
            </div>
            {totalBeats > 0 && (
              <div>
                <div className="faint" style={{ fontSize: 11, marginBottom: 2 }}>Beats</div>
                <div className="mono" style={{ fontSize: 16, fontWeight: 650 }}>
                  {Math.min(touchedBeats.size, totalBeats)}/{totalBeats}
                </div>
              </div>
            )}
          </div>
        );
      })()}

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
          ref={logBox}
          onScroll={() => {
            const el = logBox.current;
            if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
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

/** "1h 24m", "8m 05s", "42s" — always at most two units, so it never gets noisy. */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
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

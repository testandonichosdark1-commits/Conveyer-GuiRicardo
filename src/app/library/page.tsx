"use client";
import { useEffect, useMemo, useState } from "react";

interface LibraryClip {
  index: number;
  file: string;
  drive_file_id: string;
  drive_file_link: string;
  scene_text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  audio_duration_sec: number | null;
}

interface LibraryRun {
  drive_folder_id: string;
  drive_folder_name: string;
  drive_folder_link: string;
  run_id: string;
  run_title: string | null;
  folder_name: string;
  channel: string;
  created_at: string;
  scene_count: number;
  uploaded_clip_count: number;
  settings: {
    animation_provider: string;
    animation_model: string;
    video_resolution: string;
  };
  clips: LibraryClip[];
}

interface GdriveStatus {
  connected: boolean;
  credentialsConfigured: boolean;
}

export default function LibraryPage() {
  const [runs, setRuns] = useState<LibraryRun[] | null>(null);
  const [drive, setDrive] = useState<GdriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const driveR = await fetch("/api/gdrive/status").then((r) => r.json());
        if (!alive) return;
        setDrive(driveR as GdriveStatus);
        if (!driveR.connected) {
          setRuns([]);
          return;
        }
        const r = await fetch("/api/library/runs").then((r) => r.json());
        if (!alive) return;
        if (r.error) {
          setError(String(r.error));
          setRuns([]);
        } else {
          setRuns((r.runs ?? []) as LibraryRun[]);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!runs) return [];
    const q = query.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((r) => {
      const inTitle = (r.run_title || r.folder_name).toLowerCase().includes(q);
      const inClips = r.clips.some(
        (c) => c.scene_text.toLowerCase().includes(q) || c.visual_prompt.toLowerCase().includes(q)
      );
      return inTitle || inClips;
    });
  }, [runs, query]);

  // Group runs by channel — channels alphabetical, "_No Channel" last.
  const grouped = useMemo(() => {
    const m = new Map<string, LibraryRun[]>();
    for (const r of filtered) {
      const list = m.get(r.channel) ?? [];
      list.push(r);
      m.set(r.channel, list);
    }
    return [...m.entries()].sort(([a], [b]) => {
      if (a === "_No Channel") return 1;
      if (b === "_No Channel") return -1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  return (
    <div>
      <h1>Library</h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: 14, lineHeight: 1.6 }}>
        Every run you&apos;ve saved to Google Drive. The AI uses this library to find clips it can
        reuse when you start a new run with similar scenes.
      </p>

      {loading && <div className="muted">Loading…</div>}

      {!loading && drive && !drive.connected && (
        <div className="card">
          <h2 style={{ marginBottom: 6, color: "var(--warning)" }}>Google Drive not connected</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
            Connect your Google account in Settings — saved runs will appear here automatically.
          </p>
          <a className="btn" href="/settings">
            Open Settings →
          </a>
        </div>
      )}

      {!loading && drive?.connected && error && (
        <div className="card" style={{ borderColor: "rgba(248,113,113,0.35)", marginBottom: 12 }}>
          <div style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13 }}>
            Couldn&apos;t load library
          </div>
          <div className="mono" style={{ color: "var(--fg-muted)", fontSize: 11, marginTop: 6, whiteSpace: "pre-wrap" }}>
            {error}
          </div>
        </div>
      )}

      {!loading && drive?.connected && !error && runs && runs.length === 0 && (
        <div className="card">
          <h2 style={{ marginBottom: 6 }}>Library is empty</h2>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            Run the pipeline — finished runs auto-upload to Drive (if &quot;Auto-upload finished runs
            to Drive&quot; is on in Settings). Each new run shows up here.
          </p>
        </div>
      )}

      {!loading && drive?.connected && runs && runs.length > 0 && (
        <>
          <div style={{ marginBottom: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="input"
              placeholder="Search by title or scene text…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ maxWidth: 380, flex: 1 }}
            />
            <span className="muted" style={{ fontSize: 13 }}>
              {filtered.length === runs.length
                ? `${runs.length} run${runs.length === 1 ? "" : "s"}`
                : `${filtered.length} of ${runs.length} runs`}
            </span>
          </div>

          {grouped.map(([channel, channelRuns]) => (
            <div key={channel} style={{ marginBottom: 26 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>{channel === "_No Channel" ? "No channel" : channel}</h2>
                <span className="badge badge-neutral">
                  {channelRuns.length} run{channelRuns.length === 1 ? "" : "s"}
                </span>
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                {channelRuns.map((r) => {
                  const isOpen = openRunId === r.drive_folder_id;
                  return (
                <div key={r.drive_folder_id} className="card">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontWeight: 650, fontSize: 14.5, marginBottom: 3 }}>
                        {r.run_title || r.folder_name}
                      </div>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {r.created_at && <span>{new Date(r.created_at).toLocaleString()} · </span>}
                        {r.uploaded_clip_count} clip{r.uploaded_clip_count === 1 ? "" : "s"}
                        {r.scene_count !== r.uploaded_clip_count && <span> / {r.scene_count} scenes</span>}
                        {r.settings.animation_model && (
                          <span>
                            {" "}· {r.settings.animation_model}
                            {r.settings.video_resolution && ` (${r.settings.video_resolution})`}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        className="btn-secondary btn-sm"
                        onClick={() => setOpenRunId(isOpen ? null : r.drive_folder_id)}
                      >
                        {isOpen ? "Hide clips" : `View ${r.uploaded_clip_count} clips`}
                      </button>
                      <a
                        className="btn-secondary btn-sm"
                        href={r.drive_folder_link}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open in Drive
                      </a>
                    </div>
                  </div>

                  {isOpen && (
                    <div
                      style={{
                        marginTop: 14,
                        paddingTop: 12,
                        borderTop: "1px solid var(--border)",
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))",
                        gap: 10,
                      }}
                    >
                      {r.clips.map((c) => (
                        <div key={c.drive_file_id} className="card-inset" style={{ padding: 11 }}>
                          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
                            Scene {c.index}
                            {c.audio_duration_sec != null && c.audio_duration_sec > 0 && (
                              <span className="faint" style={{ marginLeft: 6, fontWeight: 400 }}>
                                {c.audio_duration_sec.toFixed(1)}s audio
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              color: "var(--fg-muted)",
                              fontSize: 11,
                              lineHeight: 1.5,
                              marginBottom: 6,
                              maxHeight: 70,
                              overflow: "auto",
                            }}
                          >
                            {c.scene_text}
                          </div>
                          <div
                            className="mono"
                            style={{
                              color: "var(--accent-hover)",
                              fontSize: 10,
                              marginBottom: 8,
                              maxHeight: 70,
                              overflow: "auto",
                              lineHeight: 1.4,
                            }}
                          >
                            {c.visual_prompt}
                          </div>
                          <a href={c.drive_file_link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>
                            Open clip in Drive →
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

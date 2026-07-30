"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface RunRow {
  id: string;
  title: string | null;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  created_at: string;
  updated_at: string;
  output_path: string | null;
}

export default function RunsListPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    async function tick() {
      const r = await fetch("/api/runs");
      if (!alive) return;
      setRuns(await r.json());
      setLoaded(true);
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div>
      <h1>Run history</h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: 14 }}>
        Every pipeline run — newest first. Click a run to see live logs, assets and the final video.
      </p>

      {loaded && runs.length === 0 && (
        <div className="card">
          <div style={{ fontWeight: 650, marginBottom: 4 }}>No runs yet</div>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Head to <Link href="/">New run</Link>, paste a script, and start the pipeline.
          </p>
        </div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        {runs.map((r) => (
          <Link
            key={r.id}
            href={`/runs/${r.id}`}
            className="card hover-row"
            style={{ textDecoration: "none", padding: "14px 16px", display: "block" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 650,
                    fontSize: 14,
                    color: "var(--fg)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {r.title || r.id.slice(0, 8)}
                </div>
                <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                  {new Date(r.created_at.endsWith("Z") ? r.created_at : r.created_at + "Z").toLocaleString()}
                </div>
              </div>
              <span className={`tag tag-${r.status}`}>{r.status}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

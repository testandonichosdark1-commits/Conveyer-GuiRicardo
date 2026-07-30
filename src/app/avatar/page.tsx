"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface StatsResp {
  activeStack?: {
    animationModel: string;
    animationProvider: string;
    stockRatioPercent: number;
  };
}

export default function AvatarPage() {
  const [title, setTitle] = useState("");
  const [presets, setPresets] = useState<{ id: number; name: string }[]>([]);
  const [presetId, setPresetId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<StatsResp | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/prompt-presets")
      .then((r) => r.json())
      .then((rows: { id: number; name: string }[]) => setPresets(rows))
      .catch(() => setPresets([]));
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const stockPct = stats?.activeStack?.stockRatioPercent ?? 50;
  const videoModel = stats?.activeStack?.animationModel || stats?.activeStack?.animationProvider || "AI";

  async function start() {
    if (!file) return;
    setBusy(true);
    try {
      // Send the MP4 as the RAW body so the browser streams it and the server
      // writes it straight to disk — no size cap, no buffering a multi-GB file.
      const qs = new URLSearchParams();
      if (title.trim()) qs.set("title", title.trim());
      if (presetId != null) qs.set("presetId", String(presetId));
      const r = await fetch(`/api/avatar?${qs.toString()}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "video/mp4" },
        body: file,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(`Couldn't start avatar run:\n\n${j.error || r.statusText}`);
        return;
      }
      router.push(`/runs/${j.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Avatar video</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: 14, lineHeight: 1.6 }}>
        Upload a finished talking-head video (e.g. a HeyGen avatar). The app
        transcribes it and cuts matched visuals to what the avatar is saying —
        some parts stay full-screen on the avatar, others split the screen with
        B-roll, others go full-screen B-roll. The avatar&apos;s own voice is kept
        throughout.
      </p>

      <div
        style={{
          marginBottom: 16,
          padding: "10px 14px",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-sm)",
          fontSize: 12.5,
          color: "var(--fg-muted)",
          lineHeight: 1.55,
        }}
      >
        Visuals are{" "}
        <strong style={{ color: "var(--accent-hover)" }}>{stockPct}% Pexels stock</strong> /{" "}
        <strong style={{ color: "var(--accent-hover)" }}>{100 - stockPct}% AI</strong> ({videoModel}).
        Change the split (STOCK_RATIO_PERCENT) and Pexels key in{" "}
        <a href="/settings">Keys &amp; Settings → Visual Source</a>.
      </div>

      <div className="card" style={{ display: "grid", gap: 16 }}>
        <div>
          <label className="label">Title (optional)</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Amish drill-bit secret — avatar cut"
          />
        </div>

        <div>
          <label className="label">Channel (optional)</label>
          <select
            className="input"
            value={presetId ?? ""}
            onChange={(e) => setPresetId(e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">Default — no channel profile</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
            Sets the visual style for B-roll generation. Manage in Channels &amp; Prompts.
          </div>
        </div>

        <div>
          <label className="label">Avatar video (MP4)</label>
          <div
            onClick={() => fileRef.current?.click()}
            style={{
              border: `1.5px dashed ${file ? "var(--accent)" : "var(--border-strong)"}`,
              borderRadius: "var(--r-sm)",
              padding: "22px 16px",
              textAlign: "center",
              cursor: "pointer",
              background: "var(--surface)",
              transition: "border-color 0.13s",
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept="video/mp4,video/*"
              style={{ display: "none" }}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: "var(--fg)" }}>{file.name}</div>
                <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
                  {(file.size / (1024 * 1024)).toFixed(1)} MB · click to choose a different file
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: "var(--fg-muted)" }}>
                  Click to choose your avatar MP4
                </div>
                <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
                  A 16:9 talking-head video works best · any length (streams to disk)
                </div>
              </div>
            )}
          </div>
        </div>

        <div>
          <button className="btn" onClick={start} disabled={busy || !file}>
            {busy ? "Uploading…" : "Build avatar video"}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginBottom: 8 }}>What happens next</h2>
        <ol style={{ paddingLeft: 20, lineHeight: 1.75, margin: 0, color: "var(--fg-muted)", fontSize: 13.5 }}>
          <li>Whisper transcribes your avatar video into timestamped segments.</li>
          <li>The AI decides, per segment, what to show: avatar full-screen, split, or full B-roll.</li>
          <li>Each visual beat pulls a clip — AI-generated or Pexels stock — matched to the words.</li>
          <li>FFmpeg composites it all over the avatar&apos;s own audio into the final MP4.</li>
        </ol>
        <p className="faint" style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
          Live logs stream into the run page in real time.
        </p>
      </div>
    </div>
  );
}

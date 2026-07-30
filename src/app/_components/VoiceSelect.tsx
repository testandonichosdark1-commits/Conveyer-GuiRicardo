"use client";
import { useRef, useState } from "react";

export interface VoiceLite {
  id: string;
  name: string;
  default_engine: string | null;
  preset_engine: string | null;
}

/**
 * Voicebox voice-profile dropdown, with an inline preview button (▶) so the
 * operator can listen before choosing. The parent owns the profiles list +
 * selected value (fetched from /api/voices/voicebox).
 */
export function VoiceSelect({
  voices,
  value,
  onChange,
}: {
  voices: VoiceLite[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState(false);

  async function preview(id: string) {
    if (!id || previewing) return;
    setPreviewing(true);
    try {
      const r = await fetch(`/api/voices/voicebox/${id}/preview`, { method: "POST" });
      if (!r.ok) return;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.play().catch(() => {});
      }
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <select
        className="input"
        style={{ flex: 1 }}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      >
        <option value="">Default voice</option>
        {voices.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name} ({v.default_engine || v.preset_engine || "?"})
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ fontSize: 12, padding: "6px 10px", whiteSpace: "nowrap" }}
        disabled={!value || previewing}
        onClick={() => value && preview(value)}
      >
        {previewing ? "…" : "▶ Preview"}
      </button>
      <audio ref={audioRef} style={{ display: "none" }} />
    </div>
  );
}

"use client";

import { useState } from "react";
import { useT } from "@/app/_i18n";

/**
 * Every provider credential a channel may override, grouped for display. Duplicated here
 * rather than imported from `@/lib/settings` on purpose: that module pulls in `./db`
 * (better-sqlite3, a native Node module) and must never be imported from client code —
 * `app/full-settings/_groups.ts` keeps its own key list for the exact same reason. The
 * SOURCE OF TRUTH for which keys are actually allowed is `isSecretKey()` on the server
 * (channels.ts filterToSecretKeys), enforced independently of this list — this is a
 * display convenience, not a security boundary. Google Drive's own OAuth pair
 * (GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN) is deliberately left off: that's the
 * operator's own Drive connection, not a per-project generation credential.
 */
const GROUPS: { title: string; keys: string[] }[] = [
  { title: "Core", keys: ["GOOGLE_API_KEY", "HEYGEN_API_KEY", "ELEVENLABS_API_KEY", "GROQ_API_KEY", "KIE_API_KEY"] },
  { title: "Voice (resellers)", keys: ["AI33_API_KEY", "AI84_API_KEY", "GENAIPRO_API_KEY", "FISHAUDIO_API_KEY", "HUME_API_KEY", "MINIMAX_API_KEY"] },
  { title: "AI b-roll", keys: ["LABS69_API_KEY", "MAGNIFIC_API_KEY", "RUNWARE_API_KEY", "HIGGSFIELD_API_KEY", "HIGGSFIELD_API_SECRET"] },
  { title: "Real footage", keys: ["PEXELS_API_KEY", "PIXABAY_API_KEY", "OPENVERSE_TOKEN", "STORYBLOCKS_API_KEYS", "WIGOLO_API_TOKEN", "GOOGLE_CSE_KEY"] },
  { title: "Image (alternates)", keys: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_2", "CLOUDFLARE_API_TOKEN_3", "CLOUDFLARE_API_TOKEN_4", "POLLINATIONS_API_KEY", "META_API_KEY"] },
  { title: "Other", keys: ["REPLICATE_API_TOKEN", "FAL_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] },
];

/** Human label from a SETTING_KEY, e.g. "HEYGEN_API_KEY" -> "HeyGen API Key". Good enough
 *  for a dense checklist; exact provider names ("HeyGen", "kie.ai") aren't worth a second
 *  lookup table here. */
function labelFor(key: string): string {
  return key
    .split("_")
    .map((w) => (w.length <= 4 && w === w.toUpperCase() ? w : w[0] + w.slice(1).toLowerCase()))
    .join(" ");
}

export function ChannelApiKeysField({
  value,
  onChange,
}: {
  /** Masked map from the server (toClientChannel's `api_keys`) merged with any edits made
   *  this session — "…" substrings mean "untouched, keep the real stored value". */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const activeCount = Object.values(value).filter((v) => v.trim()).length;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ width: "100%", justifyContent: "space-between", display: "flex", padding: 0 }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="label" style={{ margin: 0 }}>
          {tr("Clés API de cette chaîne (optionnel)", "This channel's API keys (optional)")}
          {activeCount > 0 && <span className="faint"> — {activeCount} {tr("remplacée(s)", "overridden")}</span>}
        </span>
        <span className="faint">{open ? "▲" : "▼"}</span>
      </button>
      <div className="faint" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
        {tr(
          "Laissez vide pour utiliser la clé globale (Paramètres). Remplissez une clé ici pour que TOUTES les vidéos de cette chaîne l'utilisent à la place — utile quand ce projet appartient à un client avec ses propres comptes.",
          "Leave blank to use the global key (Settings). Fill one in here and EVERY video on this channel uses it instead — useful when this project belongs to a client with their own accounts."
        )}
      </div>

      {open && (
        <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="faint" style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>
                {g.title}
              </div>
              <div className="grid-2" style={{ gap: 10 }}>
                {g.keys.map((key) => (
                  <div key={key}>
                    <label className="label" style={{ fontSize: 12 }}>{labelFor(key)}</label>
                    <input
                      className="input"
                      value={value[key] ?? ""}
                      onChange={(e) => onChange({ ...value, [key]: e.target.value })}
                      placeholder={tr("vide = clé globale", "empty = global key")}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

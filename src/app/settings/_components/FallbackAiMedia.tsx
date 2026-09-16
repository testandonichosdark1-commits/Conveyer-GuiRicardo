"use client";
import { useT } from "../../_i18n";
import type { Val, Set } from "./useSettings";

/**
 * AI FALLBACK MEDIA — what the real-footage fallback may generate when no real clip is
 * found. Surfaced on the MAIN settings page (not just Advanced) because its whole reason
 * to exist is cost protection: AI video is far pricier than AI images, and this is where a
 * surprise bill comes from. Writes the same global FALLBACK_AI_MEDIA the pipeline reads;
 * the Advanced page exposes the identical key.
 *
 * Radio cards (not a <select>) mirror the per-run "Fallback behavior" control on the New
 * Video page, so the two fallback controls read as one family.
 */
const OPTIONS = [
  { v: "image", icon: "💵", fr: "Images uniquement", en: "Images only", frHint: "Le moins cher — jamais de vidéo IA", enHint: "Cheapest — never AI video" },
  { v: "video", icon: "🎥", fr: "Vidéos uniquement", en: "Videos only", frHint: "Qualité maximale — le plus cher", enHint: "Highest quality — most expensive" },
  { v: "both", icon: "⭐", fr: "Images + Vidéos", en: "Images + Videos", frHint: "L'ancien comportement", enHint: "The previous behaviour" },
] as const;

export function FallbackAiMedia({ val, set }: { val: Val; set: Set }) {
  const tr = useT();
  const raw = (val("FALLBACK_AI_MEDIA") || "image").toLowerCase();
  const current = raw === "video" ? "video" : raw === "both" ? "both" : "image";

  return (
    <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
      <div className="faint" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {tr("Média de repli IA", "AI Fallback Media")}
      </div>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: -2 }}>
        {tr(
          "Quand aucun footage réel n'est trouvé et que le repli IA s'active, voici ce qu'il peut générer. La vidéo IA coûte bien plus cher que les images — laissez « Images uniquement » pour éviter les coûts surprises.",
          "When no real footage is found and AI fallback kicks in, this is what it may generate. AI video costs far more than images — leave it on “Images only” to avoid surprise costs."
        )}
      </div>
      <div style={{ display: "grid", gap: 8, marginTop: 2 }}>
        {OPTIONS.map((o) => {
          const picked = current === o.v;
          return (
            <label
              key={o.v}
              style={{
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                border: `1.5px solid ${picked ? "var(--accent)" : "var(--border)"}`,
                borderRadius: "var(--r-sm)", padding: "10px 12px",
                background: picked ? "var(--surface)" : "transparent",
              }}
            >
              <input type="radio" name="FALLBACK_AI_MEDIA" value={o.v} checked={picked} onChange={() => set("FALLBACK_AI_MEDIA", o.v)} style={{ marginTop: 2 }} />
              <span>
                <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>
                  {o.icon} {tr(o.fr, o.en)}
                </span>
                <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 2, lineHeight: 1.4 }}>
                  {tr(o.frHint, o.enHint)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

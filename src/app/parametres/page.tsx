"use client";
import Link from "next/link";
import { useT } from "../_i18n";
import { AI_PROVIDERS, VOICE_PROVIDERS } from "@/lib/providers";
import { useSettings } from "./_components/useSettings";
import { SettingsField } from "./_components/SettingsField";
import { KeyListField } from "./_components/KeyListField";
import { ProviderAiFields } from "./_components/ProviderAiFields";
import { MagnificBlock } from "./_components/MagnificBlock";
import { ProviderVoiceFields } from "./_components/ProviderVoiceFields";
import { FootageSources } from "./_components/FootageSources";
import { AdvancedSection } from "./_components/AdvancedSection";

export default function ParametresPage() {
  const tr = useT();
  const { val, set, save, saving, savedAt, dirtyCount } = useSettings();

  const aiProvider = val("AI_PROVIDER") || "kie";
  const voiceProvider = val("VOICEOVER_PROVIDER") || "elevenlabs";

  async function onSave() {
    const r = await save();
    if (!r.ok) alert(`${tr("Erreur", "Error")} : ${r.error}`);
  }

  return (
    <div>
      <h1>{tr("Paramètres", "Settings")}</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: 14 }}>
        {tr(
          "L'essentiel est visible ici. Stockées localement (SQLite), réutilisées automatiquement. Les clés masquées (•••) restent inchangées si vous n'y touchez pas.",
          "The essentials are shown here. Stored locally (SQLite), reused automatically. Masked keys (•••) stay unchanged if you don't touch them."
        )}
      </p>

      <div className="card" style={{ display: "grid", gap: 16 }}>
        {/* Provider choices */}
        <div className="grid-2" style={{ gap: 16 }}>
          <div>
            <label className="label">{tr("Fournisseur IA (images / vidéo)", "AI provider (images / video)")}</label>
            <select className="input" value={aiProvider} onChange={(e) => set("AI_PROVIDER", e.target.value)}>
              {AI_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.selectLabel}</option>)}
            </select>
          </div>
          <div>
            <label className="label">{tr("Fournisseur de voix", "Voice provider")}</label>
            <select className="input" value={voiceProvider} onChange={(e) => set("VOICEOVER_PROVIDER", e.target.value)}>
              {VOICE_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.selectLabel}</option>)}
            </select>
          </div>
        </div>

        {/* Dynamic provider keys — only the selected providers' fields */}
        <ProviderAiFields provider={aiProvider} val={val} set={set} />

        {/* Magnific settings — shown only when Magnific is the selected AI provider,
            like every other provider. Values (MAGNIFIC_*) stay stored regardless, so
            switching back restores them; the runtime fallback behavior is unchanged. */}
        {aiProvider === "magnific" && <MagnificBlock val={val} set={set} />}

        <ProviderVoiceFields provider={voiceProvider} val={val} set={set} />

        {/* Avatar (HeyGen) — face engine; the API key is always needed for the avatar. The
            HeyGen voice_id lives in the voice-provider section above, shown only when the
            voice provider IS HeyGen (otherwise it's dormant, so we don't show it here). */}
        <div style={{ display: "grid", gap: 16, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <div className="faint" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {tr("Avatar (HeyGen)", "Avatar (HeyGen)")}
          </div>
          <SettingsField label={tr("HeyGen — clé API", "HeyGen — API key")} settingKey="HEYGEN_API_KEY" val={val} set={set} />
        </div>

        {/* Essential global keys */}
        <div className="grid-2" style={{ gap: 16 }}>
          <KeyListField
            label={tr("Pexels — clés API", "Pexels — API keys")}
            settingKey="PEXELS_API_KEY"
            val={val}
            set={set}
            placeholder={tr("Clé Pexels (ex. 563492ad…)", "Pexels key (e.g. 563492ad…)")}
            addLabel={tr("+ Ajouter une clé", "+ Add another key")}
            help={tr(
              "Ajoutez plusieurs clés pour augmenter la limite — l'app alterne automatiquement entre les clés et attend la fin des limites de débit.",
              "Add several keys to raise the rate-limit ceiling — the app rotates between them automatically and waits out rate limits."
            )}
          />
          <SettingsField label={tr("Google Gemini — clé API (requêtes visuelles)", "Google Gemini — API key (visual queries)")} settingKey="GOOGLE_API_KEY" val={val} set={set} />
        </div>

        <AdvancedSection title={tr("Avancé (optionnel)", "Advanced (optional)")}>
          <div>
            <label className="label">{tr("Média IA", "AI media")}</label>
            <select className="input" value={val("KIE_AI_MEDIA") || "image"} onChange={(e) => set("KIE_AI_MEDIA", e.target.value)}>
              <option value="image">{tr("Images seulement (photos + zoom)", "Images only (photos + zoom)")}</option>
              <option value="auto">{tr("Auto (photos et vidéo)", "Auto (photos + video)")}</option>
              <option value="video">{tr("Vidéo seulement (+ réaliste, + cher)", "Video only (more realistic, pricier)")}</option>
            </select>
            <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>
              {tr(
                "S'applique au fournisseur IA choisi (kie.ai, 69labs ou Magnific). Par défaut : images seulement (le moins cher). Auto = mélange photos + vidéo selon le plan. Vidéo = tout en vidéo (le plus cher).",
                "Applies to the chosen AI provider (kie.ai, 69labs or Magnific). Default: images only (cheapest). Auto = mix of photos + video per shot. Video = all video (priciest)."
              )}
            </div>
          </div>
          <SettingsField label={tr("Secondes par visuel (durée d'un plan par défaut)", "Seconds per visual (default beat length)")} settingKey="SECONDS_PER_VISUAL" val={val} set={set} placeholder="4.5" />
          <SettingsField label={tr("Style images IA par défaut", "Default AI image style")} settingKey="AI_IMAGE_STYLE" val={val} set={set} />
          <SettingsField label={tr("Pixabay — clé API (optionnel)", "Pixabay — API key (optional)")} settingKey="PIXABAY_API_KEY" val={val} set={set} />

          <FootageSources val={val} set={set} />

          <div className="faint" style={{ fontSize: 12 }}>
            {tr("Autres options avancées :", "Other advanced options:")}{" "}
            <Link href="/settings">{tr("réglages complets →", "full settings →")}</Link>
          </div>
        </AdvancedSection>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn" onClick={onSave} disabled={saving || dirtyCount === 0}>
            {saving ? tr("Enregistrement…", "Saving…") : tr("Enregistrer", "Save")}
          </button>
          {savedAt && <span className="faint" style={{ fontSize: 12.5 }}>{tr("Enregistré à", "Saved at")} {savedAt}</span>}
        </div>
      </div>
    </div>
  );
}

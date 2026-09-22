"use client";
import Link from "next/link";
import { useT } from "../_i18n";
import { AI_PROVIDERS, VOICE_PROVIDERS } from "@/lib/providers";
import { useSettings } from "./_components/useSettings";
import { SettingsField } from "./_components/SettingsField";
import { KeyListField } from "./_components/KeyListField";
import { KeyPairListField } from "./_components/KeyPairListField";
import { ProviderAiFields } from "./_components/ProviderAiFields";
import { ProviderModelFields } from "./_components/ProviderModelFields";
import { MagnificBlock } from "./_components/MagnificBlock";
import { HiggsfieldBlock } from "./_components/HiggsfieldBlock";
import { ProviderVoiceFields } from "./_components/ProviderVoiceFields";
import { FootageSources } from "./_components/FootageSources";
import { FallbackAiMedia } from "./_components/FallbackAiMedia";
import { AdvancedSection } from "./_components/AdvancedSection";
import { FlowBrowserBlock } from "./_components/FlowBrowserBlock";

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
            {/* ai33.pro is deliberately absent here — it's channel-only now (Channels page:
                each channel pins its own ai33 key + voice_id). Settings stays the app-wide
                default for every OTHER provider; ai33 has no global default to configure. */}
            <select className="input" value={voiceProvider} onChange={(e) => set("VOICEOVER_PROVIDER", e.target.value)}>
              {VOICE_PROVIDERS.filter((p) => p.id !== "ai33").map((p) => <option key={p.id} value={p.id}>{p.selectLabel}</option>)}
            </select>
          </div>
        </div>

        {/* Generation model(s) for the selected AI provider — Image/Video, capability-driven,
            populated from the provider registry with a recommended default + Custom… escape. */}
        <ProviderModelFields provider={aiProvider} val={val} set={set} />

        {/* Dynamic provider keys — only the selected providers' fields */}
        <ProviderAiFields provider={aiProvider} val={val} set={set} />

        {aiProvider === "flow_browser" && <FlowBrowserBlock val={val} set={set} />}

        {aiProvider === "kie" && (
          <div style={{ display: "grid", gap: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>
                {tr("Cloudflare Workers AI — premier essai + secours opérationnel", "Cloudflare Workers AI — first pass + operational failover")}
              </div>
              <div className="faint" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.5 }}>
                {tr(
                  "Le profil principal (Account ID + Token) est désormais configuré par chaîne — page Chaînes. Les profils de secours ci-dessous restent globaux : ils prennent le relais si le profil actif (celui de la chaîne, ou l'ancien réglage global s'il existe encore) a un problème d'identifiants, de configuration ou une indisponibilité transitoire. Une allocation quotidienne épuisée (3036/4006) ne déclenche pas la rotation : le pipeline passe à kie.ai.",
                  "The Primary profile (Account ID + Token) is now configured per channel — see the Channels page. The backup profiles below stay global: they take over if the active profile (the channel's, or a legacy global one if still set) has a credential/configuration problem or a transient outage. Daily allocation exhaustion (3036/4006) does not rotate accounts: the pipeline falls back to kie.ai."
                )}
              </div>
            </div>

            {[2, 3, 4].map((slot, idx) => (
              <div key={slot} style={{ display: "grid", gap: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 12.5 }}>
                  {tr(`Profil de secours ${idx + 1}`, `Backup profile ${idx + 1}`)}
                </div>
                <div className="grid-2" style={{ gap: 12 }}>
                  <SettingsField
                    label={tr("Cloudflare — Account ID", "Cloudflare — Account ID")}
                    settingKey={`CLOUDFLARE_ACCOUNT_ID_${slot}`}
                    val={val}
                    set={set}
                    placeholder="optional"
                  />
                  <SettingsField
                    label={tr("Cloudflare — API Token", "Cloudflare — API Token")}
                    settingKey={`CLOUDFLARE_API_TOKEN_${slot}`}
                    val={val}
                    set={set}
                    placeholder="optional"
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {aiProvider === "kie" && (
          <div style={{ display: "grid", gap: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>
                {tr("Chaîne de secours images — Pollinations → Meta Muse → kie.ai", "Image fallback chain — Pollinations → Meta Muse → kie.ai")}
              </div>
              <div className="faint" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.5 }}>
                {tr(
                  "Après Cloudflare, Pollinations Z-Image est essayé une fois. Si l'image échoue ou n'atteint pas le score Gemini, Meta Muse est essayé une fois, puis kie.ai reste le dernier recours. Les scènes avec référence de personnage restent directement sur Nano Banana Edit.",
                  "After Cloudflare, Pollinations Z-Image is tried once. If it fails or misses the Gemini score, Meta Muse is tried once, then kie.ai remains the final fallback. Character-reference scenes still go directly to Nano Banana Edit."
                )}
              </div>
            </div>

            <div style={{ display: "grid", gap: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>Pollinations</div>
              <div className="grid-2" style={{ gap: 12 }}>
                <SettingsField
                  label={tr("Pollinations — clé API", "Pollinations — API key")}
                  settingKey="POLLINATIONS_API_KEY"
                  val={val}
                  set={set}
                  placeholder="sk_…"
                />
                <SettingsField
                  label={tr("Pollinations — modèle", "Pollinations — model")}
                  settingKey="POLLINATIONS_IMAGE_MODEL"
                  val={val}
                  set={set}
                  placeholder="zimage"
                />
              </div>
            </div>

            <div style={{ display: "grid", gap: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>Meta Muse Image</div>
              <div className="grid-2" style={{ gap: 12 }}>
                <SettingsField
                  label={tr("Meta — clé API", "Meta — API key")}
                  settingKey="META_API_KEY"
                  val={val}
                  set={set}
                  placeholder="Meta Model API key"
                />
                <SettingsField
                  label={tr("Meta — modèle", "Meta — model")}
                  settingKey="META_IMAGE_MODEL"
                  val={val}
                  set={set}
                  placeholder="muse-image-1.0"
                />
              </div>
              <SettingsField
                label={tr("Meta — URL de base", "Meta — Base URL")}
                settingKey="META_API_BASE_URL"
                val={val}
                set={set}
                placeholder="https://api.meta.ai/v1"
              />
            </div>
          </div>
        )}

        {/* Magnific settings — shown only when Magnific is the selected AI provider,
            like every other provider. Values (MAGNIFIC_*) stay stored regardless, so
            switching back restores them; the runtime fallback behavior is unchanged. */}
        {aiProvider === "magnific" && <MagnificBlock val={val} set={set} />}

        {/* Higgsfield settings — shown only when Higgsfield is the selected AI provider,
            like Magnific. Two-part key (id + secret) + enable/fallback; the model selects
            are rendered by ProviderModelFields above from the registry. */}
        {aiProvider === "higgsfield" && <HiggsfieldBlock val={val} set={set} />}

        <ProviderVoiceFields provider={voiceProvider} val={val} set={set} />

        {/* Groq — word timing. DECOUPLED from the voice provider on purpose. Upload Voiceover
            ALWAYS transcribes the uploaded narration with Groq Whisper to sync the visuals,
            whatever TTS provider is selected — so this key must always be reachable, not hidden
            behind an ElevenLabs selection (the bug this section fixes). When the TTS voice is
            non-ElevenLabs it ALSO improves synthesized-narration timing (the original reason the
            field existed) — surfaced as an extra nudge, unchanged in meaning. */}
        <div style={{ display: "grid", gap: 6 }}>
          <SettingsField
            label={tr("Groq — clé API (timing des mots)", "Groq — API key (word timing)")}
            settingKey="GROQ_API_KEY"
            val={val}
            set={set}
            required
          />
          <div className="faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
            {tr(
              "Requis pour « Importer une voix » : nous transcrivons votre narration avec Groq Whisper pour synchroniser les visuels, quel que soit le fournisseur de voix.",
              "Required for “Upload voiceover”: we transcribe your narration with Groq Whisper to synchronize the visuals, whatever the voice provider."
            )}
          </div>
          {voiceProvider !== "elevenlabs" && !val("GROQ_API_KEY").trim() && (
            <div className="faint" style={{ fontSize: 12, color: "var(--warning)" }}>
              {tr(
                "Sans clé API Groq, la narration non-ElevenLabs utilise un minutage des mots approximatif.",
                "Without a Groq API Key, non-ElevenLabs narration uses approximate word timings."
              )}
            </div>
          )}
        </div>

        {/* Global voiceover speed — compact; a channel can override it per-channel (Chaînes). */}
        <div style={{ maxWidth: 280 }}>
          <label className="label">{tr("Vitesse de la voix", "Voiceover speed")}</label>
          <input
            className="input"
            type="number"
            step="0.01"
            min="0.7"
            max="1.2"
            value={val("TTS_SPEED")}
            onChange={(e) => set("TTS_SPEED", e.target.value)}
            placeholder="0.93"
          />
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {tr("0.7 lent – 1.2 rapide. Une chaîne peut la surcharger.", "0.7 slow – 1.2 fast. A channel can override this.")}
          </p>
        </div>

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
          <KeyPairListField
            label={tr("Storyblocks — clés API", "Storyblocks — API keys")}
            settingKey="STORYBLOCKS_API_KEYS"
            val={val}
            set={set}
            labelA={tr("Clé publique", "Public Key")}
            labelB={tr("Clé privée", "Private Key")}
            placeholderA={tr("Clé publique", "Public Key")}
            placeholderB={tr("Clé privée", "Private Key")}
            addLabel={tr("+ Ajouter une paire", "+ Add another key")}
            help={tr(
              "Clés sur developer.storyblocks.com. Accès payant recommandé ; sinon, ajoutez plusieurs paires.",
              "Get keys at developer.storyblocks.com. Paid access recommended; otherwise add several pairs."
            )}
          />
          {/* Gemini key + its inline warning wrapped in one grid cell so the warning stays
              attached to this field (not wrapped under the Pexels column). */}
          <div>
            <SettingsField label={tr("Google Gemini — clé API (requêtes visuelles)", "Google Gemini — API key (visual queries)")} settingKey="GOOGLE_API_KEY" val={val} set={set} />
            <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.45, fontWeight: 600, color: "var(--warning)" }}>
              ⚠ {tr("La facturation doit être activée pour cette clé API Gemini.", "Billing must be enabled for this Gemini API key.")}
            </div>
          </div>
        </div>

        {/* AI Fallback Media — visible on the MAIN page (not buried in Advanced) because it
            is a cost-protection control; the identical FALLBACK_AI_MEDIA key is also in full
            settings. Placed here, right after the footage API keys, since it governs what
            happens when those real-footage sources return nothing. */}
        <FallbackAiMedia val={val} set={set} />

        <AdvancedSection title={tr("Avancé (optionnel)", "Advanced (optional)")}>
          {/* AI media (KIE_AI_MEDIA) moved to the Run page, shown contextually per visual mode. */}
          {/* AI_IMAGE_STYLE and the character reference image moved to per-channel config
              (Channels page: Default AI image style / Character reference image) — Settings
              stays the app-wide default and no longer exposes a global form field for either. */}
          <SettingsField label={tr("Secondes par visuel (durée d'un plan par défaut)", "Seconds per visual (default beat length)")} settingKey="SECONDS_PER_VISUAL" val={val} set={set} placeholder="4.5" />
          <SettingsField label={tr("Pixabay — clé API (optionnel)", "Pixabay — API key (optional)")} settingKey="PIXABAY_API_KEY" val={val} set={set} />
          {/* Web (Google) footage source — its two keys live here, next to the other footage keys
              and right above the source checkboxes that enable it. Leave empty to disable web search. */}
          <SettingsField label={tr("Google — clé recherche d'images web (CSE)", "Google — web image search key (CSE)")} settingKey="GOOGLE_CSE_KEY" val={val} set={set} placeholder="AIza…" />
          <SettingsField label={tr("Google — ID du moteur de recherche (cx)", "Google — search engine ID (cx)")} settingKey="GOOGLE_CSE_CX" val={val} set={set} placeholder="a1b2c3d4e5f6g7h8i" />

          <FootageSources val={val} set={set} />

          <div className="faint" style={{ fontSize: 12 }}>
            {tr("Autres options avancées :", "Other advanced options:")}{" "}
            <Link href="/full-settings">{tr("réglages complets →", "full settings →")}</Link>
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

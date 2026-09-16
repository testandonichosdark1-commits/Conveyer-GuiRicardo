"use client";
import { useState } from "react";
import { aiProviderMeta, aiMediaCatalog, defaultAiModel, isSupportedAiModel, type AiMedia } from "@/lib/providers";
import { useT } from "../../_i18n";
import type { Val, Set } from "./useSettings";

/** Sentinel <option> value that reveals the free-text "Custom…" input. */
const CUSTOM = "__custom__";

/**
 * One "Image model" / "Video model" dropdown for the selected AI provider, driven
 * entirely by the provider registry (src/lib/providers.ts). Shows the provider's
 * supported models (friendly label; "(Recommended)" composed from the `recommended`
 * flag, not stored in the label) plus a "Custom…" escape that reveals a free-text
 * box for a model id the registry doesn't list yet. The chosen model persists to the
 * provider's own setting key (e.g. KIE_IMAGE_MODEL), so each provider keeps its own
 * last choice — switching provider away and back restores it with no extra writes.
 *
 * Keyed by provider in the parent, so the local custom-mode state resets on switch.
 */
function ModelSelect({
  providerId,
  media,
  label,
  val,
  set,
}: {
  providerId: string;
  media: AiMedia;
  label: string;
  val: Val;
  set: Set;
}) {
  const tr = useT();
  const catalog = aiMediaCatalog(providerId, media);
  const stored = val(catalog!.key);
  // Display fallback only (no write): a blank/unseeded key shows the recommended model.
  const shown = stored || defaultAiModel(providerId, media);
  const known = isSupportedAiModel(providerId, media, shown);
  // A non-empty value that isn't in the catalog is a saved custom id → start in custom mode.
  const [custom, setCustom] = useState(!known && stored !== "");

  if (!catalog) return null;
  const inCustom = custom || (!known && stored !== "");
  const selectValue = inCustom ? CUSTOM : shown;

  return (
    <div>
      <label className="label">{label}</label>
      <select
        className="input"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM) {
            setCustom(true);
            // Seed the free-text box with the current known id so it's editable, not blank.
            if (known && stored !== shown) set(catalog.key, shown);
          } else {
            setCustom(false);
            set(catalog.key, v);
          }
        }}
      >
        {catalog.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.recommended ? `${m.label} ${tr("(Recommandé)", "(Recommended)")}` : m.label}
          </option>
        ))}
        <option value={CUSTOM}>{tr("Personnalisé…", "Custom…")}</option>
      </select>
      {inCustom && (
        <input
          className="input"
          style={{ marginTop: 6 }}
          value={stored}
          onChange={(e) => set(catalog.key, e.target.value)}
          placeholder={tr("ID exact du modèle (ex. google/nano-banana)", "Exact model id (e.g. google/nano-banana)")}
        />
      )}
    </div>
  );
}

/**
 * Renders the generation-model selector(s) for the selected AI provider — Image
 * and/or Video, capability-driven: a selector appears only when the provider can
 * generate that media (`meta.image` / `meta.video` present). No dead fields.
 */
export function ProviderModelFields({ provider, val, set }: { provider: string; val: Val; set: Set }) {
  const tr = useT();
  const meta = aiProviderMeta(provider);
  if (!meta.image && !meta.video) return null;
  return (
    <div className="grid-2" style={{ gap: 16 }}>
      {meta.image && (
        <ModelSelect key={`${meta.id}-image`} providerId={meta.id} media="image" label={tr("Modèle image", "Image model")} val={val} set={set} />
      )}
      {meta.video && (
        <ModelSelect key={`${meta.id}-video`} providerId={meta.id} media="video" label={tr("Modèle vidéo", "Video model")} val={val} set={set} />
      )}
    </div>
  );
}

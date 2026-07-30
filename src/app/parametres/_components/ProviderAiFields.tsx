"use client";
import { aiProviderMeta } from "@/lib/providers";
import { useT } from "../../_i18n";
import { SettingsField } from "./SettingsField";
import type { Val, Set } from "./useSettings";

/**
 * Renders ONLY the selected AI provider's API key (kie.ai / 69labs). Magnific has
 * its own always-visible block (MagnificBlock) so it can be configured without
 * being the chosen provider — so nothing is rendered here for magnific.
 */
export function ProviderAiFields({ provider, val, set }: { provider: string; val: Val; set: Set }) {
  const tr = useT();
  const meta = aiProviderMeta(provider);
  if (meta.id === "magnific") return null; // configured in the persistent Magnific block below

  const label =
    meta.id === "69labs"
      ? tr("69labs — clé API (Grok)", "69labs — API key (Grok)")
      : tr("kie.ai — clé API (nano-banana / Veo)", "kie.ai — API key (nano-banana / Veo)");
  return <SettingsField label={label} settingKey={meta.apiKey} val={val} set={set} />;
}

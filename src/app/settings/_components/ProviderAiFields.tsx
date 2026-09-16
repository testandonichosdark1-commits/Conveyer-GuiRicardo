"use client";
import { aiProviderMeta } from "@/lib/providers";
import { useT } from "../../_i18n";
import { SettingsField } from "./SettingsField";
import type { Val, Set } from "./useSettings";

/**
 * Per-provider API-key label, keyed by provider id. A provider with no entry falls
 * back to its registry `selectLabel` — so a newly registered provider gets a correct
 * (if generic) label instead of silently inheriting kie.ai's, which is what the old
 * two-branch ternary did for anything that wasn't 69labs.
 */
const KEY_LABELS: Record<string, [fr: string, en: string]> = {
  kie: ["kie.ai — clé API (nano-banana / Veo)", "kie.ai — API key (nano-banana / Veo)"],
  "69labs": ["69labs — clé API (Grok)", "69labs — API key (Grok)"],
  runware: ["Runware — clé API", "Runware — API key"],
};

/**
 * Renders ONLY the selected AI provider's API key (kie.ai / 69labs / Runware).
 * Magnific has its own always-visible block (MagnificBlock) so it can be configured
 * without being the chosen provider — so nothing is rendered here for magnific.
 */
export function ProviderAiFields({ provider, val, set }: { provider: string; val: Val; set: Set }) {
  const tr = useT();
  const meta = aiProviderMeta(provider);
  if (meta.id === "magnific") return null; // configured in the persistent Magnific block below
  if (meta.id === "higgsfield") return null; // two-part key (id + secret) lives in HiggsfieldBlock

  const [fr, en] = KEY_LABELS[meta.id] ?? [`${meta.selectLabel} — clé API`, `${meta.selectLabel} — API key`];
  return <SettingsField label={tr(fr, en)} settingKey={meta.apiKey} val={val} set={set} />;
}

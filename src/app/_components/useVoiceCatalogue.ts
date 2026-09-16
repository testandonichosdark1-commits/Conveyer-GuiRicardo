"use client";
import { useCallback, useEffect, useState } from "react";
import { voiceProviderMeta } from "@/lib/providers";
import type { VoiceOption } from "./VoiceSelect";

/**
 * The current voice provider's catalogue, for any page that offers a voice picker.
 *
 * Shared by the create page and the channels page so the AI84 rule — ask for BOTH engines,
 * because a picked voice is what decides the engine — lives in exactly one place. A second
 * copy of this fetch is how one page would quietly go on offering half the voices.
 *
 * Providers with no listing (genaipro / 69labs / minimax) have no endpoint at all: nothing is
 * requested and `endpoint` comes back undefined, which is the caller's signal to keep the
 * plain text field.
 *
 * An error is NOT a failure state the caller has to handle by disabling anything — it means
 * "offer free text instead". A voice catalogue is a convenience; it must never be the reason
 * someone can't make a video or save a channel.
 */
export function useVoiceCatalogue(provider: string, enabled = true) {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const endpoint = provider ? voiceProviderMeta(provider).voicesEndpoint : undefined;

  // `useT`'s `tr` must never end up in these deps: it is a new function on every render, so
  // depending on it re-fires the effect, which sets state, which re-renders — a loop that has
  // already hammered a provider API once. Nothing here translates, which keeps that true.
  useEffect(() => {
    if (!endpoint || !enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // AI84 fronts two engines with separate libraries; `all` returns both, each voice tagged
    // with the engine it belongs to.
    const qs = endpoint === "ai84" ? "?backend=all" : "";
    fetch(`/api/voices/${endpoint}${qs}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || r.statusText);
        return j;
      })
      .then((j) => {
        if (cancelled) return;
        setVoices(Array.isArray(j?.voices) ? j.voices : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || "failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, enabled, reloadKey]);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);
  return { endpoint, voices, loading, error, retry };
}

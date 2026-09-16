"use client";
import { useCallback, useEffect, useState } from "react";

export type Settings = Record<string, string>;

/**
 * Shared settings state for the /settings page and its field components.
 * Loads masked settings from /api/settings, tracks dirty edits, and saves.
 * The POST handler skips values still containing the "…" mask, so untouched
 * secret fields are never overwritten — we just send the dirty diff.
 */
export function useSettings() {
  const [s, setS] = useState<Settings>({});
  const [dirty, setDirty] = useState<Settings>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/settings");
      if (!r.ok) return;
      const j = await r.json();
      if (j && typeof j === "object" && !Array.isArray(j) && !("error" in j)) setS(j as Settings);
    } catch {
      /* keep current values */
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const val = useCallback((k: string) => (k in dirty ? dirty[k] : s[k] ?? ""), [dirty, s]);
  const set = useCallback((k: string, v: string) => setDirty((d) => ({ ...d, [k]: v })), []);

  const save = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    setSaving(true);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dirty),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        return { ok: false, error: j.error || r.statusText };
      }
      setDirty({});
      await load();
      setSavedAt(new Date().toLocaleTimeString());
      return { ok: true };
    } finally {
      setSaving(false);
    }
  }, [dirty, load]);

  return { val, set, save, saving, savedAt, dirtyCount: Object.keys(dirty).length };
}

export type Val = (k: string) => string;
export type Set = (k: string, v: string) => void;

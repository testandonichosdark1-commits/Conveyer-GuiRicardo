"use client";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Drop-in replacement for useState that mirrors the value into localStorage,
 * so a half-filled form (a pasted script, a draft channel prompt) survives
 * navigating to another page and back. The App Router unmounts a page on
 * navigation, which otherwise drops all of its local state.
 *
 * SSR-safe: the first render uses `initial` (matching the server markup);
 * the stored value is restored in an effect right after mount.
 */
export function usePersistedState<T>(
  key: string,
  initial: T
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  // Guards the persist effect: skip its first (mount) pass so the empty
  // `initial` can never overwrite a stored draft before the restore lands.
  const persisted = useRef(false);

  // Restore once, on mount, client-side only.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      // ignore corrupt / unavailable storage
    }
  }, [key]);

  // Mirror every later change into storage.
  useEffect(() => {
    if (!persisted.current) {
      persisted.current = true;
      return;
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore quota / unavailable storage
    }
  }, [key, value]);

  return [value, setValue];
}

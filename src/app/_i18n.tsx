"use client";
import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * Tiny, dependency-free i18n. Strings live inline at the call site as
 * `tr("Texte français", "English text")` — no key dictionary to maintain.
 *
 * The app is English-only: the language is locked to "en", so `tr(fr, en)`
 * always returns the English string. (A FR/EN toggle existed previously; it was
 * removed when French was dropped. The `tr(fr, …)` call sites are kept as-is —
 * the French argument is simply never returned.)
 */

export type Lang = "fr" | "en";

const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: "en",
  setLang: () => {},
});

export function LangProvider({ children }: { children: ReactNode }) {
  // Locked to English. No localStorage restore — a previously-saved "fr"
  // preference must not resurface now that the app is English-only.
  const [lang, setLang] = useState<Lang>("en");

  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
}

export function useLang() {
  return useContext(LangCtx);
}

/** Returns a translator: `tr(fr, en)` → the string for the current language. */
export function useT(): (fr: string, en: string) => string {
  const { lang } = useContext(LangCtx);
  return (fr: string, en: string) => (lang === "en" ? en : fr);
}

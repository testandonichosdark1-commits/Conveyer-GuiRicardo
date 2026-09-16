"use client";
import { useEffect, useState } from "react";

type Theme = "dark" | "light";

/**
 * Light/dark theme switch. Persists to localStorage and toggles the
 * `data-theme` attribute on <html>. The initial theme is applied before
 * paint by an inline script in layout.tsx (anti-FOUC) — this component just
 * reflects and changes it.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const current =
      document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    setTheme(current);
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage unavailable — fine, just won't persist
    }
    if (next === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  const isLight = theme === "light";

  return (
    <button
      onClick={toggle}
      title={isLight ? "Switch to dark theme" : "Switch to light theme"}
      aria-label="Toggle theme"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 10px",
        borderRadius: 8,
        background: "transparent",
        border: "1px solid var(--border)",
        color: "var(--fg-muted)",
        fontSize: 12.5,
        fontWeight: 550,
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "background 0.13s, border-color 0.13s",
        // hide label flicker until mounted so SSR (dark) and client agree
        opacity: mounted ? 1 : 0.85,
      }}
    >
      {isLight ? (
        // moon — click to go dark
        <svg
          width={15}
          height={15}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        // sun — click to go light
        <svg
          width={15}
          height={15}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )}
      {isLight ? "Dark theme" : "Light theme"}
    </button>
  );
}

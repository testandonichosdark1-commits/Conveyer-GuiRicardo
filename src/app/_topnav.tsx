"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "./_i18n";

type NavItem = { href: string; fr: string; en: string; exact?: boolean; beta?: boolean };

const NAV: NavItem[] = [
  { href: "/", fr: "Créer une vidéo", en: "Create a video", exact: true },
  { href: "/avatars", fr: "Avatars", en: "Avatars" },
  { href: "/channels", fr: "Chaînes", en: "Channels" },
  { href: "/jobs", fr: "Jobs", en: "Jobs" },
  { href: "/costs", fr: "Coûts", en: "Costs", beta: true },
  { href: "/tools/image-provider-test", fr: "Outils", en: "Tools" },
  { href: "/settings", fr: "Paramètres", en: "Settings" },
];

/** Small "beta" tag next to an in-development nav item (Costs — estimated figures). */
function BetaTag() {
  return (
    <span
      style={{
        marginLeft: 5,
        fontSize: 8.5,
        fontWeight: 700,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        padding: "1px 4px",
        borderRadius: 4,
        background: "var(--warning-soft)",
        color: "var(--warning)",
        verticalAlign: "middle",
      }}
    >
      beta
    </span>
  );
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    padding: "7px 13px",
    borderRadius: 8,
    fontSize: 13.5,
    fontWeight: active ? 650 : 500,
    color: active ? "var(--fg)" : "var(--fg-muted)",
    background: active ? "var(--surface-2)" : "transparent",
    border: `1px solid ${active ? "var(--border-strong)" : "transparent"}`,
    textDecoration: "none",
    transition: "background 0.13s, color 0.13s",
  };
}

export function TopNav() {
  const pathname = usePathname();
  const tr = useT();
  const [open, setOpen] = useState(false);

  const isActive = (item: (typeof NAV)[number]) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  // Close the mobile menu on navigation.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on ESC, on resize up to desktop, and lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const mq = window.matchMedia("(min-width: 1024px)");
    const onDesktop = () => mq.matches && setOpen(false);
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onDesktop);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onDesktop);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "12px 22px",
        background: "var(--bg-deep)",
        borderBottom: "1px solid var(--border)",
        backdropFilter: "blur(6px)",
      }}
    >
      <Link href="/" style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none" }}>
        <span style={{ fontSize: 17 }}>🎬</span>
        <span style={{ fontWeight: 700, fontSize: 15, color: "var(--fg)", letterSpacing: "-0.01em" }}>
          Faceless Video Generator
        </span>
      </Link>

      {/* Desktop pill nav (≥1024px). Hidden below 1024 via .topnav-links. */}
      <nav className="topnav-links">
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} style={pillStyle(isActive(item))}>
            {tr(item.fr, item.en)}
            {item.beta && <BetaTag />}
          </Link>
        ))}
      </nav>

      {/* Hamburger (only visible < 1024px via .topnav-burger). */}
      <button
        type="button"
        className="topnav-burger"
        aria-label={tr("Menu", "Menu")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "✕" : "☰"}
      </button>

      {/* Mobile menu: scrim + dropdown panel flush under the header. */}
      {open && (
        <>
          <div className="topnav-scrim" onClick={() => setOpen(false)} />
          <nav className="topnav-menu">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                style={{ ...pillStyle(isActive(item)), display: "block", padding: "13px 14px", fontSize: 15 }}
              >
                {tr(item.fr, item.en)}
                {item.beta && <BetaTag />}
              </Link>
            ))}
          </nav>
        </>
      )}
    </header>
  );
}

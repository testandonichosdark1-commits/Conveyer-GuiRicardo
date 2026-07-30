"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useT } from "./_i18n";

type NavItem = { href: string; fr: string; en: string; exact?: boolean; beta?: boolean; admin?: boolean };

export type NavUser = { email: string; isAdmin: boolean } | null;

const NAV: NavItem[] = [
  { href: "/", fr: "Créer une vidéo", en: "Create a video", exact: true },
  { href: "/avatars", fr: "Avatars", en: "Avatars" },
  { href: "/chaines", fr: "Chaînes", en: "Channels" },
  { href: "/jobs", fr: "Jobs", en: "Jobs" },
  { href: "/costs", fr: "Coûts", en: "Costs", beta: true },
  { href: "/parametres", fr: "Paramètres", en: "Settings", admin: true },
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

/** Logout button — posts to /auth/signout (server clears the session cookie). */
function LogoutForm({ block }: { block?: boolean }) {
  return (
    <form action="/auth/signout" method="post" style={block ? { display: "block" } : undefined}>
      <button
        type="submit"
        className="btn btn-sm"
        style={block ? { width: "100%", justifyContent: "center" } : undefined}
      >
        Log out
      </button>
    </form>
  );
}

/** Desktop top-right account menu: initial-circle button → dropdown (email + Logout). */
function UserMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initial = (email.trim()[0] || "?").toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label="Account"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          border: "1px solid var(--border-strong)",
          background: "var(--surface-2)",
          color: "var(--fg)",
          fontSize: 14,
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {initial}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 30,
            minWidth: 200,
            padding: 12,
            borderRadius: 10,
            background: "var(--bg-deep)",
            border: "1px solid var(--border)",
            boxShadow: "var(--shadow-lg)",
            display: "grid",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12.5, color: "var(--fg-muted)", wordBreak: "break-all" }}>{email}</div>
          <LogoutForm block />
        </div>
      )}
    </div>
  );
}

export function TopNav({ user }: { user: NavUser }) {
  const pathname = usePathname();
  const tr = useT();
  const [open, setOpen] = useState(false);

  const isActive = (item: NavItem) =>
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

  // The login page has its own centered layout — no app chrome.
  if (pathname === "/login") return null;

  // Admin-only items (Settings) are hidden for non-admins; the middleware also
  // blocks the route itself, so this is purely to keep the nav honest.
  const nav = NAV.filter((item) => !item.admin || user?.isAdmin);

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

      {/* Desktop right group (≥1024px): pill nav + account menu. Hidden below 1024. */}
      <div className="topnav-right">
        <nav className="topnav-links">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} style={pillStyle(isActive(item))}>
              {tr(item.fr, item.en)}
              {item.beta && <BetaTag />}
            </Link>
          ))}
        </nav>
        {user?.email && <UserMenu email={user.email} />}
      </div>

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
            {nav.map((item) => (
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
            {user?.email && (
              <div style={{ borderTop: "1px solid var(--border)", marginTop: 6, paddingTop: 10, display: "grid", gap: 8 }}>
                <div style={{ fontSize: 12.5, color: "var(--fg-muted)", padding: "0 4px", wordBreak: "break-all" }}>
                  {user.email}
                </div>
                <LogoutForm block />
              </div>
            )}
          </nav>
        </>
      )}
    </header>
  );
}

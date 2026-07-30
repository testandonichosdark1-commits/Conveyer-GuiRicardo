"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ThemeToggle } from "./_theme-toggle";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  exact?: boolean;
}

interface NavGroup {
  header: string | null;
  items: NavItem[];
}

const iconProps = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const NAV: NavGroup[] = [
  {
    header: null,
    items: [
      {
        href: "/",
        label: "New video",
        exact: true,
        icon: (
          <svg {...iconProps}>
            <path d="M5 12h14M12 5v14" />
          </svg>
        ),
      },
      {
        href: "/avatars",
        label: "Avatar library",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21v-1a7 7 0 0 1 14 0v1" />
          </svg>
        ),
      },
    ],
  },
  {
    header: "Work",
    items: [
      {
        href: "/runs",
        label: "Run history",
        icon: (
          <svg {...iconProps}>
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5M12 7v5l4 2" />
          </svg>
        ),
      },
      {
        href: "/library",
        label: "Library",
        icon: (
          <svg {...iconProps}>
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        ),
      },
    ],
  },
  {
    header: "Setup",
    items: [
      {
        href: "/prompts",
        label: "Channels & Prompts",
        icon: (
          <svg {...iconProps}>
            <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        ),
      },
      {
        href: "/settings",
        label: "Keys & Settings",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        ),
      },
      {
        href: "/advanced",
        label: "Advanced",
        icon: (
          <svg {...iconProps}>
            <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
          </svg>
        ),
      },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      style={{
        width: 244,
        flexShrink: 0,
        height: "100vh",
        position: "sticky",
        top: 0,
        background: "var(--bg-deep)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        padding: "20px 14px",
      }}
    >
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px 22px" }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "linear-gradient(135deg, var(--accent), #ff8a72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 800,
            fontSize: 15,
            color: "#fff",
            boxShadow: "var(--shadow-sm)",
            flexShrink: 0,
          }}
        >
          C
        </div>
        <div style={{ lineHeight: 1.15 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, letterSpacing: "-0.02em" }}>
            Faceless Video Generator
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>Avatar video studio</div>
        </div>
      </div>

      {/* Nav groups */}
      <nav style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {NAV.map((group, gi) => (
          <div key={gi} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {group.header && (
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: "0.09em",
                  textTransform: "uppercase",
                  color: "var(--fg-faint)",
                  padding: "0 10px 6px",
                }}
              >
                {group.header}
              </div>
            )}
            {group.items.map((item) => {
              const active = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 8,
                    fontSize: 13.5,
                    fontWeight: active ? 600 : 500,
                    color: active ? "var(--fg)" : "var(--fg-muted)",
                    background: active ? "var(--surface-2)" : "transparent",
                    border: `1px solid ${active ? "var(--border-strong)" : "transparent"}`,
                    textDecoration: "none",
                    transition: "background 0.13s, color 0.13s, border-color 0.13s",
                  }}
                >
                  <span
                    style={{
                      color: active ? "var(--accent)" : "var(--fg-faint)",
                      display: "flex",
                    }}
                  >
                    {item.icon}
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div style={{ marginTop: "auto", paddingTop: 14 }}>
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <ThemeToggle />
          <div style={{ fontSize: 11, color: "var(--fg-faint)", padding: "10px 10px 2px" }}>
            v0.1 · runs locally
          </div>
        </div>
      </div>
    </aside>
  );
}

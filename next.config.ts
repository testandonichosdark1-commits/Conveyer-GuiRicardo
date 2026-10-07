import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack anchored to this project even when a parent directory has
  // another package-lock.json. Otherwise Tailwind can be resolved from the
  // wrong folder and the interface is rendered without styles.
  turbopack: {
    root: __dirname,
  },
  serverExternalPackages: ["better-sqlite3", "fluent-ffmpeg"],
  // Next.js dev mode blocks cross-origin requests to dev-only resources (HMR socket,
  // fonts, etc.) by default — confirmed live 2026-10-06: a phone on the same Wi-Fi
  // loading the "Network" URL got a run page whose logs never appeared, because the
  // server log showed "Blocked cross-origin request to Next.js dev resource
  // /_next/webpack-hmr from 192.168.1.238" — the client JS never finished hydrating,
  // so the log-polling effect never ran. This allowlists the operator's own LAN IP so
  // viewing a run's progress from a phone on the same network actually works. The IP
  // is DHCP-assigned and can change; update this list if "Network:" prints a different
  // address later. Dev-only setting — irrelevant to `next build`/`next start`.
  allowedDevOrigins: ["192.168.1.238"],
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
  },
  // The Next.js dev indicator (dev-only; never shipped to production) defaults to
  // the bottom-left, where it overlaps our left-aligned page content on narrow
  // screens. Move it to the bottom-right so it stays out of the way while remaining
  // accessible during development.
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;

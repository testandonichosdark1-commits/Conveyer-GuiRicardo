import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack anchored to this project even when a parent directory has
  // another package-lock.json. Otherwise Tailwind can be resolved from the
  // wrong folder and the interface is rendered without styles.
  turbopack: {
    root: __dirname,
  },
  serverExternalPackages: ["better-sqlite3", "fluent-ffmpeg"],
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

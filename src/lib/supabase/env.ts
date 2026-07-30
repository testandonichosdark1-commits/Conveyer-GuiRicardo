/**
 * Reads and validates the Supabase auth env vars, failing fast with a clear,
 * actionable message when either is missing. This is the ONE place the app reads
 * them, so the server client, browser client, and middleware all fail identically.
 *
 * The full literals `process.env.NEXT_PUBLIC_SUPABASE_URL` /
 * `..._ANON_KEY` must appear verbatim here — the bundler statically inlines those
 * exact member expressions into the browser bundle, so they can't be read via a
 * dynamic `process.env[name]` lookup.
 */
/**
 * True when both Supabase env vars are present. Used to let the app run
 * gate-free on a bare local checkout (no .env.local yet) instead of hard
 * failing — this is a single-operator local tool, so auth is opt-in: set
 * both vars to turn the login gate back on.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) && Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function getSupabaseEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing: string[] = [];
  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (missing.length > 0) {
    throw new Error(
      `[Supabase auth] Missing required environment variable${missing.length > 1 ? "s" : ""}: ` +
        `${missing.join(", ")}.\n\n` +
        `The whole app is gated behind Supabase Auth and cannot start without these.\n` +
        `Create a .env.local file in the project root containing:\n\n` +
        `  NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co\n` +
        `  NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...   # the PUBLISHABLE key (never the sb_secret_ one)\n\n` +
        `Get both from the Supabase dashboard → Settings → API. Full walkthrough: ` +
        `the "Supabase Setup" section in README.md.`
    );
  }

  return { url: url!, anonKey: anonKey! };
}

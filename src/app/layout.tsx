import "./globals.css";
import type { ReactNode } from "react";
import { TopNav } from "./_topnav";
import { LangProvider } from "./_i18n";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/supabase/roles";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const metadata = {
  title: "Faceless Video Generator",
  description: "Avatar video studio — HeyGen avatar + ElevenLabs voice, illustrated with real internet footage or AI b-roll.",
};

// Without this, mobile browsers lay the page out at a wide fallback width and
// scale the whole UI down (unreadable). This makes the layout viewport match the
// device width so our responsive rules actually apply.
export const viewport = {
  width: "device-width",
  initialScale: 1,
};

// Applied before first paint so the chosen theme doesn't flash (anti-FOUC).
// Lives as the first node inside <body> — a manual <head> in an App Router
// layout breaks hydration, so it must NOT go there.
const themeScript = `try{if(localStorage.getItem('theme')==='light'){document.documentElement.setAttribute('data-theme','light');}}catch(e){}`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Resolve the current user once for the whole shell — the middleware already
  // gates access, so this only drives the nav (user menu + admin-only Settings).
  // No Supabase env configured → no login system at all (see middleware.ts);
  // treat as a trusted local admin so Settings stays reachable, but with no
  // email/session, so the nav's account menu (Logout) stays hidden.
  let navUser: { email: string; isAdmin: boolean } | null = { email: "", isAdmin: true };
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    navUser = user ? { email: user.email ?? "", isAdmin: isAdmin(user) } : null;
  }

  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <LangProvider>
          <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
            <TopNav user={navUser} />
            <main style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center" }}>
              <div className="app-main">
                {children}
              </div>
            </main>
          </div>
        </LangProvider>
      </body>
    </html>
  );
}

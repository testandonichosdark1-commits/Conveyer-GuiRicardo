import "./globals.css";
import type { ReactNode } from "react";
import { TopNav } from "./_topnav";
import { LangProvider } from "./_i18n";

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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <LangProvider>
          <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
            <TopNav />
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

import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { isAdmin } from "@/lib/supabase/roles";

/**
 * The ONE place auth is enforced. No page or API route implements its own check.
 *
 * Rules:
 *  - Public: /login and /auth/* (signout) always pass.
 *  - Unauthenticated + /api/*  → 401 JSON (never an HTML redirect for APIs).
 *  - Unauthenticated + page    → redirect to /login?redirect=<original path+query>
 *    so deep links survive the round-trip.
 *  - Authenticated on /login   → redirect to /.
 *  - Admin gate: the Settings surfaces expose provider API keys, so a non-admin
 *    hitting /parametres|/settings|/advanced is redirected to /, and
 *    /api/settings returns 401.
 *
 * Cookie note: updateSession refreshes the session cookie onto its response. When
 * we redirect/deny instead, we copy those cookies onto our own response so the
 * refreshed session is never dropped.
 */

const ADMIN_PAGES = ["/parametres", "/settings", "/advanced"];

function isAdminPage(pathname: string): boolean {
  return ADMIN_PAGES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function withCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
  return to;
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const { response, user } = await updateSession(request);

  const isApi = pathname.startsWith("/api/");
  const isPublic =
    pathname === "/login" || pathname.startsWith("/auth/");

  // Public routes: let them through (but still refresh cookies).
  if (isPublic) {
    // An already-authenticated user has no business on the login page.
    if (user && pathname === "/login") {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return withCookies(response, NextResponse.redirect(url));
    }
    return response;
  }

  // Unauthenticated.
  if (!user) {
    if (isApi) {
      return withCookies(
        response,
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?redirect=${encodeURIComponent(pathname + search)}`;
    return withCookies(response, NextResponse.redirect(url));
  }

  // Authenticated but not admin: block the Settings surfaces.
  if (!isAdmin(user)) {
    if (pathname === "/api/settings") {
      return withCookies(
        response,
        NextResponse.json({ error: "Forbidden" }, { status: 401 })
      );
    }
    if (isAdminPage(pathname)) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return withCookies(response, NextResponse.redirect(url));
    }
  }

  return response;
}

export const config = {
  /**
   * Run on everything EXCEPT Next internals and static assets. The negative
   * lookahead keeps `_next/static`, `_next/image`, favicon and common asset
   * extensions out of the gate (so CSS/JS/images on /login aren't blocked and we
   * avoid redirect loops); /api/* is deliberately included.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf|map)$).*)",
  ],
};

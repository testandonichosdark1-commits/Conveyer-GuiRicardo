import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Logout. Posted from the nav's Logout form. Clears the Supabase session cookie
 * (server client writes to cookies() here — allowed in a Route Handler) then
 * redirects to /login. GET is intentionally unsupported (avoids prefetch logout).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const url = new URL("/login", request.url);
  return NextResponse.redirect(url, { status: 303 });
}

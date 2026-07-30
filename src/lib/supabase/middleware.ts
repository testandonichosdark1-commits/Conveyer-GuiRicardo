import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseEnv } from "./env";

/**
 * Refreshes the Supabase session cookie for the current request and resolves the
 * user. Returns both the (possibly cookie-mutated) response to continue with and
 * the resolved user, so the root middleware can make the gate decision.
 *
 * IMPORTANT (per @supabase/ssr docs): do not run code between createServerClient
 * and getUser(), and the response we build here must carry the refreshed cookies.
 * When the caller needs to redirect/deny, it must copy these cookies onto its own
 * response (see middleware.ts) so the refreshed session isn't dropped.
 */
export async function updateSession(request: NextRequest) {
  const response = NextResponse.next({ request });
  const { url, anonKey } = getSupabaseEnv();

  const supabase = createServerClient(
    url,
    anonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response, user };
}

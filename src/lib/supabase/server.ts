import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseEnv } from "./env";

/**
 * Supabase client for the server side (RSC, Route Handlers, Server Actions),
 * bound to the request's cookies. Server Components can only READ cookies, so
 * the setAll writes are wrapped in try/catch — cookie refresh there is a no-op
 * and is instead handled by the middleware on every request.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabaseEnv();

  return createServerClient(
    url,
    anonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component — cookies are read-only here.
            // The middleware refreshes the session cookie, so this is safe to ignore.
          }
        },
      },
    }
  );
}

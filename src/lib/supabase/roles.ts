import type { User } from "@supabase/supabase-js";

/**
 * Single source of truth for authorization roles. Today there is just one bit —
 * admin — stored in `app_metadata.role` (set from the Supabase dashboard, so a
 * user can't grant it to themselves). This is the seam for future roles
 * (Admin/Client/Viewer): add cases here and the middleware picks them up.
 */
export function getRole(user: User | null | undefined): string | null {
  const role = user?.app_metadata?.role;
  return typeof role === "string" ? role : null;
}

export function isAdmin(user: User | null | undefined): boolean {
  return getRole(user) === "admin";
}

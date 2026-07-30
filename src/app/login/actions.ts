"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error?: string };

/**
 * Only allow relative, same-origin redirect targets ("/jobs?x=1"), never an
 * absolute URL or protocol-relative "//evil.com" — otherwise the ?redirect=
 * param would be an open-redirect. Falls back to "/".
 */
function safeRedirect(target: unknown): string {
  if (typeof target !== "string") return "/";
  if (!target.startsWith("/") || target.startsWith("//")) return "/";
  return target;
}

export async function login(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeRedirect(formData.get("redirect"));

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: "Invalid email or password." };
  }

  // Success — redirect() throws NEXT_REDIRECT, so it must be outside the
  // try-like flow above (there is none here) and after the error return.
  redirect(next);
}

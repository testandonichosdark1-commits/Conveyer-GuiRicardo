import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { buildAuthUrl } from "@/lib/services/gdrive";

/**
 * First leg of the Google OAuth dance: build the consent URL and redirect the
 * user's browser to Google. After they grant access, Google redirects them to
 * /api/gdrive/oauth/callback with a one-time code.
 */
export async function GET() {
  ensureInit();
  try {
    const url = buildAuthUrl();
    return NextResponse.redirect(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

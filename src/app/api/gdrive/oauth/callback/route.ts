import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { exchangeCodeForTokens } from "@/lib/services/gdrive";

/**
 * Second leg of OAuth: Google redirects the user here with `?code=...` after
 * consent. We swap the code for tokens, persist refresh_token + email, then
 * redirect back to the Drive settings page with a status banner.
 *
 * That page is /full-settings. It used to be mounted at /settings, and this
 * redirect was never updated after the split — so consent dropped the user on a
 * page with no Drive section, no connection status, no toggle, and no success
 * message (the `?gdrive=` handler lives on /full-settings, so it never ran). The
 * user was left with no evidence the connection had worked at all.
 */
export async function GET(req: Request) {
  ensureInit();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const origin = url.origin;

  if (error) {
    return NextResponse.redirect(
      `${origin}/full-settings?gdrive=error&reason=${encodeURIComponent(error)}`
    );
  }
  if (!code) {
    return NextResponse.redirect(`${origin}/full-settings?gdrive=error&reason=missing_code`);
  }

  try {
    // `autoSync=1` only when THIS connection turned auto-upload on, so the banner
    // can promise automatic uploads only when that is actually true.
    const { autoEnabledSync } = await exchangeCodeForTokens(code);
    return NextResponse.redirect(
      `${origin}/full-settings?gdrive=connected${autoEnabledSync ? "&autoSync=1" : ""}`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.redirect(
      `${origin}/full-settings?gdrive=error&reason=${encodeURIComponent(msg)}`
    );
  }
}

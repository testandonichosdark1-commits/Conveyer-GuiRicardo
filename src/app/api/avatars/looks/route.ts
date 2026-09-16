import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { listAvatarVCompatibleAvatars } from "@/lib/services/heygen-avatar";

export const runtime = "nodejs";

/**
 * Avatar V picker data — the operator's HeyGen avatars that support Avatar V.
 *
 * Read-only: it lists, it never creates. Every entry is already filtered by HeyGen's
 * live `supported_api_engines`, so the picker cannot offer an avatar that Avatar V
 * would reject. The import route still re-checks server-side rather than trusting the
 * client — support is per-avatar and mutable, so it is never cached.
 */
export async function GET() {
  ensureInit();

  // Same pre-flight as the create route: a missing key otherwise reads as an empty
  // list ("I have avatars, why is it blank?") instead of a fixable problem.
  if (!getSetting("HEYGEN_API_KEY")) {
    return NextResponse.json(
      { error: "Add your HeyGen API key in Settings to list your compatible avatars (Settings → HeyGen — API key)." },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json({ looks: await listAvatarVCompatibleAvatars() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b401\b|\b403\b|unauthorized|forbidden/i.test(msg)) {
      return NextResponse.json(
        { error: "HeyGen rejected your API key (401 Unauthorized). Fix it in Settings, then try again." },
        { status: 400 }
      );
    }
    if (/\b429\b|rate_limit_exceeded|rate limit/i.test(msg)) {
      // The request was fine — HeyGen is throttling. Say that, and pass 429 through so
      // it isn't mistaken for a bug on our side (a 502 reads as "our server broke").
      return NextResponse.json(
        { error: "HeyGen is rate-limiting your account right now. Wait a moment, then hit Refresh." },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { error: `Couldn't load your HeyGen avatars: ${msg.slice(0, 200)}` },
      { status: 502 }
    );
  }
}

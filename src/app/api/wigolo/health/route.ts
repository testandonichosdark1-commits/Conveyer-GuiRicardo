import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * Liveness of the local wigolo daemon, for the Settings checkbox.
 *
 * The probe has to happen server-side: the daemon listens on the SERVER's loopback, which a
 * browser generally cannot reach, and the address may carry a bearer token we must not hand
 * out. So the response is deliberately just `{ ok }` — never the URL, never the token, never
 * the daemon's own payload. `/health` needs no authentication even when a token is
 * configured (verified against a token-enabled daemon), so one probe covers every setup.
 *
 * A missing address is reported as "not running" rather than as an error: from the
 * operator's side both mean the same thing — ticking the source right now would find nothing.
 */
export async function GET() {
  ensureInit();
  const base = (getSetting("WIGOLO_URL") || "").trim();
  if (!base) return NextResponse.json({ ok: false });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const resp = await fetch(new URL("/health", base), { signal: ctrl.signal });
    return NextResponse.json({ ok: resp.ok });
  } catch {
    // Down, unreachable, or a malformed address — all the same answer to the operator.
    return NextResponse.json({ ok: false });
  } finally {
    clearTimeout(timer);
  }
}

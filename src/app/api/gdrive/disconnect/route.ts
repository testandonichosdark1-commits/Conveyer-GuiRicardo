import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { clearConnection } from "@/lib/services/gdrive";

export async function POST() {
  ensureInit();
  clearConnection();
  return NextResponse.json({ ok: true });
}

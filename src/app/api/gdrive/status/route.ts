import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getConnectionStatus } from "@/lib/services/gdrive";

export async function GET() {
  ensureInit();
  const status = await getConnectionStatus();
  return NextResponse.json(status);
}

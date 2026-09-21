import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { flowSessionStatus, openFlowSession } from "@/lib/services/flow-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureInit();
  return NextResponse.json(flowSessionStatus());
}

export async function POST() {
  ensureInit();
  try {
    return NextResponse.json(await openFlowSession());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}


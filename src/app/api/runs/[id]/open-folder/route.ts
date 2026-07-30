import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { getRunDir } from "@/lib/run-paths";

const getRun = db.prepare("SELECT id FROM runs WHERE id = ?");

/**
 * Opens the run folder in the system file browser.
 * Windows → explorer.exe, macOS → open, Linux → xdg-open.
 * Only useful in localhost / dev mode.
 */
export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  if (!getRun.get(id)) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const runDir = getRunDir(id);
  if (!fs.existsSync(runDir)) {
    return NextResponse.json({ error: "folder not found", runDir }, { status: 404 });
  }

  try {
    const platform = os.platform();
    let cmd: string;
    let args: string[];
    if (platform === "win32") {
      cmd = "explorer.exe";
      args = [runDir];
    } else if (platform === "darwin") {
      cmd = "open";
      args = [runDir];
    } else {
      cmd = "xdg-open";
      args = [runDir];
    }
    // Spawn detached so we don't block the request
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    return NextResponse.json({ ok: true, runDir });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, runDir },
      { status: 500 }
    );
  }
}

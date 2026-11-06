import { NextResponse } from "next/server";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";

/**
 * Lets an operator flip an already-created "GPT + LTX" run between the two beat-visual
 * sources it supports — Codex/LTX and Google Flow — without a server restart or a hand
 * edit of config_json. Read live by studio-pipeline.ts's readConfig() on every pipeline
 * start (fresh run AND Resume), so the new choice only applies to whatever hasn't
 * rendered yet: already-finished beats are untouched, and nothing here starts or stops
 * generation by itself — the operator still clicks Resume afterward.
 */

const getRun = db.prepare("SELECT config_json FROM runs WHERE id = ? AND deleted_at IS NULL");
const updateConfig = db.prepare("UPDATE runs SET config_json = ?, updated_at = datetime('now') WHERE id = ?");

function readCfg(configJson: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// A run qualifies once it has ever used this feature — either stamped at creation
// (gptLtxEnabled) or, for a run created before that flag existed, still sitting in "ltx".
function eligible(cfg: Record<string, unknown>) {
  return cfg.gptLtxEnabled === true || cfg.aiProvider === "ltx" || cfg.aiProvider === "flow";
}

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const row = getRun.get(id) as { config_json: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "Vídeo não encontrado." }, { status: 404 });
  const cfg = readCfg(row.config_json);
  return NextResponse.json({ eligible: eligible(cfg), provider: cfg.aiProvider === "flow" ? "flow" : "ltx" });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  if (req.headers.get("Origin") !== new URL(req.url).origin) {
    return NextResponse.json({ error: "Abra no Conveyer." }, { status: 403 });
  }
  const { id } = await ctx.params;
  let body: { provider?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
  }
  if (body.provider !== "ltx" && body.provider !== "flow") {
    return NextResponse.json({ error: "Escolha GPT ou Flow." }, { status: 400 });
  }

  const row = getRun.get(id) as { config_json: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "Vídeo não encontrado." }, { status: 404 });
  const cfg = readCfg(row.config_json);
  if (!eligible(cfg)) {
    return NextResponse.json({ error: "Este vídeo não foi criado com GPT + LTX." }, { status: 400 });
  }

  cfg.aiProvider = body.provider;
  // Backfill for a run created before gptLtxEnabled existed, so eligibility survives
  // even after this toggle moves its aiProvider away from "ltx".
  cfg.gptLtxEnabled = true;
  updateConfig.run(JSON.stringify(cfg), id);
  return NextResponse.json({ ok: true, provider: body.provider });
}

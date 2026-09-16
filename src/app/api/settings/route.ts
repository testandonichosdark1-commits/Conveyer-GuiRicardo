import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { SETTING_KEYS, getMaskedSettings, getAllSettings, getSetting, setSetting, type SettingKey } from "@/lib/settings";
import { applyRunsRoot } from "@/lib/run-paths";
import { isRetiredGeminiModel, replacementForGeminiModel } from "@/lib/services/gemini-models";

export async function GET(req: Request) {
  ensureInit();
  const url = new URL(req.url);
  if (url.searchParams.get("reveal") === "1") {
    return NextResponse.json(getAllSettings());
  }
  return NextResponse.json(getMaskedSettings());
}

export async function POST(req: Request) {
  ensureInit();
  const body = (await req.json()) as Record<string, string>;
  const allowed = new Set<string>(SETTING_KEYS);

  // Перевірка зміни RUNS_OUTPUT_DIR ще ДО запису в БД — якщо валідація провалиться,
  // не міняємо інші поля частково.
  if ("RUNS_OUTPUT_DIR" in body) {
    const oldVal = getSetting("RUNS_OUTPUT_DIR");
    const newVal = String(body.RUNS_OUTPUT_DIR ?? "").trim();
    if (newVal !== oldVal) {
      const res = applyRunsRoot(newVal);
      if (!res.ok) {
        return NextResponse.json({ error: `RUNS_OUTPUT_DIR: ${res.error}` }, { status: 400 });
      }
    }
  }

  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) continue;
    const next = String(v ?? "");

    // Defense against the "save masked secrets" trap:
    // GET returns secret values as "AIza…XXXX" (truncated with U+2026). If the
    // user opens /settings (where they see masked values), doesn't touch the
    // field, and clicks "Save all", the form would POST those masked strings
    // BACK to us — overwriting the real key in the DB with a broken value.
    // The corrupted key then breaks every API call ("Cannot convert argument
    // to a ByteString because the character at index N has a value of 8230").
    const isSecretField = k.includes("KEY") || k.includes("TOKEN");
    if (isSecretField && next.includes("…")) {
      // A secret field came back with a mask. For MULTI-KEY fields (Pexels/69labs
      // key lists) the value can mix newly-typed real keys with masked placeholders
      // for untouched existing keys — skipping the whole field would silently DROP
      // the new key. Re-hydrate each masked entry (first4…last4) from the current DB
      // value and keep the real ones. Storage format (newline-separated) is unchanged.
      const existing = (getSetting(k as SettingKey) || "")
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const merged = next
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
          if (!entry.includes("…")) return entry; // newly typed / edited real key
          // Storyblocks entries are "publicKey:privateKey" with BOTH halves masked
          // separately and the colon kept (see maskEntry in settings.ts). Re-hydrate by
          // matching each half's first4/last4 against the stored pairs. Requiring BOTH to
          // match is what stops a half-edited row resolving to somebody else's pair.
          if (k === "STORYBLOCKS_API_KEYS") {
            const c = entry.indexOf(":");
            if (c <= 0) return null;
            const pm = entry.slice(0, c).match(/^(.{1,4})…(.{1,4})$/);
            const sm = entry.slice(c + 1).match(/^(.{1,4})…(.{1,4})$/);
            const found = existing.find((x) => {
              const j = x.indexOf(":");
              if (j <= 0) return false;
              const pub = x.slice(0, j);
              const priv = x.slice(j + 1);
              const pubOk = pm ? pub.startsWith(pm[1]) && pub.endsWith(pm[2]) : pub === entry.slice(0, c);
              const privOk = sm ? priv.startsWith(sm[1]) && priv.endsWith(sm[2]) : priv === entry.slice(c + 1);
              return pubOk && privOk;
            });
            return found ?? null;
          }
          const m = entry.match(/^(.{1,4})…(.{1,4})$/);
          if (!m) return null;
          return existing.find((x) => x.startsWith(m[1]) && x.endsWith(m[2])) ?? null;
        })
        .filter((x): x is string => x !== null);
      // Only write when we resolved at least one real key; otherwise leave the DB
      // untouched (preserves the original "don't overwrite with a broken mask" guard).
      if (merged.length > 0) setSetting(k as SettingKey, merged.join("\n"));
      continue;
    }

    // Never let a retired/deprecated Gemini id be saved for the planner or vision
    // model — transparently coerce it to the live Gemini-3 replacement. This blocks
    // an operator from re-selecting an EOL model, and complements the runtime ladder
    // (which already fails over) + the one-time DB migration.
    if ((k === "SCENE_SPLIT_MODEL" || k === "VISION_MATCH_MODEL") && isRetiredGeminiModel(next)) {
      setSetting(k as SettingKey, replacementForGeminiModel(next));
      continue;
    }

    setSetting(k as SettingKey, next);
  }
  return NextResponse.json({ ok: true });
}

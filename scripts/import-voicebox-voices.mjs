// Recria os perfis de voz do Voicebox (kokoro presets) numa instalação nova
// do Faceless Video Generator, a partir de voicebox-voices-export.json.
//
// Pré-requisitos antes de rodar isto:
//   1. Voicebox (github.com/jamiepine/voicebox) clonado localmente.
//   2. `npm run setup:voicebox -- "/caminho/para/voicebox"` já rodado uma vez.
//   3. VOICEBOX_DIR configurado em /settings (ou no .env) apontando pro checkout.
//   4. O servidor Next (`npm run dev`) rodando em http://localhost:3000.
//
// Uso:
//   node scripts/import-voicebox-voices.mjs
//   node scripts/import-voicebox-voices.mjs --base http://localhost:3000
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseArgIdx = process.argv.indexOf("--base");
const BASE_URL = baseArgIdx !== -1 ? process.argv[baseArgIdx + 1] : "http://localhost:3000";

const exportPath = path.join(__dirname, "..", "voicebox-voices-export.json");
const voices = JSON.parse(fs.readFileSync(exportPath, "utf8"));

function log(msg) {
  console.log(`[import-voicebox-voices] ${msg}`);
}

async function existingPresetIds() {
  const r = await fetch(`${BASE_URL}/api/voices/voicebox`);
  if (!r.ok) throw new Error(`GET /api/voices/voicebox -> ${r.status}`);
  const list = await r.json();
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((v) => v.preset_engine).map((v) => `${v.preset_engine}:${v.preset_voice_id}`));
}

async function main() {
  log(`Alvo: ${BASE_URL}`);
  const already = await existingPresetIds();

  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const v of voices) {
    const key = `${v.engine}:${v.presetVoiceId}`;
    if (already.has(key)) {
      skipped++;
      log(`já existe, pulando: ${v.name}`);
      continue;
    }
    const fd = new FormData();
    fd.set("name", v.name);
    fd.set("engine", v.engine);
    fd.set("presetVoiceId", v.presetVoiceId);
    try {
      const r = await fetch(`${BASE_URL}/api/voices/voicebox`, { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      created++;
      log(`criada: ${v.name}`);
    } catch (e) {
      errors.push(`${v.name}: ${e.message}`);
      log(`ERRO em ${v.name}: ${e.message}`);
    }
  }

  log(`Concluído. Criadas: ${created}, já existentes: ${skipped}, erros: ${errors.length}`);
  if (errors.length) {
    log("Erros:");
    for (const e of errors) log(`  - ${e}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`[import-voicebox-voices] falhou: ${e.message}`);
  process.exitCode = 1;
});

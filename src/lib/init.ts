// Server-only module — runs once per dev server start to seed default settings/prompts.
import { seedDefaults } from "./settings";
import { seedPromptDefaults } from "./prompts";

let inited = false;
export function ensureInit() {
  if (inited) return;
  seedDefaults();
  seedPromptDefaults();
  inited = true;
}

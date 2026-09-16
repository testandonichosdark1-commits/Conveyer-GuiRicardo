// Server-only module — runs once per process start to seed default
// settings/prompts and recover runs orphaned by a previous process.
import { seedDefaults } from "./settings";
import { seedPromptDefaults } from "./prompts";
import { initRunLifecycle } from "./run-lifecycle";

let inited = false;
export function ensureInit() {
  if (inited) return;
  inited = true; // set first: ensureInit is synchronous, so this also guards re-entry
  seedDefaults();
  seedPromptDefaults();
  // Run lifecycle bootstrap (once per process, BEFORE any pipeline starts here):
  //  • install process-level crash handlers (uncaughtException → fail active runs
  //    + exit; unhandledRejection → log),
  //  • detect + warn on unsupported multi-process deployments,
  //  • recover runs orphaned by a dead process → "interrupted".
  // See run-lifecycle.ts.
  initRunLifecycle();
}

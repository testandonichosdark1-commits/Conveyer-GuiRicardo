// Restores native .node binaries that Windows Defender or other antivirus
// products sometimes truncate / quarantine after `npm install`.
//
// This problem is Windows-specific (Defender flags native binaries).
// On macOS / Linux `npm install` produces working binaries — this script
// no-ops there.
//
// Runs as `postinstall` (auto) and can also be invoked manually:
//   npm run fix-bins
//
// Strategy: for each target, if the local file is missing OR smaller than the
// expected minSize sanity threshold, copy from the first working source path.
// If no source is found, log a warning and continue — install still succeeds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// On non-Windows platforms this script has nothing to do — npm install
// produces clean native binaries and there's no antivirus eating them.
if (os.platform() !== "win32") {
  console.log("[fix-bins] Non-Windows platform — skipping (antivirus issue is Windows-only).");
  process.exit(0);
}

const TARGETS = [
  {
    name: "next-swc (win32-x64)",
    local: "node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node",
    sources: [
      "C:/Users/cupak/CascadeProjects/Hum Conveyer/node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node",
      "C:/Users/cupak/CascadeProjects/Conveyer Isabell/node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node",
    ],
    minSize: 50_000_000, // expected ~136MB
  },
  {
    name: "better-sqlite3 (win32-x64)",
    local: "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    sources: [
      "C:/Users/cupak/CascadeProjects/Hum Conveyer/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "C:/Users/cupak/CascadeProjects/Conveyer Isabell/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    ],
    minSize: 500_000, // expected ~1.9MB
  },
];

let restored = 0;
let fineCount = 0;
for (const t of TARGETS) {
  const localPath = path.resolve(t.local);
  let needsFix = false;
  let reason = "";
  if (!fs.existsSync(localPath)) {
    needsFix = true;
    reason = "missing";
  } else {
    const size = fs.statSync(localPath).size;
    if (size < t.minSize) {
      needsFix = true;
      reason = `${size} bytes (expected ≥${t.minSize})`;
    }
  }
  if (!needsFix) {
    fineCount++;
    continue;
  }

  const src = t.sources.find(
    (s) => fs.existsSync(s) && fs.statSync(s).size >= t.minSize
  );
  if (!src) {
    console.log(`[fix-bins] ${t.name}: ${reason}, but no working source found — skipping`);
    console.log(`[fix-bins]   tried: ${t.sources.join(", ")}`);
    continue;
  }
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.copyFileSync(src, localPath);
  console.log(`[fix-bins] Restored ${t.name} (was ${reason}) from ${src}`);
  restored++;
}
console.log(
  `[fix-bins] Done. Restored: ${restored}, already-fine: ${fineCount}, total: ${TARGETS.length}`
);

#!/usr/bin/env node
// Compatibility shim: the catalog is now built from every running profile by
// `pnpm profiles sync` (scripts/profiles.ts), which emits `<profile>/<model>`
// IDs against one gateway base URL. This keeps the old entry point working.
import { spawnSync } from "node:child_process";

console.warn("sync-model-catalog.mjs is deprecated; running `pnpm profiles sync` instead.");
const res = spawnSync(
  process.execPath,
  ["--import", "tsx", "scripts/profiles.ts", "sync", ...process.argv.slice(2)],
  { stdio: "inherit", cwd: process.cwd() },
);
process.exit(res.status ?? 1);

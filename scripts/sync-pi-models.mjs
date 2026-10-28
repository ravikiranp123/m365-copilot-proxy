#!/usr/bin/env node
// Backwards-compatible entry point for Pi and OpenCode model synchronization.
import { main } from "./sync-models.mjs";

main().catch((error) => {
  console.error(`[sync-models] ${error.message}`);
  process.exitCode = 1;
});

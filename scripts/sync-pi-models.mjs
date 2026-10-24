#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Parse arguments
const args = process.argv.slice(2);
let port = process.env.PORT || "4141";
let targetPath = resolve(homedir(), ".pi/agent/models.json");
let offlineOnly = false;
let quiet = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--port" && args[i + 1]) {
    port = args[++i];
  } else if (arg === "--target" && args[i + 1]) {
    targetPath = resolve(args[++i]);
  } else if (arg === "--local") {
    targetPath = resolve(repoRoot, ".pi-local/.pi/agent/models.json");
  } else if (arg === "--offline") {
    offlineOnly = true;
  } else if (arg === "--quiet" || arg === "-q") {
    quiet = true;
  } else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: node scripts/sync-pi-models.mjs [options]

Options:
  --port <port>     Proxy port (default: 4141, or $PORT)
  --target <path>   Path to models.json (default: ~/.pi/agent/models.json)
  --local           Target repo-local .pi-local/.pi/agent/models.json
  --offline         Load models directly from @m365-copilot/core instead of HTTP
  --quiet, -q       Suppress info logs
  --help, -h        Show this help message
`);
    process.exit(0);
  }
}

/**
 * Format a model ID into a user-friendly display name.
 */
function formatModelName(id) {
  const nameMap = {
    "m365-copilot": "M365 Copilot",
    "auto": "Copilot Auto",
    "quick": "Copilot Quick",
    "think-deeper": "Copilot Think Deeper",
  };
  if (nameMap[id]) return nameMap[id];

  const parts = id.split("-");
  const words = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lower = p.toLowerCase();
    if (lower === "gpt" && i + 1 < parts.length && /^\d+(\.\d+)*$/.test(parts[i + 1])) {
      words.push(`GPT-${parts[i + 1]}`);
      i++;
    } else if (lower === "gpt") {
      words.push("GPT");
    } else if (lower === "claude") {
      words.push("Claude");
    } else if (lower === "sol") {
      words.push("Sol");
    } else if (lower === "opus") {
      words.push("Opus");
    } else if (lower === "sonnet") {
      words.push("Sonnet");
    } else if (lower === "haiku") {
      words.push("Haiku");
    } else if (lower === "quick") {
      words.push("Quick");
    } else if (lower === "think") {
      words.push("Think");
    } else if (lower === "deeper") {
      words.push("Deeper");
    } else {
      words.push(p.charAt(0).toUpperCase() + p.slice(1));
    }
  }
  return words.join(" ");
}

/**
 * Retrieve model IDs either via HTTP from running proxy or from core package.
 */
async function getModelIds() {
  if (!offlineOnly) {
    const url = `http://127.0.0.1:${port}/v1/models`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.data) && json.data.length > 0) {
          if (!quiet) console.log(`[sync-pi-models] Fetched ${json.data.length} models from live endpoint: ${url}`);
          return json.data.map((m) => m.id);
        }
      }
    } catch {
      if (!quiet) console.log(`[sync-pi-models] Live endpoint ${url} unreachable, falling back to @m365-copilot/core`);
    }
  }

  // Fallback to core
  try {
    const core = await import("../packages/core/dist/index.mjs");
    const models = core.getAvailableModels();
    if (!quiet) console.log(`[sync-pi-models] Loaded ${models.length} models from @m365-copilot/core`);
    return models;
  } catch (err) {
    throw new Error(`Failed to load models from core: ${err.message}`);
  }
}

async function main() {
  const modelIds = await getModelIds();
  const models = modelIds.map((id) => ({
    id,
    name: formatModelName(id),
  }));

  // Read existing target file or create fresh structure
  let root = { providers: {} };
  if (existsSync(targetPath)) {
    try {
      const content = readFileSync(targetPath, "utf8");
      root = JSON.parse(content);
      if (!root.providers) root.providers = {};
    } catch (err) {
      console.warn(`[sync-pi-models] Warning: Could not parse existing ${targetPath}: ${err.message}. Creating fresh.`);
    }
  } else {
    mkdirSync(dirname(targetPath), { recursive: true });
  }

  const existingM365 = root.providers.m365 || {};
  const baseUrl = existingM365.baseUrl || `http://127.0.0.1:${port}/v1`;

  root.providers.m365 = {
    ...existingM365,
    baseUrl,
    api: existingM365.api || "openai-completions",
    apiKey: existingM365.apiKey || "m365",
    compat: existingM365.compat || {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
    },
    models,
  };

  const formattedJson = JSON.stringify(root, null, 2) + "\n";
  writeFileSync(targetPath, formattedJson, "utf8");
  if (!quiet) {
    console.log(`[sync-pi-models] Successfully updated ${models.length} models in ${targetPath}`);
  }
}

main().catch((err) => {
  console.error(`[sync-pi-models] Error: ${err.message}`);
  process.exit(1);
});

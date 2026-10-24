#!/usr/bin/env node
/**
 * Test script to probe all models advertised by the M365 Copilot proxy,
 * testing both general availability and tool use (requesting a bash script).
 *
 * Can run:
 *   1. Against a running proxy (default: http://127.0.0.1:4141 or --url=http://...)
 *   2. In-process standalone (auto-fallback if no proxy is running)
 *
 * Usage:
 *   node scripts/test-models.mjs                     # Test ALL advertised models with tool use
 *   node scripts/test-models.mjs --skip-metered      # Skip Opus 5.5 & Sonnet 5.5 quota models
 *   node scripts/test-models.mjs --dedupe            # Test only distinct underlying tones (~15 models)
 *   node scripts/test-models.mjs --no-tools          # Test chat only (no tool calling)
 *   node scripts/test-models.mjs --models=claude-sonnet,gpt-5.5
 *   node scripts/test-models.mjs --cooldown=4        # Seconds between turns (default: 3s)
 */

import {
  getToken,
  getAvailableModels,
  getToneForModel,
  getScenarioForModel,
  meteredBudgetOf,
} from "../packages/core/dist/index.mjs";
import { createApp } from "../packages/proxy-lib/dist/index.mjs";

const BASH_TOOL = {
  type: "function",
  function: {
    name: "bash",
    description: "Execute a shell command or script in the terminal",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command or script to execute",
        },
      },
      required: ["command"],
    },
  },
};

// Parse CLI flags
const args = process.argv.slice(2);
const flagSkipMetered = args.includes("--skip-metered");
const flagDedupe = args.includes("--dedupe");
const flagNoTools = args.includes("--no-tools");
const customModelsArg = args.find((a) => a.startsWith("--models="))?.slice(9);
const urlArg = args.find((a) => a.startsWith("--url="))?.slice(6) || process.env.PROXY_URL || process.env.BASE_URL;
const cooldownArg = args.find((a) => a.startsWith("--cooldown="))?.slice(11);
const cooldownSec = Number(cooldownArg) >= 0 ? Number(cooldownArg) : 3;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let mode = "in-process";
let baseUrl = urlArg || "http://127.0.0.1:4141";
let appInstance = null;

async function checkHttpEndpoint(url) {
  try {
    const res = await fetch(`${url}/health`, { method: "GET", signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

console.log("================================================================================");
console.log(" M365 Copilot Model & Tool Calling Tester");
console.log("================================================================================");

// Detect environment mode
if (urlArg) {
  mode = "http";
  console.log(`[mode] Explicit HTTP target configured: ${baseUrl}`);
} else if (await checkHttpEndpoint("http://127.0.0.1:4141")) {
  mode = "http";
  baseUrl = "http://127.0.0.1:4141";
  console.log(`[mode] Connected to running proxy at ${baseUrl}`);
} else {
  mode = "in-process";
  console.log("[mode] No proxy running on port 4141; executing in-process via @m365-copilot/proxy-lib");
  console.log("[auth] Checking M365 authentication credentials...");
  try {
    await getToken();
    console.log("[auth] Auth successful.");
    appInstance = createApp();
  } catch (err) {
    console.error(`[auth error] Failed to acquire token: ${err.message}`);
    console.error("Please verify credentials in ~/.config/opencode-m365/secrets.json");
    process.exit(1);
  }
}

// Fetch all available models from /v1/models endpoint or core definition
let allModelIds = [];
if (mode === "http") {
  try {
    const res = await fetch(`${baseUrl}/v1/models`);
    const data = await res.json();
    allModelIds = data.data.map((m) => m.id);
  } catch {
    allModelIds = getAvailableModels();
  }
} else {
  allModelIds = getAvailableModels();
}

// Build model metadata
let targetModels = allModelIds.map((id) => {
  const tone = getToneForModel(id);
  const { scenario } = getScenarioForModel(id);
  const metered = !!meteredBudgetOf(id);
  return { id, tone, scenario, metered };
});

// Apply filters
if (customModelsArg) {
  const requested = customModelsArg.split(",").map((s) => s.trim()).filter(Boolean);
  targetModels = targetModels.filter((m) => requested.includes(m.id));
} else if (flagDedupe) {
  // Deduplicate by (tone, scenario) to test unique paths only
  const seen = new Set();
  targetModels = targetModels.filter((m) => {
    const key = `${m.tone}@${m.scenario}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log("[filter] Deduplicated to unique (tone, scenario) combinations");
}

if (flagSkipMetered) {
  targetModels = targetModels.filter((m) => !m.metered);
  console.log("[filter] Skipped metered models (Opus 5.5, Sonnet 5.5)");
}

console.log(`[target] Models to test: ${targetModels.length}`);
console.log(`[mode]   Tool Calling: ${flagNoTools ? "DISABLED (chat only)" : "ENABLED (providing 'bash' tool)"}`);
console.log(`[pacing] ${cooldownSec}s cooldown between calls to prevent thread rate throttling\n`);

async function sendChatCompletion(modelId) {
  const body = {
    model: modelId,
    messages: [
      {
        role: "user",
        content: flagNoTools
          ? "Please state your exact model/assistant name and respond with 'ONLINE'. Keep it under 20 words."
          : "Execute a bash script that prints the current date, your model name, and 'ONLINE'. Output only the command.",
      },
    ],
    tools: flagNoTools ? undefined : [BASH_TOOL],
    stream: false,
  };

  const t0 = Date.now();
  let res, data;
  if (mode === "http") {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    data = await res.json().catch(() => null);
  } else {
    const req = new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    res = await appInstance.fetch(req);
    data = await res.json().catch(() => null);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  return { status: res.status, data, elapsed };
}

const results = [];
let throttled = false;

for (let i = 0; i < targetModels.length; i++) {
  const item = targetModels[i];
  const tag = `[${i + 1}/${targetModels.length}] ${item.id.padEnd(28)}`;
  process.stdout.write(tag);

  try {
    const { status, data, elapsed } = await sendChatCompletion(item.id);

    let classification = "ERROR";
    let detail = "";
    let toolCallSnippet = null;

    if (status === 200) {
      const choice = data?.choices?.[0];
      const toolCalls = choice?.message?.tool_calls;
      const content = choice?.message?.content;

      if (toolCalls && toolCalls.length > 0) {
        classification = "TOOL_CALL";
        const call = toolCalls[0];
        try {
          const argsObj = JSON.parse(call.function.arguments);
          const cmd = argsObj.command || JSON.stringify(argsObj);
          toolCallSnippet = cmd.replace(/\r?\n/g, " ; ").trim();
          detail = `Tool: bash -> "${toolCallSnippet.slice(0, 45)}"`;
        } catch {
          detail = `Tool: ${call.function.name}`;
        }
        console.log(`\x1b[32m✔ TOOL_CALL\x1b[0m (${elapsed}s) -> ${detail}`);
      } else if (content) {
        // Check if model emitted a bash code fence in prose
        const bashFenceMatch = content.match(/```(?:bash|sh)?\r?\n([\s\S]*?)```/);
        if (bashFenceMatch && !flagNoTools) {
          classification = "EMBEDDED_BASH";
          toolCallSnippet = bashFenceMatch[1].replace(/\r?\n/g, " ; ").trim();
          detail = `Fenced bash -> "${toolCallSnippet.slice(0, 40)}"`;
          console.log(`\x1b[34mℹ EMBEDDED_BASH\x1b[0m (${elapsed}s) -> ${detail}`);
        } else {
          classification = "TEXT_ONLY";
          const snippet = content.replace(/\r?\n/g, " ").trim();
          detail = snippet.length > 45 ? `${snippet.slice(0, 42)}...` : snippet;
          console.log(`\x1b[36m💬 TEXT_ONLY\x1b[0m (${elapsed}s) -> "${detail}"`);
        }
      } else {
        classification = "EMPTY_200";
        detail = "Response had neither tool_calls nor content";
        console.log(`\x1b[33m⚠ EMPTY 200\x1b[0m (${elapsed}s)`);
      }
    } else if (status === 429) {
      const errType = data?.error?.type;
      const errMsg = data?.error?.message || "";
      if (errType === "priority_access_exhausted" || errMsg.includes("priority access")) {
        classification = "OUT_OF_CREDITS";
        detail = "Priority access budget exhausted";
        console.log(`\x1b[33m⚡ QUOTA EXHAUSTED\x1b[0m (${elapsed}s)`);
      } else {
        classification = "THROTTLED";
        detail = "Account-level thread throttle (429)";
        console.log(`\x1b[31m⛔ THROTTLED\x1b[0m (${elapsed}s) -> ${errMsg.slice(0, 50)}`);
        throttled = true;
      }
    } else if (status === 502) {
      const errType = data?.error?.type;
      const errMsg = data?.error?.message || "";
      if (errType === "disengaged") {
        classification = "DISENGAGED";
        detail = "Safety filter declined";
        console.log(`\x1b[33m⚠ DISENGAGED\x1b[0m (${elapsed}s)`);
      } else if (errType === "model_route_unavailable" || errMsg.includes("premium-only") || errMsg.includes("not available")) {
        classification = "UNENTITLED";
        detail = "Requires premium/paid Copilot license";
        console.log(`\x1b[31m✖ UNENTITLED\x1b[0m (${elapsed}s) -> Needs paid scenario license`);
      } else {
        classification = "UPSTREAM_502";
        detail = errMsg.slice(0, 45);
        console.log(`\x1b[31m✖ 502 ERROR\x1b[0m (${elapsed}s) -> ${detail}`);
      }
    } else {
      classification = `HTTP_${status}`;
      detail = data?.error?.message || `HTTP ${status}`;
      console.log(`\x1b[31m✖ ${status}\x1b[0m (${elapsed}s) -> ${detail.slice(0, 45)}`);
    }

    results.push({
      model: item.id,
      tone: item.tone,
      scenario: item.scenario,
      status: classification,
      elapsed: `${elapsed}s`,
      detail,
      script: toolCallSnippet,
    });

    if (throttled) {
      console.log("\n[ABORT] Account throttle detected. Stopping further tests to avoid prolonging cooldown.");
      break;
    }
  } catch (err) {
    console.log(`\x1b[31m✖ CRASH\x1b[0m -> ${err.message}`);
    results.push({
      model: item.id,
      tone: item.tone,
      scenario: item.scenario,
      status: "FAILED",
      elapsed: "-",
      detail: err.message,
    });
  }

  // Cooldown between models
  if (i < targetModels.length - 1 && !throttled) {
    await pause(cooldownSec * 1000);
  }
}

// Print Summary Table
console.log("\n================================================================================");
console.log(" MODEL CAPABILITY & AVAILABILITY REPORT");
console.log("================================================================================");

console.log(
  `${"Model".padEnd(28)} ${"Status".padEnd(16)} ${"Latency".padEnd(10)} Output / Action`
);
console.log("-".repeat(80));

for (const r of results) {
  let statusColored = r.status;
  if (r.status === "TOOL_CALL") statusColored = `\x1b[32m${r.status}\x1b[0m`;
  else if (r.status === "EMBEDDED_BASH") statusColored = `\x1b[34m${r.status}\x1b[0m`;
  else if (r.status === "TEXT_ONLY") statusColored = `\x1b[36m${r.status}\x1b[0m`;
  else if (r.status === "OUT_OF_CREDITS" || r.status === "DISENGAGED") statusColored = `\x1b[33m${r.status}\x1b[0m`;
  else statusColored = `\x1b[31m${r.status}\x1b[0m`;

  console.log(
    `${r.model.padEnd(28)} ${statusColored.padEnd(25)} ${r.elapsed.padEnd(10)} ${r.detail}`
  );
}

const toolModels = results.filter((r) => r.status === "TOOL_CALL");
const embeddedModels = results.filter((r) => r.status === "EMBEDDED_BASH");
const textModels = results.filter((r) => r.status === "TEXT_ONLY");
const unentitled = results.filter((r) => r.status === "UNENTITLED");
const disengaged = results.filter((r) => r.status === "DISENGAGED");

console.log("\n--------------------------------------------------------------------------------");
console.log(`Summary: ${toolModels.length} Structured Tool Calls | ${embeddedModels.length} Embedded Bash Fences | ${textModels.length} Text Only | ${unentitled.length} Unentitled | ${disengaged.length} Disengaged`);
console.log("--------------------------------------------------------------------------------");

console.log("\nRecommendations for agent harnesses (pi / openclaw):");
const bestToolModel = toolModels.find((m) => m.model === "claude-sonnet") || toolModels[0];
if (bestToolModel) {
  console.log(`  ★ Recommended Coding/Tool Model : ${bestToolModel.model} (emits clean tool calls)`);
}
const bestReasoning = toolModels.find((m) => m.model.includes("think-deeper") || m.model.includes("sol"));
if (bestReasoning) {
  console.log(`  ★ Recommended Reasoning Model   : ${bestReasoning.model} (reasoning + tool calling)`);
}
console.log("================================================================================\n");

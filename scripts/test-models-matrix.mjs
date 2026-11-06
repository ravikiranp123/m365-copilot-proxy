#!/usr/bin/env node
/**
 * test-models-matrix.mjs
 *
 * Tests models served by an OpenAI-compatible endpoint (<url>/v1/models).
 *
 * Mode 1 (default):
 *   Fetches /v1/models from <url>, then sends a tool-invoking prompt to each model
 *   sequentially, verifying if a valid tool call is returned.
 *
 * Mode 2 (optional via --e2e or --e2e-model=<id>):
 *   Creates a temp folder in /tmp/, runs `omp` in non-interactive CLI mode (`omp -p`)
 *   asking the specified model to bootstrap and build a medium React app using CLI tools.
 *   Afterwards, runs another `omp` evaluation step with `google-antigravity/gemini-3.8-flash`
 *   to grade project completeness, code quality, and working build artifacts.
 *
 * Usage:
 *   node scripts/test-models-matrix.mjs <url> [options]
 *
 * Options:
 *   --url=<url>            Target baseUrl (e.g. http://127.0.0.1:4141)
 *   --api-key=<key>        Bearer token / API key (default: empty or M365 token)
 *   --models=<a,b>         Comma-separated list of models to restrict to
 *   --timeout=<sec>        Per-request HTTP timeout in seconds (default: 60)
 *   --gap=<sec>            Cooldown delay between model calls in seconds (default: 3)
 *   --e2e                  Run full OMP React build + Gemini eval on first model or --e2e-model
 *   --e2e-model=<id>       Specify target model for the OMP React build test
 *   --eval-model=<id>      Evaluation model (default: google-antigravity/gemini-3.8-flash)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- CLI Argument Parsing ---------------------------------------------------

const argv = process.argv.slice(2);

function getArgValue(prefix) {
  const match = argv.find((a) => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const positionalUrl = argv.find((a) => !a.startsWith("-"));
const rawUrl = getArgValue("--url=") || positionalUrl || process.env.OPENAI_BASE_URL || "http://127.0.0.1:4141";
const baseUrl = rawUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

const apiKey = getArgValue("--api-key=") || process.env.OPENAI_API_KEY || "";
const modelsFilter = getArgValue("--models=")
  ? new Set(getArgValue("--models=").split(",").map((m) => m.trim()).filter(Boolean))
  : null;

const requestTimeoutSec = Number(getArgValue("--timeout=") || "60");
const gapSec = Number(getArgValue("--gap=") || "3");

const runE2E = argv.includes("--e2e") || argv.some((a) => a.startsWith("--e2e-model="));
const specifiedE2EModel = getArgValue("--e2e-model=");
const evalModel = getArgValue("--eval-model=") || "google-antigravity/gemini-3.8-flash";

const DEFAULT_TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a command in the local terminal shell.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the local workspace filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative file path." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a command in the local terminal shell.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
        },
        required: ["command"],
      },
    },
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Fetch Models -----------------------------------------------------------

async function fetchAvailableModels() {
  const url = `${baseUrl}/v1/models`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  console.log(`[matrix] Querying models from: ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
    return list;
  } finally {
    clearTimeout(timer);
  }
}

// --- Test Single Model for Tool Call ----------------------------------------

async function testModelToolCall(modelId) {
  const { writeFileSync } = await import("node:fs");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  const execFileAsync = promisify(execFile);

  const challenge = Math.random().toString(36).slice(2, 14).toUpperCase();
  const challengeFile = `/tmp/matrix-${challenge}.txt`;
  writeFileSync(challengeFile, challenge + "\n");

  const url = `${baseUrl}/v1/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  console.log(`    challenge: ${challenge}`);
  console.log(`    file:      ${challengeFile}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutSec * 1000);
  const t0 = Date.now();

  try {
    const firstPayload = {
      model: modelId,
      stream: false,
      messages: [
        {
          role: "user",
          content:
            `Use the bash tool to read ${challengeFile}. After receiving the tool result, reply with the exact code from the file and nothing else.`,
        },
      ],
      tools: DEFAULT_TOOL_DEFS,
    };

    const firstRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(firstPayload),
      signal: controller.signal,
    });

    if (!firstRes.ok) {
      const errText = await firstRes.text();
      return {
        ok: false,
        elapsed: ((Date.now() - t0) / 1000).toFixed(1),
        status: firstRes.status,
        error: `HTTP ${firstRes.status}: ${errText.slice(0, 200)}`,
      };
    }

    const firstJson = await firstRes.json();
    const message = firstJson.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.[0];

    if (!toolCall) {
      return {
        ok: false,
        elapsed: ((Date.now() - t0) / 1000).toFixed(1),
        error: "No tool call emitted",
        contentSnippet: String(message?.content || "").slice(0, 160),
      };
    }

    const toolName = toolCall.function?.name;
    console.log(`    tool:      ${toolName}`);

    if (toolName !== "bash") {
      return {
        ok: false,
        elapsed: ((Date.now() - t0) / 1000).toFixed(1),
        error: `Expected bash tool, got ${toolName}`,
      };
    }

    let args;
    try {
      args = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
      return {
        ok: false,
        elapsed: ((Date.now() - t0) / 1000).toFixed(1),
        error: "Invalid tool arguments JSON",
      };
    }

    const command = args.command || "";
    console.log(`    command:   ${command}`);

    const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
      timeout: requestTimeoutSec * 1000,
      maxBuffer: 1024 * 1024,
    });

    const toolOutput = [stdout, stderr].filter(Boolean).join("");
    console.log(`    output:    ${JSON.stringify(toolOutput.trim())}`);

    const secondPayload = {
      model: modelId,
      stream: false,
      messages: [
        firstPayload.messages[0],
        message,
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolOutput,
        },
      ],
    };

    const secondRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(secondPayload),
      signal: controller.signal,
    });

    if (!secondRes.ok) {
      const errText = await secondRes.text();
      return {
        ok: false,
        elapsed: ((Date.now() - t0) / 1000).toFixed(1),
        status: secondRes.status,
        error: `Follow-up HTTP ${secondRes.status}: ${errText.slice(0, 200)}`,
      };
    }

    const secondJson = await secondRes.json();
    const finalText = String(
      secondJson.choices?.[0]?.message?.content || ""
    ).trim();

    console.log(`    answer:    ${JSON.stringify(finalText)}`);

    return {
      ok: finalText === challenge,
      elapsed: ((Date.now() - t0) / 1000).toFixed(1),
      tool: toolName,
      expected: challenge,
      actual: finalText,
      error:
        finalText === challenge
          ? undefined
          : "Incorrect verification code returned",
    };
  } catch (err) {
    return {
      ok: false,
      elapsed: ((Date.now() - t0) / 1000).toFixed(1),
      error:
        err.name === "AbortError"
          ? `Timeout after ${requestTimeoutSec}s`
          : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- Mode 2: E2E React App Builder & Evaluation -----------------------------

function runOmpAppGenerationAndEval(targetModel) {
  console.log(`\n============================================================`);
  console.log(`[E2E] Bootstrapping React app test using model: "${targetModel}"`);
  console.log(`============================================================\n`);

  const tempDir = mkdtempSync(join(tmpdir(), "omp-matrix-react-"));
  console.log(`[E2E] Working directory: ${tempDir}`);

  const reactPrompt = [
    "You are bootstrapping a modern React production application in this empty working directory.",
    "Requirements:",
    "1. Initialize a modern React + TypeScript + Vite project (or minimal Bun/Vite bundle) in the current directory.",
    "2. Build a medium-sized Kanban Task Management Board with:",
    "   - Multiple columns: Backlog, In Progress, Review, Done",
    "   - Add, edit, delete tasks with priority tags (Low/Medium/High/Urgent) and due dates",
    "   - Column filtering, keyword search, and local state persistence (localStorage)",
    "   - Clean modular component structure (Column, Card, Modal/Form, SearchBar) with stylish CSS styling",
    "3. Install necessary dependencies, ensure all files are cleanly written, and verify the production build succeeds (`npm run build` or `vite build`).",
    "Execute all steps with shell commands and tool calls.",
  ].join("\n");

  console.log(`[E2E] Step 1: Launching OMP CLI to build the app...`);
  const ompBuildStart = Date.now();

  const buildResult = spawnSync(
    "omp",
    [
      "-p",
      `--model=${targetModel}`,
      `--cwd=${tempDir}`,
      "--auto-approve",
      reactPrompt,
    ],
    {
      stdio: "inherit",
      encoding: "utf-8",
      env: {
        ...process.env,
        OPENAI_BASE_URL: `${baseUrl}/v1`,
        ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
      },
    },
  );

  const buildDuration = ((Date.now() - ompBuildStart) / 1000).toFixed(1);
  console.log(`\n[E2E] OMP build run finished in ${buildDuration}s (exit code: ${buildResult.status})`);

  // Inspect generated directory tree
  const filesFound = [];
  try {
    function walk(dir, rel = "") {
      for (const item of readdirSync(dir)) {
        if (item === "node_modules" || item === ".git") continue;
        const sub = join(dir, item);
        const relPath = rel ? `${rel}/${item}` : item;
        const st = statSync(sub);
        if (st.isDirectory()) {
          walk(sub, relPath);
        } else {
          filesFound.push(relPath);
        }
      }
    }
    walk(tempDir);
  } catch (err) {
    console.error(`[E2E] Error scanning tempDir: ${err.message}`);
  }

  console.log(`[E2E] Found ${filesFound.length} created files in project:`);
  console.log(filesFound.slice(0, 20).map((f) => `  - ${f}`).join("\n"));
  if (filesFound.length > 20) console.log(`  ... and ${filesFound.length - 20} more`);
  console.log(`\n[E2E] Step 2: Evaluating project quality with "${evalModel}"...`);

  const evalPrompt = [
    `Evaluate the generated React project located in ${tempDir}.`,
    "Inspect the directory structure, package.json, source files (App.tsx, components, state management), and build output (dist/ or build/).",
    "Provide a structured assessment covering:",
    "1. Completeness: Were all requested Kanban features implemented?",
    "2. Code Quality & Modularity: Are TypeScript types, component architecture, and styling clean?",
    "3. Build Status: Did `npm run build` or the bundler produce working artifacts?",
    "4. Final Score: 1-10 with a brief 2-sentence rationale.",
  ].join("\n");

  const evalStart = Date.now();
  const evalResult = spawnSync(
    "omp",
    [
      "-p",
      `--model=${evalModel}`,
      `--cwd=${tempDir}`,
      "--auto-approve",
      evalPrompt,
    ],
    {
      stdio: "inherit",
      encoding: "utf-8",
      env: process.env,
    },
  );

  const evalDuration = ((Date.now() - evalStart) / 1000).toFixed(1);
  console.log(`\n[E2E] Evaluation completed in ${evalDuration}s (exit code: ${evalResult.status})`);

  console.log(`\n[E2E] Artifacts preserved at: ${tempDir}`);
}

// --- Main Runner ------------------------------------------------------------

async function main() {
  console.log(`=== M365 / OpenAI Model Matrix Tester ===`);
  console.log(`Base URL: ${baseUrl}`);
  if (apiKey) console.log(`API Key:  [configured]`);
  if (modelsFilter) console.log(`Filter:   ${Array.from(modelsFilter).join(", ")}`);

  let allModels = [];
  try {
    allModels = await fetchAvailableModels();
  } catch (err) {
    console.error(`\n[ERROR] Failed to query /v1/models from ${baseUrl}: ${err.message}`);
    process.exit(1);
  }

  // Run only models that don't have a '/' in their ID
  const nonSlashModels = allModels.filter((id) => !id.includes("/"));
  const targetModels = modelsFilter
    ? nonSlashModels.filter((m) => modelsFilter.has(m))
    : nonSlashModels;

  if (targetModels.length === 0) {
    console.warn(`[WARN] No non-slash models match the criteria. Total available: ${allModels.length}`);
    process.exit(0);
  }

  console.log(`Discovered ${allModels.length} models total; testing ${targetModels.length} non-slash models (gap=${gapSec}s, timeout=${requestTimeoutSec}s)...\n`);

  const results = [];

  for (let i = 0; i < targetModels.length; i++) {
    const model = targetModels[i];
    process.stdout.write(`[${i + 1}/${targetModels.length}] ${model.padEnd(28)} `);

    const res = await testModelToolCall(model);
    results.push({ model, ...res });

    if (res.ok) {
      console.log(`\x1b[32mPASS\x1b[0m (${res.elapsed}s) -> tool: ${res.tool}(${res.args || ""})`);
    } else {
      console.log(`\x1b[31mFAIL\x1b[0m (${res.elapsed}s) -> ${res.error || "error"}${res.contentSnippet ? ` [Snippet: "${res.contentSnippet}"]` : ""}`);
    }

    if (i < targetModels.length - 1 && gapSec > 0) {
      await sleep(gapSec * 1000);
    }
  }

  // Summary Table
  console.log(`\n================ Summary Table ================`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`Passed: ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(0)}%)\n`);

  for (const r of results) {
    const mark = r.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    const detail = r.ok ? `tool: ${r.tool}` : `${r.error || "failed"}${r.expected ? ` expected=${r.expected} actual=${r.actual}` : ""}`;
    console.log(` ${mark} ${r.model.padEnd(28)} [${r.elapsed}s] ${detail}`);
  }

  // Optional E2E React App Builder & Evaluation
  if (runE2E) {
    const e2eTarget = specifiedE2EModel || (results.find((r) => r.ok)?.model || targetModels[0]);
    runOmpAppGenerationAndEval(e2eTarget);
  }
}

main().catch((err) => {
  console.error("Unhandled fatal error:", err);
  process.exit(1);
});

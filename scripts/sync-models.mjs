#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, modify, applyEdits, printParseErrorCode } from "jsonc-parser";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function requireObject(value, label) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function parseOptions(args, env = process.env) {
  const options = { client: "pi", port: env.PORT || "4141", offline: false, quiet: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--client", "--port", "--target"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else if (arg === "--local") options.local = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--quiet" || arg === "-q") options.quiet = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["pi", "opencode"].includes(options.client)) throw new Error("--client must be pi or opencode");
  if (!/^\d+$/.test(String(options.port)) || Number(options.port) < 1 || Number(options.port) > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  if (options.local && options.target) throw new Error("--local and --target cannot be combined");
  return options;
}

export function defaultTarget(options, env = process.env, home = homedir()) {
  if (options.target) return resolve(options.target);
  if (options.client === "pi") {
    return options.local
      ? join(repoRoot, ".pi-local/.pi/agent/models.json")
      : join(home, ".pi/agent/models.json");
  }
  const directory = options.local ? repoRoot : join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  const json = join(directory, "opencode.json");
  const jsonc = join(directory, "opencode.jsonc");
  if (existsSync(json) && existsSync(jsonc)) {
    throw new Error(`Both ${json} and ${jsonc} exist; select one with --target`);
  }
  return existsSync(jsonc) ? jsonc : json;
}

export function normalizeModels(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("Model list must be a non-empty array");
  const seen = new Set();
  return values.map((value) => {
    const model = typeof value === "string" ? { id: value } : value;
    if (!object(model) || typeof model.id !== "string" || !model.id.trim() || model.id !== model.id.trim()) {
      throw new Error("Every model must have a non-empty string ID without surrounding whitespace");
    }
    if (seen.has(model.id)) throw new Error(`Duplicate model ID: ${model.id}`);
    seen.add(model.id);
    for (const key of ["context_window", "max_context_length", "max_input_tokens", "max_output_tokens"]) {
      if (model[key] !== undefined && (!Number.isSafeInteger(model[key]) || model[key] <= 0)) {
        throw new Error(`Invalid ${key} for ${model.id}`);
      }
    }
    return model;
  });
}

export function formatModelName(id) {
  const special = {
    "m365-copilot": "M365 Copilot",
    auto: "Copilot Auto",
    quick: "Copilot Quick",
    "think-deeper": "Copilot Think Deeper",
  };
  return (Object.hasOwn(special, id) ? special[id] : undefined) || id.replace(/^gpt-(\d+(?:\.\d+)*)/i, "GPT_$1")
    .split("-").map((word) => word.startsWith("GPT_") ? word.replace("_", "-") : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function updateConfig(content, values, options) {
  const models = normalizeModels(values);
  const errors = [];
  const root = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`Invalid configuration: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}; refusing to overwrite`);
  requireObject(root, "Configuration");
  const key = options.client === "opencode" ? "provider" : "providers";
  const providers = root[key] === undefined ? {} : requireObject(root[key], key);
  const existing = providers.m365 === undefined ? {} : requireObject(providers.m365, `${key}.m365`);
  const base = `http://127.0.0.1:${options.port}/v1`;
  let provider;
  if (options.client === "opencode") {
    const oldOptions = existing.options === undefined ? {} : requireObject(existing.options, "m365.options");
    const oldModels = existing.models === undefined ? {} : requireObject(existing.models, "m365.models");
    const entries = models.map((model) => {
      const old = Object.hasOwn(oldModels, model.id) ? requireObject(oldModels[model.id], `Model ${model.id}`) : {};
      const oldLimit = old.limit === undefined ? {} : requireObject(old.limit, `Model ${model.id}.limit`);
      const context = model.context_window ?? model.max_context_length ?? model.max_input_tokens;
      const output = model.max_output_tokens;
      const limit = {
        ...(context === undefined ? {} : { context }),
        ...(output === undefined ? {} : { output }),
        ...oldLimit,
      };
      return [model.id, {
        name: formatModelName(model.id),
        tool_call: true,
        ...old,
        ...(Object.keys(limit).length ? { limit } : {}),
      }];
    });
    provider = {
      ...existing,
      name: existing.name ?? "M365 Copilot",
      npm: existing.npm ?? "@ai-sdk/openai-compatible",
      options: { ...oldOptions, baseURL: oldOptions.baseURL ?? base, apiKey: oldOptions.apiKey ?? "m365" },
      models: Object.fromEntries(entries),
    };
  } else {
    const oldModels = existing.models === undefined ? [] : existing.models;
    if (!Array.isArray(oldModels)) throw new Error("Pi m365.models must be an array");
    const byId = new Map(oldModels.map((model) => {
      requireObject(model, "Pi model");
      return [model.id, model];
    }));
    provider = {
      ...existing,
      baseUrl: existing.baseUrl ?? base,
      api: existing.api ?? "openai-completions",
      apiKey: existing.apiKey ?? "m365",
      compat: existing.compat ?? {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
      },
      models: models.map(({ id }) => ({ ...byId.get(id), id, name: byId.get(id)?.name ?? formatModelName(id) })),
    };
  }
  let result = content;
  const set = (path, value) => {
    result = applyEdits(result, modify(result, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: content.includes("\r\n") ? "\r\n" : "\n" },
    }));
  };
  // Edit only owned fields, preserving unrelated settings and surrounding comments.
  for (const [field, value] of Object.entries(provider)) {
    if (field === "models" || existing[field] === undefined) set([key, "m365", field], value);
    else if (field === "options") {
      for (const [option, optionValue] of Object.entries(value)) {
        if (existing.options?.[option] === undefined) set([key, "m365", "options", option], optionValue);
      }
    }
  }
  return result.endsWith("\n") ? result : result + "\n";
}

export async function getModels(options) {
  if (!options.offline) {
    const url = `http://127.0.0.1:${options.port}/v1/models`;
    let payload;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
    } catch (error) {
      if (!options.quiet) console.log(`[sync-models] ${url}: ${error.message}; using built core`);
    }
    // Invalid successful responses must not silently replace the advertised catalogue.
    if (payload !== undefined) return normalizeModels(payload?.data);
  }
  const core = await import("../packages/core/dist/index.mjs");
  const context = Number(process.env.M365_CONTEXT_WINDOW) || 1_000_000;
  const output = Number(process.env.M365_MAX_OUTPUT_TOKENS) || 1_000_000;
  return normalizeModels(core.getAvailableModels().map((id) => ({
    id, context_window: context, max_output_tokens: output,
  })));
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log(`Usage: node scripts/sync-pi-models.mjs [options]
  --client pi|opencode  Client configuration format (default: pi)
  --port <port>         Proxy port (default: $PORT or 4141)
  --target <path>       Explicit configuration file
  --local               Pi: .pi-local/.pi/agent/models.json; OpenCode: ./opencode.json[c]
  --offline             Read the built core catalogue without HTTP
  --quiet, -q           Suppress informational logs
  --help, -h            Show help

OpenCode defaults to $XDG_CONFIG_HOME/opencode/opencode.json[c] or
~/.config/opencode/opencode.json[c]. Existing model overrides are preserved.
Models no longer advertised are removed from the m365 catalogue.
JSONC comments outside the replaced model catalogue are preserved.
Existing provider URLs are preserved; --port controls discovery and new URLs.`);
    return;
  }
  const target = defaultTarget(options);
  const existed = existsSync(target);
  const content = existed ? readFileSync(target, "utf8") : "{}\n";
  // Validate and prepare before writing anything.
  const models = await getModels(options);
  const updated = updateConfig(content, models, options);
  if (updated === content) {
    if (!options.quiet) console.log(`[sync-models] ${target} is already current`);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, updated, { encoding: "utf8", mode: existed ? statSync(target).mode & 0o777 : 0o600, flag: "wx" });
    if (existed && readFileSync(target, "utf8") !== content) throw new Error("Configuration changed during synchronization; retry");
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  if (!options.quiet) console.log(`[sync-models] Updated ${models.length} ${options.client} models in ${target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[sync-models] ${error.message}`); process.exitCode = 1; });
}

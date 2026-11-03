#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

const args = process.argv.slice(2);

if (!args.length) {
  console.error(`
Usage:
  node scripts/sync-omp-models.mjs m365=http://127.0.0.1:4141

Point it at the gateway port: /v1/models now advertises every profile's
models as <profile>/<model> (ato/gpt-6.1-sol, default/gpt-6.1-sol, ...).
`pnpm profiles sync` writes the pi catalog and alias map instead.
`);
  process.exit(1);
}

const modelsFile = path.join(os.homedir(), ".omp", "agent", "models.yml");

const existing = fs.existsSync(modelsFile)
  ? YAML.parse(fs.readFileSync(modelsFile, "utf8"))
  : {};

existing.providers ??= {};

for (const arg of args) {
  const [providerName, baseUrl] = arg.split("=");

  if (!providerName || !baseUrl) {
    console.error(`invalid provider spec: ${arg}`);
    continue;
  }

  const root = baseUrl.replace(/\/$/, "");
  const res = await fetch(`${root}/v1/models`);

  if (!res.ok) {
    throw new Error(`${providerName}: ${res.status} ${res.statusText}`);
  }

  const payload = await res.json();

  const allIds = (payload.data ?? []).map((m) => m.id);
  // The proxy lists bare IDs plus <profile>/<model> copies. Prefer the
  // namespaced IDs so one provider addresses every account.
  const namespaced = allIds.filter((id) => id.includes("/"));
  const models = (namespaced.length ? namespaced : allIds)
    .sort()
    .map((id) => ({
      id,
      input: ["text", "image"],
      reasoning:
        id.includes("think-deeper") ||
        id.includes("sol") ||
        id === "auto" ||
        id === "m365-copilot",
      thinkingLevelMap: {
        xhigh: "xhigh",
      },
    }));

  existing.providers[providerName] = {
    baseUrl: `${root}/v1`,
    api: "openai-completions",
    apiKey: "dummy",
    models,
  };

  console.log(`synced ${providerName}: ${models.length} models`);
}

fs.writeFileSync(modelsFile, YAML.stringify(existing));

console.log(`updated ${modelsFile}`);

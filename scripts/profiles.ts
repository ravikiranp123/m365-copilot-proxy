#!/usr/bin/env tsx
/**
 * Account-profile manager.
 *
 * One M365 identity per proxy process: credentials, MSAL cache, agent and log
 * all live in the profile's data dir. Clients address a profile with
 * `<profile>/<model>` (or `m365/<profile>/<model>`) against any proxy port;
 * the proxy forwards to the port that owns that profile.
 *
 * Usage:
 *   pnpm profiles list
 *   pnpm profiles add h2564 --port 4143 --agent T_... --secrets secrets.h2564.json
 *   pnpm profiles start h2564
 *   pnpm profiles start all
 *   pnpm profiles status
 *   pnpm profiles stop all
 *   pnpm profiles sync
 *   pnpm profiles env h2564
 */
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";

import {
  DEFAULT_PROFILES_FILE,
  loadProfileRegistry,
  profilesFilePath,
  resolveDataDir,
  resolveDefaultKeyword,
  type ProfileConfig,
  type ProfileRegistry,
} from "../packages/proxy-lib/src/profiles.js";

const ROOT = process.cwd();
const PROXY_ENTRY = join(ROOT, "packages/proxy/bin/m365-proxy.mjs");
const BUILT_ENTRY = join(ROOT, "packages/proxy/.output/server/index.mjs");

type Args = { _: string[]; flags: Record<string, string | boolean | string[]> };

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      _.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      const prev = flags[key];
      flags[key] = prev === undefined ? next : [...(Array.isArray(prev) ? prev : [String(prev)]), next];
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { _, flags };
}

function flag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

function flagAll(args: Args, name: string): string[] {
  const v = args.flags[name];
  if (Array.isArray(v)) return v;
  return typeof v === "string" ? [v] : [];
}

function boolFlag(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function registryPath(): string {
  return profilesFilePath();
}

function readRegistry(required = true): ProfileRegistry {
  const path = registryPath();
  if (!existsSync(path)) {
    if (!required) return { profiles: {} };
    fail(
      `no profile registry at ${path}.\n` +
        `Create one with \`pnpm profiles add <name> --port <port>\` (a template lives in ${DEFAULT_PROFILES_FILE.replace(/\.json$/, ".example.json")}).`,
    );
  }
  return loadProfileRegistry(path);
}

function writeRegistry(registry: ProfileRegistry): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  const body = { $schema: "./profiles.schema.json", ...registry, profiles: registry.profiles };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

function dataDirOf(name: string, profile: ProfileConfig): string {
  return resolveDataDir(profile.dataDir ?? defaultDataDir(name));
}

function defaultDataDir(name: string): string {
  // Never inside the repo by default: credentials/MSAL-cache/logs are sensitive
  // and an in-repo dir gets walked by anything scanning the project tree (editors,
  // LLM tools, `git add -A` typos). No special case for any particular profile
  // name (not even the configured default) — config/profiles.json already sets
  // an explicit `dataDir` for anything that predates this; this is only the
  // fallback for `pnpm profiles add <name>` with no --data-dir.
  return `~/.config/opencode-m365/profiles/${name}`;
}

function pidFile(name: string, profile: ProfileConfig): string {
  return join(dataDirOf(name, profile), "proxy.pid");
}

function logFile(name: string, profile: ProfileConfig): string {
  return join(dataDirOf(name, profile), "proxy.log");
}

function debugLogFile(name: string, profile: ProfileConfig): string {
  return join(dataDirOf(name, profile), "debug.log");
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * The proxy may have been started before profiles existed (or by another
 * shell). Find the listener so `list`/`stop`/`start` can adopt it instead of
 * claiming nothing is running. Returns undefined when lsof is unavailable.
 */
function findPidOnPort(port: number): number | undefined {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const pid = Number(out.split("\n")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function effectivePid(name: string, profile: ProfileConfig): number | undefined {
  const pid = readPid(pidFile(name, profile));
  if (alive(pid)) return pid;
  const found = findPidOnPort(profile.port);
  if (found) {
    try {
      writeFileSync(pidFile(name, profile), String(found));
    } catch {
      /* best effort */
    }
  }
  return found;
}

async function healthy(port: number, timeoutMs = 1200): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function hasSecrets(dir: string): boolean {
  return existsSync(join(dir, "secrets.json"));
}

function nextPort(registry: ProfileRegistry): number {
  const ports = Object.values(registry.profiles)
    .map((p) => p.port)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  return Math.max(4141, ...ports) + 1;
}

function validName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

// --- commands ---------------------------------------------------------------

async function cmdList(): Promise<void> {
  const registry = readRegistry();
  const names = Object.keys(registry.profiles);
  if (names.length === 0) {
    console.log("No profiles. Add one with `pnpm profiles add <name> --port <port>`.");
    return;
  }
  const rows: Array<{
    name: string;
    port: string;
    running: string;
    agent: string;
    secrets: string;
    dataDir: string;
  }> = [];
  for (const name of names) {
    const p = registry.profiles[name];
    const dir = dataDirOf(name, p);
    const pid = effectivePid(name, p);
    rows.push({
      name,
      port: String(p.port ?? "-"),
      running: pid ? `yes (pid ${pid})` : (await healthy(p.port)) ? "yes (unmanaged)" : "no",
      agent: p.env?.M365_AGENT_ID ? "yes" : "-",
      secrets: hasSecrets(dir) ? "yes" : "MISSING",
      dataDir: dir,
    });
  }
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    port: 4,
    running: Math.max(7, ...rows.map((r) => r.running.length)),
    agent: 5,
    secrets: 7,
  };
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    `${pad("NAME", widths.name)}  ${pad("PORT", widths.port)}  ${pad("RUNNING", widths.running)}  ${pad("AGENT", widths.agent)}  ${pad("SECRETS", widths.secrets)}  DATA DIR`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.name, widths.name)}  ${pad(r.port, widths.port)}  ${pad(r.running, widths.running)}  ${pad(r.agent, widths.agent)}  ${pad(r.secrets, widths.secrets)}  ${r.dataDir}`,
    );
  }
}

function cmdAdd(args: Args): void {
  const name = args._[1];
  if (!name) fail("usage: pnpm profiles add <name> [--port N] [--agent T_...] [--secrets path] [--data-dir path]");
  if (!validName(name)) fail(`invalid profile name "${name}" (use letters, digits, dot, dash, underscore)`);

  const registry = readRegistry(false);
  if (registry.profiles[name]) fail(`profile "${name}" already exists`);

  const port = Number(flag(args, "port") ?? nextPort(registry));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port "${flag(args, "port")}"`);
  for (const [other, p] of Object.entries(registry.profiles)) {
    if (p.port === port) fail(`port ${port} is already used by profile "${other}"`);
  }

  const dataDir = flag(args, "data-dir") ?? defaultDataDir(name);
  const absDataDir = resolveDataDir(dataDir);
  mkdirSync(absDataDir, { recursive: true });

  // Credentials: inline --email/--password, or --secrets, or
  // secrets.<name>.json / secrets.json.
  const target = join(absDataDir, "secrets.json");
  const email = flag(args, "email");
  const password = flag(args, "password");
  const mfaSecret = flag(args, "mfa-secret");
  if (email || password) {
    if (!email || !password) fail("--email and --password must be given together");
    writeFileSync(
      target,
      `${JSON.stringify({ email, password, mfaSecret: mfaSecret ?? "" }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(`wrote credentials for ${email} -> ${target}`);
  } else if (!existsSync(target)) {
    const secretsArg = flag(args, "secrets");
    const candidates = secretsArg
      ? [resolve(ROOT, secretsArg)]
      : [join(ROOT, `secrets.${name}.json`), join(ROOT, "secrets.json")];
    const source = candidates.find((c) => existsSync(c));
    if (source) {
      copyFileSync(source, target);
      console.log(`copied credentials ${source} -> ${target}`);
    }
  }

  const env: Record<string, string> = {};
  const agent = flag(args, "agent");
  if (agent) env.M365_AGENT_ID = agent;
  const framing = flag(args, "framing");
  if (framing) env.M365_FRAMING_VARIANT = framing;

  registry.profiles[name] = {
    port,
    dataDir,
    ...(Object.keys(env).length ? { env } : {}),
    ...(flagAll(args, "model").length ? { models: flagAll(args, "model") } : {}),
    ...(flag(args, "notes") ? { notes: flag(args, "notes") } : {}),
  };
  writeRegistry(registry);

  console.log(`added profile "${name}"`);
  console.log(`  port     ${port}`);
  console.log(`  data dir ${absDataDir}`);
  console.log(`  agent    ${env.M365_AGENT_ID ?? "(none — auto-provisioned)"}`);
  console.log(`  secrets  ${hasSecrets(absDataDir) ? "ok" : "MISSING — put credentials at " + join(absDataDir, "secrets.json")}`);
  console.log("");
  console.log(`Next: pnpm build && pnpm profiles start ${name}`);
  console.log(`Then sync: pnpm profiles sync`);
}

function cmdRm(args: Args): void {
  let name = args._[1];
  if (!name) fail("usage: pnpm profiles rm <name> [--purge]");
  const registry = readRegistry();
  name = resolveDefaultKeyword(name, registry);
  const profile = registry.profiles[name];
  if (!profile) fail(`unknown profile "${name}"`);

  const pid = readPid(pidFile(name, profile));
  if (alive(pid)) fail(`profile "${name}" is running (pid ${pid}); stop it first`);

  delete registry.profiles[name];
  writeRegistry(registry);
  console.log(`removed profile "${name}"`);

  if (boolFlag(args, "purge")) {
    const dir = dataDirOf(name, profile);
    if (dir === homedir() || dir === "/") fail(`refusing to purge ${dir}`);
    rmSync(dir, { recursive: true, force: true });
    console.log(`purged ${dir}`);
  } else {
    console.log(`kept ${dataDirOf(name, profile)} (use --purge to delete credentials and logs)`);
  }
}

function startEnv(name: string, profile: ProfileConfig): Record<string, string> {
  const dir = dataDirOf(name, profile);
  mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  Object.assign(env, profile.env ?? {});

  env.PORT = String(profile.port);
  env.NITRO_PORT = String(profile.port);
  env.M365_PROFILE = name;
  // Absolute paths: the log module resolves relative M365_LOG_FILE against the
  // global config dir, so a profile's log must be pinned to its own data dir.
  env.M365_LOG_FILE = debugLogFile(name, profile);
  env.M365_FRAME_DIR = join(dir, "frames");
  env.M365_SECRETS_FILE = join(dir, "secrets.json");
  env.M365_CACHE_FILE = join(dir, "msal-cache.json");
  env.M365_BROWSER_PROFILE = join(dir, "browser-profile");

  // `.env` must not leak another profile's agent into an agent-less profile.
  if (!profile.env?.M365_AGENT_ID) delete env.M365_AGENT_ID;

  return env;
}

async function cmdStart(args: Args): Promise<void> {
  const target = args._[1];
  if (!target) fail("usage: pnpm profiles start <name|all> [--foreground]");
  const registry = readRegistry();
  const names = target === "all" ? Object.keys(registry.profiles) : [target];
  if (names.length === 0) fail("no profiles configured");

  const ports = new Map<number, string>();
  for (const [name, profile] of Object.entries(registry.profiles)) {
    if (!Number.isInteger(profile.port)) fail(`profile "${name}" has no valid port`);
    const other = ports.get(profile.port);
    if (other) fail(`profiles "${other}" and "${name}" both use port ${profile.port}`);
    ports.set(profile.port, name);
  }

  if (!existsSync(BUILT_ENTRY)) {
    fail(`missing ${BUILT_ENTRY}. Run \`pnpm build\` first.`);
  }

  for (let name of names) {
    name = resolveDefaultKeyword(name, registry);
    const profile = registry.profiles[name];
    if (!profile) fail(`unknown profile "${name}"`);
    if (!Number.isInteger(profile.port)) fail(`profile "${name}" has no valid port`);

    const pidPath = pidFile(name, profile);
    const running = effectivePid(name, profile);
    if (running) {
      console.log(`${name}: already running (pid ${running})`);
      continue;
    }
    if (await healthy(profile.port)) {
      fail(`${name}: port ${profile.port} is already serving /health but its pid could not be found; stop it manually`);
    }

    const dir = dataDirOf(name, profile);
    if (!hasSecrets(dir)) {
      console.warn(`${name}: warning — no ${join(dir, "secrets.json")}; auth will fail unless the MSAL cache is warm`);
    }

    const env = startEnv(name, profile);
    const out = logFile(name, profile);

    if (boolFlag(args, "foreground")) {
      const child = spawn(process.execPath, ["--env-file-if-exists=.env", PROXY_ENTRY], {
        cwd: ROOT,
        env,
        stdio: "inherit",
      });
      writeFileSync(pidPath, String(child.pid));
      const code = await new Promise<number | null>((resolveExit) => child.on("exit", resolveExit));
      try {
        rmSync(pidPath, { force: true });
      } catch {
        /* best effort */
      }
      process.exitCode = code ?? 0;
      continue;
    }

    const fd = openSync(out, "a");
    const child = spawn(process.execPath, ["--env-file-if-exists=.env", PROXY_ENTRY], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    child.unref();
    writeFileSync(pidPath, String(child.pid));
    console.log(
      `${name}: started pid ${child.pid} on port ${profile.port}\n  log   ${debugLogFile(name, profile)}\n  stdout ${out}`,
    );
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

async function cmdStop(args: Args): Promise<void> {
  const target = args._[1];
  if (!target) fail("usage: pnpm profiles stop <name|all>");
  const registry = readRegistry();
  const names = target === "all" ? Object.keys(registry.profiles) : [target];
  for (let name of names) {
    name = resolveDefaultKeyword(name, registry);
    const profile = registry.profiles[name];
    if (!profile) fail(`unknown profile "${name}"`);
    const pidPath = pidFile(name, profile);
    const pid = effectivePid(name, profile);
    if (!alive(pid)) {
      console.log(`${name}: not running`);
      try {
        rmSync(pidPath, { force: true });
      } catch {
        /* best effort */
      }
      continue;
    }
    process.kill(pid!, "SIGTERM");
    if (await waitForExit(pid!, 8000)) {
      console.log(`${name}: stopped (pid ${pid})`);
    } else {
      // A proxy with an in-flight stream or a throttle wait may ignore
      // SIGTERM's graceful shutdown; force it rather than leave a zombie on
      // the port.
      console.warn(`${name}: pid ${pid} did not exit within 8s — sending SIGKILL`);
      try {
        process.kill(pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
      await waitForExit(pid!, 2000);
    }
    try {
      rmSync(pidPath, { force: true });
    } catch {
      /* best effort */
    }
  }
}

async function cmdStatus(): Promise<void> {
  const registry = readRegistry();
  const names = Object.keys(registry.profiles);
  if (names.length === 0) {
    console.log("No profiles.");
    return;
  }
  for (let name of names) {
    name = resolveDefaultKeyword(name, registry);
    const profile = registry.profiles[name];
    const pid = effectivePid(name, profile);
    const up = await healthy(profile.port);
    const state = pid ? `pid ${pid}` : "no process";
    console.log(`${name}: ${up ? "up" : "down"} on :${profile.port} (${state})`);
    if (!up && pid) console.log(`  process is alive but /health is not answering — check ${logFile(name, profile)}`);
  }
}

async function modelsFor(name: string, profile: ProfileConfig): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${profile.port}/v1/models`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const payload = (await res.json()) as { data?: Array<{ id: string }> };
  // The route advertises bare IDs plus every profile's namespaced copies; only
  // the bare ones are this profile's own model list.
  const ids = (payload.data ?? []).map((m) => m.id).filter((id) => !id.includes("/"));
  const allow = profile.models?.length ? new Set(profile.models) : null;
  return ids.filter((id) => (allow ? allow.has(id) : true));
}

async function cmdSync(args: Args): Promise<void> {
  const registry = readRegistry();
  const only = flagAll(args, "profile");
  const names = only.length ? only : Object.keys(registry.profiles);

  // One provider per profile/port — never a single shared catalog rebuilt
  // from whichever profiles happen to be running right now. A profile that
  // isn't up during this sync must leave its own previously synced provider
  // entry alone instead of vanishing from it (the bug this replaces).
  const byProfile = new Map<string, { port: number; models: string[] }>();
  const aliases: Record<string, { alias: string; proxy: string; profile: string }> = {};
  let totalModels = 0;

  for (const name of names) {
    const profile = registry.profiles[name];
    if (!profile) {
      console.warn(`skipping unknown profile "${name}"`);
      continue;
    }
    try {
      const models = (await modelsFor(name, profile)).sort();
      const proxy = `http://localhost:${profile.port}`;
      for (const model of models) {
        aliases[`${name}/${model}`] = { alias: model, proxy, profile: name };
      }
      byProfile.set(name, { port: profile.port, models });
      totalModels += models.length;
      console.log(`${name}: ${models.length} models (:${profile.port})`);
    } catch (err: any) {
      console.warn(`${name}: skipped (${err.message}) — is it running? \`pnpm profiles start ${name}\``);
    }
  }

  if (byProfile.size === 0) {
    fail("no running profiles to sync; start one first");
  }

  // Host prefix for each profile's own URL (default: localhost). --gateway
  // may still override it, e.g. --gateway http://192.168.1.5 for a remote
  // host; any port/path on it is ignored since each profile has its own port.
  const host = hostFromGateway(flag(args, "gateway"));

  // pi: a dedicated provider per profile, each pointed straight at that
  // profile's own port. No shared gateway, no namespaced model IDs, nothing
  // to forward. Fully regenerated from the registry every sync.
  const piModels = {
    providers: Object.fromEntries(
      [...byProfile].map(([name, { port, models }]) => [
        `m365-${name}`,
        {
          api: "openai-completions",
          apiKey: "not-needed",
          baseUrl: `${host}:${port}/v1`,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: false,
          },
          models: models.map((model) => ({ id: model, name: `${name}: ${model}` })),
        },
      ]),
    ),
  };
  mkdirSync(join(ROOT, ".pi-local/.pi/agent"), { recursive: true });
  writeFileSync(join(ROOT, ".pi-local/.pi/agent/models.json"), `${JSON.stringify(piModels, null, 2)}\n`);

  writeFileSync(join(ROOT, ".m365-model-aliases.json"), `${JSON.stringify(aliases, null, 2)}\n`);

  console.log("");
  console.log(`wrote ${totalModels} models across ${byProfile.size} provider(s) to .pi-local/.pi/agent/models.json`);
  console.log(`wrote .m365-model-aliases.json`);
  for (const [name, { port, models }] of byProfile) {
    if (models[0]) console.log(`  m365-${name} -> ${host}:${port}/v1 (e.g. ${models[0]})`);
  }

  syncOmp(byProfile, host);
  syncOpencode(byProfile, host);
}

/** Host prefix (protocol + hostname, no port/path) used to build each
 *  profile's own per-port URL. Defaults to localhost; --gateway may override
 *  it with a remote host. Any port/path on the passed value is ignored —
 *  each profile supplies its own port. */
function hostFromGateway(explicit?: string): string {
  if (!explicit) return "http://localhost";
  try {
    const u = new URL(explicit);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return explicit.replace(/\/$/, "");
  }
}

/** One entry shared by the OMP and opencode catalogs: both read a hint for
 *  whether a model is a reasoning model, keyed off the same name patterns
 *  `sync-omp-models.mjs` used to use standalone. */
function isReasoningModel(model: string): boolean {
  return model.includes("think-deeper") || model.includes("sol") || model === "auto" || model === "m365-copilot";
}

/** `~/.omp/agent/models.yml` — one provider per profile (`m365-<profile>`),
 *  each pointed at that profile's own port. Only the profiles synced THIS run
 *  are touched; every other provider key (another profile's, or an unrelated
 *  provider entirely) is left exactly as it was. Supersedes the standalone
 *  sync-omp-models.mjs. */
function syncOmp(byProfile: Map<string, { port: number; models: string[] }>, host: string): void {
  const modelsFile = join(homedir(), ".omp", "agent", "models.yml");
  const existing = existsSync(modelsFile) ? (YAML.parse(readFileSync(modelsFile, "utf8")) ?? {}) : {};
  existing.providers ??= {};

  for (const [name, { port, models }] of byProfile) {
    existing.providers[`m365-${name}`] = {
      baseUrl: `${host}:${port}/v1`,
      api: "openai-completions",
      apiKey: "dummy",
      models: models.map((model) => ({
        id: model,
        input: ["text", "image"],
        reasoning: isReasoningModel(model),
        thinkingLevelMap: { xhigh: "xhigh" },
      })),
    };
  }

  mkdirSync(dirname(modelsFile), { recursive: true });
  writeFileSync(modelsFile, YAML.stringify(existing));
  console.log(`wrote ${byProfile.size} provider(s) to ${modelsFile}`);
}

/** `~/.config/opencode/opencode.json` — one provider per profile
 *  (`m365-<profile>`), each pointed at that profile's own port. Only the
 *  profiles synced THIS run have their provider entry touched; every other
 *  provider key (antigravity, gemini-web, another profile's m365-*, ...) and
 *  any hand-set per-model fields (tool_call, limit) on an id that already
 *  existed are left untouched. A `.backup-<timestamp>` is written first,
 *  matching this file's existing manual-edit convention. */
function syncOpencode(byProfile: Map<string, { port: number; models: string[] }>, host: string): void {
  const configFile = join(homedir(), ".config", "opencode", "opencode.json");
  if (!existsSync(configFile)) {
    console.warn(`skipped opencode sync: ${configFile} not found`);
    return;
  }

  const raw = readFileSync(configFile, "utf8");
  const config = JSON.parse(raw);
  config.provider ??= {};

  for (const [name, { port, models }] of byProfile) {
    const key = `m365-${name}`;
    const prior = config.provider[key]?.models ?? {};

    const modelEntries: Record<string, unknown> = {};
    for (const model of models) {
      // Keep any hand-tuned fields (tool_call, limit, name) for an id that
      // already existed; only add bare defaults for a genuinely new one.
      modelEntries[model] = prior[model] ?? {
        name: `${name}: ${model}`,
        tool_call: true,
        limit: { context: 1_000_000, output: 1_000_000 },
      };
    }

    config.provider[key] = {
      ...config.provider[key],
      name: config.provider[key]?.name ?? `Microsoft 365 Copilot (${name})`,
      npm: config.provider[key]?.npm ?? "@ai-sdk/openai-compatible",
      options: { ...config.provider[key]?.options, apiKey: "dummy", baseURL: `${host}:${port}/v1` },
      models: modelEntries,
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(`${configFile}.backup-${stamp}`, raw);
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`wrote ${byProfile.size} provider(s) to ${configFile} (backup: opencode.json.backup-${stamp})`);
}

function cmdEnv(args: Args): void {
  let name = args._[1];
  if (!name) fail("usage: pnpm profiles env <name>");
  const registry = readRegistry();
  name = resolveDefaultKeyword(name, registry);
  const profile = registry.profiles[name];
  if (!profile) fail(`unknown profile "${name}"`);
  const env = startEnv(name, profile);
  const keys = [
    "PORT",
    "NITRO_PORT",
    "M365_PROFILE",
    "M365_LOG_FILE",
    "M365_FRAME_DIR",
    "M365_SECRETS_FILE",
    "M365_CACHE_FILE",
    "M365_BROWSER_PROFILE",
  ];
  for (const key of keys) console.log(`export ${key}=${JSON.stringify(env[key])}`);
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    console.log(`export ${key}=${JSON.stringify(value)}`);
  }
  if (!profile.env?.M365_AGENT_ID) console.log("unset M365_AGENT_ID");
}

function usage(): void {
  console.log(`Usage: pnpm profiles <command> [args]

Commands:
  list                          Show profiles, ports, liveness and credentials.
  add <name> [options]          Register a profile.
      --port N                  Port for its proxy (default: next free after 4141/4142).
      --agent T_...             Copilot Studio agent id (omit for auto-provisioned).
      --secrets PATH            Copy credentials into the profile's data dir.
      --email / --password      Write credentials inline (with optional --mfa-secret).
      --data-dir PATH           Credentials/cache/log dir (default: .m365-profiles/<name>).
      --framing VARIANT         M365_FRAMING_VARIANT for this profile.
      --model ID                Allow-list a model for catalog sync (repeatable).
  rm <name> [--purge]           Unregister (and optionally delete credentials/logs).
  start <name|all> [--foreground] Start the profile proxy(ies) in the background.
  stop <name|all>               Stop them.
  status                        Health check every profile.
  sync [--gateway URL] [--profile name]  Write one pi/OMP/opencode provider per running profile/port.
  env <name>                    Print the environment the launcher uses.

Model IDs are namespaced per profile: ato/gpt-6.1-sol, h2564/gpt-6.1-sol.
Any proxy port forwards to the profile that owns the prefix, so one base URL
serves every account.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  switch (command) {
    case "list":
    case "ls":
      await cmdList();
      break;
    case "add":
      cmdAdd(args);
      break;
    case "rm":
    case "remove":
      cmdRm(args);
      break;
    case "start":
      await cmdStart(args);
      break;
    case "stop":
      await cmdStop(args);
      break;
    case "status":
      await cmdStatus();
      break;
    case "sync":
      await cmdSync(args);
      break;
    case "env":
      cmdEnv(args);
      break;
    case undefined:
    case "help":
    case "--help":
      usage();
      break;
    default:
      fail(`unknown command "${command}". Run \`pnpm profiles help\`.`);
  }
}

await main();

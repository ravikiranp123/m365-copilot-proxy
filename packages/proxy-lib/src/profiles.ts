import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Account profiles: one M365 identity (credentials + MSAL cache + optional
 * Copilot Studio agent) per proxy process, addressed by a model-ID prefix.
 *
 * `config/profiles.json` is the registry (gitignored; `profiles.example.json`
 * is the committed template). Each entry names the port its proxy listens on,
 * the data dir that holds its credentials/cache/logs, and extra env for the
 * process. Clients address a profile with `<profile>/<model>` (or the older
 * `m365/<profile>/<model>`); the proxy forwards cross-profile requests to the
 * owning port, so one base URL serves every account.
 */
export interface ProfileConfig {
  /** TCP port this profile's proxy listens on. */
  port: number;
  /** Credentials/cache/browser-profile/log dir. `~` is expanded; a relative
   *  path resolves against the repo root (the proxy's cwd). */
  dataDir?: string;
  /** Extra environment for the profile's proxy process, e.g. M365_AGENT_ID,
   *  M365_FRAMING_VARIANT. Values win over `.env` because they are set on the
   *  child process before Node loads the env file. */
  env?: Record<string, string>;
  /** Optional allow-list for catalog sync; absent means "every model the
   *  proxy advertises". */
  models?: string[];
  notes?: string;
}

export interface ProfileRegistry {
  $schema?: string;
  /** Profile name that the CLI's "default" shorthand (`pnpm profiles
   *  start/stop/env default`, `pnpm proxy`) resolves to when no profile is
   *  literally named "default". Lets a renamed profile (e.g. "default" ->
   *  "ato") keep being the one scripts/docs target, by updating this one
   *  value instead of hardcoding the name anywhere in code. */
  defaultProfile?: string;
  profiles: Record<string, ProfileConfig>;
}

/**
 * Resolve the CLI's "default" shorthand to an actual profile name. A profile
 * literally named "default" always wins (back-compat); only when none exists
 * does `registry.defaultProfile` apply. Non-"default" names pass through
 * unchanged. Throws when "default" is requested but unresolvable, so callers
 * can surface the message via their own CLI error convention.
 */
export function resolveDefaultKeyword(name: string, registry: ProfileRegistry): string {
  if (name !== "default" || registry.profiles["default"]) return name;
  const target = registry.defaultProfile;
  if (!target) {
    throw new Error(
      'no profile named "default" and no "defaultProfile" set in the registry — ' +
        'use an explicit profile name, or add "defaultProfile": "<name>"',
    );
  }
  if (!registry.profiles[target]) {
    throw new Error(`"defaultProfile": "${target}" does not match any registered profile`);
  }
  return target;
}

export const DEFAULT_PROFILES_FILE = "config/profiles.json";

/** The profile this process serves. Set by the profile launcher. */
export function localProfileName(): string {
  return process.env.M365_PROFILE?.trim() ?? "";
}

/** Absolute path of the registry file (`M365_PROFILES_FILE` overrides). */
export function profilesFilePath(file?: string): string {
  const chosen = file || process.env.M365_PROFILES_FILE || DEFAULT_PROFILES_FILE;
  return isAbsolute(chosen) ? chosen : resolve(process.cwd(), chosen);
}

/** Load the registry. A missing file is an empty registry so the proxy still
 *  serves bare model IDs when profiles were never configured. */
export function loadProfileRegistry(file?: string): ProfileRegistry {
  const path = profilesFilePath(file);
  if (!existsSync(path)) return { profiles: {} };
  const raw = JSON.parse(readFileSync(path, "utf8")) as ProfileRegistry;
  if (!raw || typeof raw !== "object" || typeof raw.profiles !== "object" || raw.profiles === null) {
    throw new Error(`${path}: expected an object with a "profiles" map`);
  }
  return raw;
}

/** Profile names, local profile included even if it isn't in the file. */
export function profileNames(registry: ProfileRegistry = loadProfileRegistry()): string[] {
  const names = Object.keys(registry.profiles);
  const local = localProfileName();
  if (local && !names.includes(local)) names.push(local);
  return names;
}

/** Expand `~` and resolve a relative data dir against the repo root. */
export function resolveDataDir(dataDir: string): string {
  if (dataDir === "~") return homedir();
  if (dataDir.startsWith("~/")) return join(homedir(), dataDir.slice(2));
  return isAbsolute(dataDir) ? dataDir : resolve(process.cwd(), dataDir);
}

/**
 * Split a profile-prefixed model ID.
 *
 * - `m365/<profile>/<model>` is always split (the explicit legacy form).
 * - `<profile>/<model>` is split only when `<profile>` is a known profile, so a
 *   future model ID that happens to contain a slash is left alone.
 */
export function splitProfileModel(
  model: string,
  names: Iterable<string> = [],
): { profile?: string; model: string } {
  const explicit = /^m365\/([^/]+)\/(.+)$/.exec(model);
  if (explicit) return { profile: explicit[1], model: explicit[2] };

  const bare = /^([^/]+)\/(.+)$/.exec(model);
  if (bare && new Set(names).has(bare[1])) return { profile: bare[1], model: bare[2] };

  return { model };
}

/** Port for a profile, or undefined when it isn't registered. */
export function profilePort(name: string, registry: ProfileRegistry = loadProfileRegistry()): number | undefined {
  const port = registry.profiles[name]?.port;
  return typeof port === "number" && Number.isFinite(port) ? port : undefined;
}

interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  [key: string]: unknown;
}

interface ModelsPayload {
  object: "list";
  data: ModelEntry[];
}

/**
 * Add `<profile>/<model>` entries for every profile to an OpenAI `/v1/models`
 * payload, keeping the bare IDs for the local profile's backward compatibility.
 * Namespaced entries are what the gateway forwards on, so clients can hold one
 * base URL and address every account.
 */
export function withProfileModels(payload: ModelsPayload, profiles: string[]): ModelsPayload {
  const seen = new Set(payload.data.map((m) => m.id));
  const data = [...payload.data];
  for (const profile of profiles) {
    for (const model of payload.data) {
      const id = `${profile}/${model.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({ ...model, id, owned_by: `microsoft/${profile}` });
    }
  }
  return { ...payload, data };
}

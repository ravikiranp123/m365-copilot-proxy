import {
  loadProfileRegistry,
  localProfileName,
  profileNames,
  splitProfileModel,
  withProfileModels,
  type ModelsPayload,
  type ProfileRegistry,
} from "@m365-copilot/proxy-lib";

export type ModelRoute =
  | { kind: "local"; model: string }
  | { kind: "forward"; profile: string; port: number; model: string }
  | { kind: "unknown-profile"; profile: string; model: string; known: string[] };

/**
 * Decide where a request for `model` goes.
 *
 * Every profile runs its own proxy process (credentials, MSAL cache, agent and
 * log are process-wide), so a namespaced model that belongs to another profile
 * is forwarded to that profile's port. Anything else is served here.
 */
export function resolveModelRoute(
  model: string,
  registry: ProfileRegistry = loadProfileRegistry(),
): ModelRoute {
  const names = profileNames(registry);
  const split = splitProfileModel(model, names);
  if (!split.profile) return { kind: "local", model };

  if (split.profile === localProfileName()) {
    return { kind: "local", model: split.model };
  }

  const port = registry.profiles[split.profile]?.port;
  if (typeof port === "number" && Number.isFinite(port)) {
    return { kind: "forward", profile: split.profile, port, model: split.model };
  }

  return { kind: "unknown-profile", profile: split.profile, model: split.model, known: names };
}

/**
 * Filter and format the models payload for the active profile proxy.
 * By default, only local models are advertised so clients with direct
 * per-profile URLs do not see cross-profile duplicate entries.
 */
export function resolveModelsPayload(
  payload: ModelsPayload,
  profileName: string = localProfileName(),
  registry: ProfileRegistry = loadProfileRegistry(),
  advertiseAll: boolean = process.env.M365_ADVERTISE_ALL_PROFILES === "1",
): ModelsPayload {
  let data = payload.data;
  if (profileName) {
    const profile = registry.profiles[profileName];
    if (profile?.models?.length) {
      const allowed = new Set(profile.models);
      data = data.filter((m) => allowed.has(m.id));
    }
  }

  if (advertiseAll) {
    return withProfileModels({ ...payload, data }, profileNames(registry));
  }

  return { ...payload, data };
}

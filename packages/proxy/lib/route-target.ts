import {
  loadProfileRegistry,
  localProfileName,
  profileNames,
  splitProfileModel,
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

import {
  buildModelsPayload,
  loadProfileRegistry,
  profileNames,
  withProfileModels,
} from "@m365-copilot/proxy-lib";

export default defineEventHandler(() => {
  // Advertise every registered profile's models as `<profile>/<model>` next to
  // the local bare IDs, so a single base URL can address every account. The
  // chat route forwards the namespaced IDs to the proxy that owns them.
  const registry = loadProfileRegistry();
  return withProfileModels(buildModelsPayload(), profileNames(registry));
});

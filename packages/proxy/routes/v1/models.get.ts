import { buildModelsPayload } from "@m365-copilot/proxy-lib";
import { resolveModelsPayload } from "../../lib/route-target";

export default defineEventHandler(() => {
  return resolveModelsPayload(buildModelsPayload());
});

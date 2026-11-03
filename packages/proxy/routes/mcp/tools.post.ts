import { buildMcpToolsPayload } from "@m365-copilot/proxy-lib";
import { pool } from "../../server-pool";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  return buildMcpToolsPayload(
    pool,
    body?.messages ?? [],
    body?.tools,
  );
});

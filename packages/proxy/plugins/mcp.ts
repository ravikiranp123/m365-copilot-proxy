import { mcpBridge, startMcpServer } from "@m365-copilot/core";

/**
 * Starts the native MCP tool-calling bridge (packages/core/src/mcp-server.ts)
 * when M365_ALLOW_NATIVE_TOOLS=1. A Copilot Studio agent's connector (the WT
 * tool already configured for the `ato` profile, see
 * docs/plan/mcp-sidecar-4142.md) talks to this HTTP server;
 * packages/proxy-lib/src/handler.ts bridges its tools/call traffic to the
 * harness's own OpenAI-style tool_calls round-trip. M365_MCP_PORT overrides
 * the port the agent's connector already points at (default 8000 — matches
 * the ato tunnel's existing target).
 */
export default defineNitroPlugin(async () => {
  if (process.env.M365_ALLOW_NATIVE_TOOLS !== "1") return;
  const port = Number(process.env.M365_MCP_PORT ?? 8000);
  startMcpServer(mcpBridge, port);
  console.log(`Native MCP tools bridge enabled (M365_ALLOW_NATIVE_TOOLS=1) on :${port}/mcp`);
});

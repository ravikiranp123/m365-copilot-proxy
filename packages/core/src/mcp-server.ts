import { createServer, type Server, type ServerResponse } from "node:http";
import { createLogger } from "./log.js";
import type { McpBridge } from "./mcp-bridge.js";

const log = createLogger("mcp-server");

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: unknown };
}

function reply(res: ServerResponse, id: string | number | undefined, result: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }));
}

/**
 * The real MCP Streamable-HTTP server a Copilot Studio agent's connector
 * talks to (supersedes the scripts/mcp-sidecar/server.mjs probe — see
 * docs/hypotheses.md §13). Started by packages/proxy/plugins/mcp.ts, gated by
 * M365_ALLOW_NATIVE_TOOLS=1. Serves `bridge`'s current tool list and forwards
 * every tools/call to it; `bridge.call()` is what actually blocks until the
 * real harness result comes back through the proxy's native tool-call path
 * (packages/proxy-lib/src/handler.ts's produceNative).
 */
export function startMcpServer(bridge: McpBridge, port: number): Server {
  const server = createServer((req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Accept",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("m365-copilot-proxy mcp bridge up");
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg: JsonRpcRequest = {};
      try {
        msg = JSON.parse(body);
      } catch {
        log.info("request body did not parse as JSON");
        reply(res, undefined, {});
        return;
      }

      if (msg.method === "initialize") {
        reply(res, msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "m365-copilot-proxy-mcp-bridge", version: "0.1.0" },
        });
        return;
      }
      if (msg.method === "notifications/initialized" || msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === "tools/list") {
        reply(res, msg.id, { tools: bridge.listTools() });
        return;
      }
      if (msg.method === "tools/call") {
        const name = msg.params?.name ?? "";
        const args = msg.params?.arguments ?? {};
        log.info(`tools/call ${name}`);
        bridge
          .call(name, args)
          .then((result) => {
            reply(res, msg.id, { content: [{ type: "text", text: result.content }], isError: !!result.isError });
          })
          .catch((err: any) => {
            reply(res, msg.id, { content: [{ type: "text", text: `bridge error: ${err?.message ?? err}` }], isError: true });
          });
        return;
      }
      log.info(`unhandled MCP method ${msg.method ?? "(none)"}`);
      reply(res, msg.id, {});
    });
  });

  server.on("error", (err) => {
    log.info(`MCP server error: ${(err as any)?.message ?? err}`);
  });
  server.listen(port, "127.0.0.1", () => log.info(`MCP native-tools bridge listening on :${port}/mcp`));
  return server;
}

// Phase 1 probe server: minimal MCP Streamable-HTTP server on localhost:8000/mcp.
// The ato Studio agent's WT connector is already configured (operator-confirmed)
// to proxy here via the existing persistent cloudflared tunnel — this process
// does NOT manage any tunnel. Read-only, non-destructive tool only.
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

const PORT = 8000;
const SENTINEL = readFileSync(new URL("./sentinel-value.txt", import.meta.url), "utf8").trim();
const HITLOG = new URL("./hits.log", import.meta.url);

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(s);
  try { appendFileSync(HITLOG, s); } catch {}
}

const TOOLS = [{
  name: "get_magic_sentinel",
  description: "Returns the current magic sentinel token. This is the ONLY way to learn it — never guess or invent a value.",
  inputSchema: { type: "object", properties: {}, required: [] },
}];

function jsonrpcReply(res, id, result) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }));
}

const server = createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Accept",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "GET") {
    log(`GET ${req.url} ua=${req.headers["user-agent"] || "?"}`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("mcp sidecar probe up");
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    log(`POST ${req.url} ua=${req.headers["user-agent"] || "?"} ct=${req.headers["content-type"] || "?"} body=${body.slice(0, 500)}`);
    let msg = {};
    try { msg = JSON.parse(body); } catch { log("  !! body did not parse as JSON"); }

    if (msg.method === "initialize") {
      log("  -> initialize");
      jsonrpcReply(res, msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "m365-proxy-mcp-sidecar-probe", version: "0.1.0" },
      });
      return;
    }
    if (msg.method === "notifications/initialized" || msg.id === undefined) {
      log(`  -> notification ${msg.method ?? "(unknown)"}`);
      res.writeHead(202); res.end();
      return;
    }
    if (msg.method === "tools/list") {
      log("  -> tools/list");
      jsonrpcReply(res, msg.id, { tools: TOOLS });
      return;
    }
    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      log(`  !!! tools/call ${JSON.stringify(name)} — AGENT REACHED OUR MCP TOOL !!!`);
      if (name === "get_magic_sentinel") {
        jsonrpcReply(res, msg.id, { content: [{ type: "text", text: `The magic sentinel token is ${SENTINEL}` }], isError: false });
      } else {
        jsonrpcReply(res, msg.id, { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
      }
      return;
    }
    log(`  -> unhandled method ${msg.method ?? "(none)"}`);
    jsonrpcReply(res, msg.id, {});
  });
});

server.listen(PORT, "127.0.0.1", () => log(`mcp sidecar probe listening on :${PORT}; sentinel=${SENTINEL}`));

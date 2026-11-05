// Phase 1 driver: fires ONE real production chat turn through CopilotSession
// (the same class ModelSession/the proxy uses) against the ato profile's
// already-configured Studio agent, asking it to call our MCP tool. Verdict is
// cross-checked against the server's own hit log (ground truth), not just the
// model's claimed reply text.
//
// Usage: node scripts/mcp-sidecar/probe.mjs [model]   (default: claude-sonnet-5)
import { readFileSync } from "node:fs";
import { getToken, decodeJwt, CopilotSession } from "../../packages/core/dist/index.mjs";

const MODEL = process.argv[2] || "claude-sonnet-5";
const registry = JSON.parse(readFileSync("config/profiles.json", "utf8"));
const AGENT_ID = process.env.M365_AGENT_ID || registry.profiles.ato?.env?.M365_AGENT_ID;
if (!AGENT_ID) { console.error("[probe] no agent id resolved for ato"); process.exit(1); }
const SENTINEL = readFileSync("scripts/mcp-sidecar/sentinel-value.txt", "utf8").trim();

console.log(`[probe] model=${MODEL} agent=${AGENT_ID} sentinel=${SENTINEL}`);

const token = await getToken();
const claims = decodeJwt(token);
console.log(`[probe] authenticated as ${claims.upn || claims.unique_name || claims.oid}`);

const session = new CopilotSession({ agentId: AGENT_ID, temporaryChat: true });

async function consumeWithTimeout(stream, ms) {
  let text = "";
  let timedOut = false;
  const iterate = (async () => { for await (const delta of stream) text += delta; })();
  await Promise.race([
    iterate,
    new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, ms)),
  ]);
  if (stream.fullText && stream.fullText.length > text.length) text = stream.fullText;
  return { text, timedOut };
}

const text = "Call the get_magic_sentinel tool right now and reply with the EXACT token string it returns. Do not guess, invent, or approximate the value — only report what the tool call actually returns.";

const stream = await session.chat(token, text, MODEL, undefined, {});
const { text: reply, timedOut } = await consumeWithTimeout(stream, 120000);

console.log(`\n[probe] === RESULT ===`);
console.log(`[probe] timedOut=${timedOut}`);
console.log(`[probe] contentOrigin=${stream.contentOrigin} messageType=${stream.messageType}`);
console.log(`[probe] result=${JSON.stringify(stream.result)}`);
console.log(`[probe] throttle=${JSON.stringify(stream.throttle)}`);
console.log(`[probe] reply: ${JSON.stringify(reply.slice(0, 500))}`);
const leaked = reply.includes(SENTINEL);
console.log(`[probe] sentinel present in model's reply: ${leaked}`);

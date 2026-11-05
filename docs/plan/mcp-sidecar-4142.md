# MCP Sidecar on 4142 — Implementation Plan (Do Not Replace Fenced Bash)

Decision
- Keep fenced-bash as default everywhere.
- Add an MCP route on 4142 (ATO) only; gated by profile and agent config.
- Do not flip default until multi-step reliability and quotas are proven.

Evidence (11/03/2026)
- 4142 returns origin=CustomEngineCopilot and emits tool_calls for GPT‑6 Sol/6.1 Sol.
- Multi-step loops: short conversations pass most iterations when arguments are stringified (OpenAI function.arguments must be a JSON string).
- 4141 remains agent-less (origin=DeepLeo) and exhibits higher resistance.

Exit Criteria to expand MCP traffic
- ≥95% first-turn tool_call rate on 20+ diverse tasks.
- ≥90% round-trip completions in multi-step loops (8–12 tool turns).
- Turns per task within ±10% of fenced-bash (relay_batch).
- No higher refusal/ContentFiltered rate and acceptable quota behavior across days.

Engineering Tasks
1) Profiles (Most Valuable Next Change)
   - Accept model IDs prefixed with m365/<profile>/<model>, e.g.:
     - m365/ato/gpt-6.1-sol
     - m365/ato/claude-opus
     - m365/user2/gpt-6.1-sol
   - Parse profile and underlying model at request time.
   - Keep routing/tones based on underlying model; attach profile to session metadata.

2) MCP Route (Sidecar)
   - Enable only when profile=ato AND M365_AGENT_ID is set.
   - Health gate per turn:
     - Require origin=CustomEngineCopilot within the first response.
     - Require tool_calls present and parsable.
     - On InternalError/ContentFiltered/empty → immediate fallback to fenced-bash.
   - One tool call per turn; enforce post-call output cap (already in proxy).

3) Observability
   - Log per turn: profile, model, origin, finish_reason, tool_call count, x_m365_* metering.
   - Emit JSONL for 7–14 day analysis.

4) Bench
   - A/B on 4142: fenced relay_batch (control) vs MCP route.
   - Report: pass rate, turns/task, refusal/filters, quota deltas.

## Implementation status (Nov 4 2026)

Built, in this branch, behind `M365_ALLOW_NATIVE_TOOLS=1` (default off, fenced-bash
stays the default everywhere per the Decision above):

- `packages/core/src/mcp-bridge.ts` — process-wide `McpBridge`: queues a
  `tools/call` M365's native connector makes, lets `handler.ts` wait for the
  next one (`waitForCall`) or deliver the harness's real result
  (`deliverResult`), with a timeout so an undelivered call doesn't hang the
  M365 turn forever.
- `packages/core/src/mcp-server.ts` — the real MCP Streamable-HTTP server
  (supersedes the Phase 1 probe at `scripts/mcp-sidecar/server.mjs`): serves
  `tools/list` from whatever the bridge's tools are set to, forwards
  `tools/call` to `bridge.call()`.
- `packages/proxy/plugins/mcp.ts` — Nitro startup plugin; starts the server on
  `M365_MCP_PORT` (default 8000, matching the `ato` connector's existing
  target) only when `M365_ALLOW_NATIVE_TOOLS=1`.
- `packages/proxy-lib/src/handler.ts` — `produceNative()`: the actual bridge
  between M365's native tool call and the harness's OpenAI `tool_calls`
  round-trip. One M365 turn can issue several tool calls before answering;
  each is surfaced to the harness as an ordinary `tool_calls` response, and
  the SAME underlying M365 stream is resumed (not re-sent, not re-prompted)
  once the harness's result is delivered on the next request. Used only when
  `M365_ALLOW_NATIVE_TOOLS=1` AND the request has tools — the fenced path
  (`produce()`) is untouched and remains the default.
- Tests: `packages/core/src/mcp-bridge.test.ts` (bridge unit tests),
  `packages/proxy-lib/src/native-tools.test.ts` (end-to-end: two
  `handleChatCompletion` calls bridging one native tool call, scripted
  `ModelSession`, no live M365). Verified live with a standalone module smoke
  test: `initialize` → `tools/list` reflecting `setTools()` → `tools/call`
  resolved by `waitForCall`/`deliverResult`, over real HTTP.

Known v1 limitations (by design, not yet gaps to close):
- One bridged conversation in flight per process. Matches AGENTS.md's own
  "run sequentially" convention and the Studio agent's one static connector
  endpoint; a second concurrent bridged conversation would cross-wire calls.
- None of the fenced path's Disengaged/InternalError/priority-access retry
  machinery is replicated in `produceNative()` yet — an upstream failure
  there surfaces as a plain error rather than being retried/classified.
- Enabling it is a per-profile operator decision (set `M365_ALLOW_NATIVE_TOOLS=1`
  in that profile's `env` in `config/profiles.json`), gated by the same
  "only `ato`, only with a configured agent" boundary the Decision above sets
  for the agent itself — no code-level profile check was added since the
  connector only exists on that one agent's endpoint.

Not yet done (blocks flipping any default per the Exit Criteria above): the
A/B bench comparison (native vs. fenced `relay_batch`), and the 7-14 day
observability logging this plan's Engineering Tasks §3 and §4 call for.

Notes
- Keep injected toolset lean to avoid disengage.
- Stringify function.arguments exactly when feeding assistant tool_calls.
- Prefer GPT‑6 Sol / 6.1 Sol for reliability; treat m365-copilot as lower-priority due to transient SystemError/ContentFiltered.

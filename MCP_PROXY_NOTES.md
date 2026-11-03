# MCP Proxy Plan

## Goal

Stop relying on prompt-emulated tool calling.

Instead of creating a transient `m365-tool-agent-*` and convincing the model to emit
fenced tool calls, use a published Copilot Studio agent that already has native MCP
tool access.

The system becomes a bridge between:

- OpenAI-compatible coding harnesses
- Copilot Studio native tool orchestration
- A local MCP server

The proxy's primary responsibility is selecting and routing to the configured
Copilot Studio agent. Tool execution is delegated to Microsoft's MCP
orchestration and the local MCP adapter.

---

## Architecture

Current:

Harness
    -> Proxy
    -> m365-tool-agent-*
    -> Model
    -> Fenced tool call
    -> Proxy parser
    -> Harness

Proposed:

Harness
    -> Proxy
    -> Existing Copilot Studio Agent

Agent
    -> Native MCP Tool Call
    -> Local MCP Server

Local MCP Server
    -> Existing Harness Tool Runtime

Existing Harness Tool Runtime
    -> Tool Result

Local MCP Server
    -> MCP Tool Result

Agent
    -> Final Response

The model never needs to emit fenced tool syntax.

Tool execution decisions are made by Microsoft's native orchestration layer.

---

## Agent Selection

Add an environment variable:

    M365_AGENT_ID=<copilot-studio-agent-id>

When present:

- Do not create `m365-tool-agent-*`
- Do not update agent instructions
- Do not version agents
- Do not manage agent lifecycle
- Attach to the specified published agent directly

Current behaviour remains the default when the variable is unset.

---

## Local MCP Server

The MCP server is intentionally thin.

It does not:

- implement tool logic
- duplicate harness functionality
- require custom per-tool adapters

Its responsibility is translating between:

- Copilot Studio MCP tool invocations
- Existing harness tool invocations

The goal is to reuse the existing harness tool ecosystem unchanged.

---

## Tool Mapping

The existing harness already defines:

- tool names
- tool descriptions
- tool schemas
- tool results

The MCP adapter should translate between:

    MCP tool invocation
        <->
    Harness tool call

and

    MCP tool result
        <->
    Harness tool result

No tool-specific business logic should live in the MCP layer.

The harness should remain unaware that Copilot and MCP are involved.

---

## Important Clarification

This proposal is intentionally different from the previous LocalMCP experiments.

It does NOT attempt to:

- reverse engineer LocalMcpDiscovery
- inject dynamic tools into Copilot
- expose tools through undocumented protocol paths
- replace Microsoft's orchestration layer

Instead it assumes:

- a published Copilot Studio agent already exists
- the agent is manually configured in Copilot Studio
- the agent already has MCP access
- Microsoft already performs native tool orchestration
- MCP tool invocation has already been demonstrated to work

The proxy's job is reduced to selecting and using that agent.

---

## Why This May Be Better Than The Current Approach

Today the project spends significant effort compensating for the fact that the
chat model itself is being asked to behave like an agent.

Examples include:

- fenced tool parsing
- prompt engineering
- framing experiments
- tool-call compliance work
- Disengaged mitigation
- tool-call retries

A Copilot Studio agent with native MCP support may avoid many of these issues
because tool execution is handled by Microsoft's agent runtime rather than by
prompting the model to emit tool syntax.

---

## Minimal Viable Experiment

1. Create a Copilot Studio agent.
2. Attach an MCP server.
3. Verify native MCP tool invocation works.
4. Add:

       M365_AGENT_ID=<agent-id>

5. Configure the proxy to use that agent instead of creating
   `m365-tool-agent-*`.
6. Run existing harness tasks through the selected agent.
7. Measure:
   - tool-call success rate
   - Disengaged rate
   - turn count
   - benchmark score

Success criterion:

The existing harness works unchanged while tool execution is performed through
the agent's native MCP capabilities instead of fenced-tool prompting.

---

## Open Questions

1. Does the current code already support attaching to an arbitrary existing
   Copilot Studio agent, or is agent creation hard-wired into the request path?

2. Which code paths should be bypassed when `M365_AGENT_ID` is configured?
   - agent provisioning
   - instruction updates
   - agent versioning
   - agent lifecycle management

3. How should harness sessions map to MCP sessions?

4. Should the MCP adapter live inside the proxy process or as a separate
   companion service?

5. Which existing benchmark tasks improve when routed through the MCP-enabled
   agent versus the current fenced-tool path?

# MCP Proxy Plan

## Core Insight

Do not integrate with OMP/OpenCode internals.

The proxy already sits on the model API boundary and receives the exact tool definitions that are sent to the model.

The proxy therefore already has access to:

- Tool names
- Tool descriptions
- Tool schemas
- Session identifiers
- Tool call messages
- Tool result messages

No separate tool registry is required.

---

## Architecture

OMP/OpenCode
    -> OpenAI/Anthropic-compatible API
    -> Proxy
    -> Model

Add:

Copilot
    -> MCP
    -> Proxy

The proxy becomes a protocol translator.

---

## Tool Discovery

When the first request for a session arrives:

Store:

session_id -> tools[]

The tools are already present in requests such as:

{
  "messages": [...],
  "tools": [...]
}

MCP tools/list simply returns the cached tools.

No discovery API is needed.

No harness integration is needed.

No MCP server introspection is needed.

---

## Tool Execution

When Copilot sends:

tools/call(name, arguments)

The proxy should generate the same tool-use payload that a model would normally generate.

The harness does not care whether the tool call originated from:

- Claude
- GPT
- Gemini
- Copilot
- A test client

The harness only cares that it receives a valid tool invocation.

Therefore:

MCP tools/call
    ->
Synthetic model tool_use message
    ->
Existing session

---

## Tool Results

Do not execute tools in the proxy.

Allow the existing harness/runtime to execute them.

Wait for the normal tool_result event.

Translate:

tool_result
    ->
MCP tool response

Return to Copilot.

---

## Session Model

Maintain:

session_id
    -> tools
    -> conversation state
    -> pending MCP requests

The proxy acts as a mailbox between:

- MCP clients
- Existing agent sessions

---

## Why This Is Simple

The proxy already receives:

- tools
- messages
- tool calls
- tool results

Therefore the proxy does not need:

- custom tool adapters
- runtime plugins
- tool registries
- code generation
- harness modifications

It only needs protocol translation:

MCP <-> existing model/tool protocol

---

## Open Question

Verify how the proxy can inject a synthetic assistant/tool_use message into an active session.

If sessions are already bidirectional and stateful, most of the implementation is already present.

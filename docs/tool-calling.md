# Tool Calling Contract

This proxy translates OpenAI-compatible tool calls to and from M365 Copilot. M365 has no native OpenAI tool-call channel on this path, so actions arrive as assistant text and the proxy must distinguish an operation from Markdown the user asked it to write.

## Primary output contract: `TOOL_REQUEST`

A call is a whole-response delegated-operation envelope:

```text
TOOL_REQUEST <tool_name>
<one "key: value" line per scalar argument>

<body argument, if the tool defines one>
```

The discriminator must be the first non-whitespace content, and the tool name must resolve to a tool supplied on that request. Exactly one request is accepted. Headers use the existing schema-aware coercion. After the first blank line, a free-form body continues to EOF and preserves its whitespace.

That makes Markdown file content unambiguous:

````text
TOOL_REQUEST write_file
path: README.md

# Setup

```bash
pnpm install
```
````

The inner `bash` fence is literal `README.md` content. Conversely, a normal answer:

````markdown
Run this command:

```bash
pnpm install
```
````

has no `TOOL_REQUEST` discriminator and is returned as text.

Edits keep the existing aider-style `SEARCH/REPLACE` body. Historical assistant `tool_calls` are rendered back into the transcript with `TOOL_REQUEST`, so the model sees one consistent primary syntax.

## Conservative M365 fence compatibility

The established M365 behaviour is to emit a Markdown tool fence, especially a `bash` fence. Shell-routing is the empirically load-bearing behaviour that first turned 0/5 into real multi-turn loops (hypotheses §9 F12), so migration does not drop it.

By default, the proxy accepts a legacy fence only when:

1. Its info string resolves to a supplied tool or recognised shell alias.
2. Exactly one tool call parses.
3. Removing that fence leaves only whitespace.

A fence after prose, multiple fences, and fences inside a Markdown document are therefore content. `M365_ACCEPT_LEGACY_FENCES=1` restores the older permissive parser for stale agents or conversations.

The retired `{"tool":...,"arguments":...}` format is disabled by default. Set `M365_ACCEPT_LEGACY_JSON=1` only for migration. It is collision-prone inside documents and scored 0/5 on the original agentic benchmark.

## Prompting and model-specific framing

`formatFencedToolDefinitions()` retains its historical name, but the shipped `baseline`, `relay`, and `relay_batch` defaults now describe delegated operations and render `TOOL_REQUEST` templates. The Copilot Studio agent carries the same format-only contract in its server-side instructions.

The model-aware defaults remain important:

- `baseline` uses the direct delegated-operation contract.
- `relay` and `relay_batch` keep the user-voice warning that M365 or Claude's built-in sandbox is a separate cloud machine which cannot see the harness project.
- `relay_batch` still asks for as much independent work as is safe in one shell request, without combining steps that depend on unseen output.

Non-default experiment variants remain available for controlled comparisons. Some deliberately retain their historical fence wording.

## Behaviour hardening

The proxy still applies the established deterministic safeguards:

- A model-written `
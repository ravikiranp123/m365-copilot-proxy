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

## Evidence-based outcome reporting

The shared collaborative contract used by `baseline`, `relay`, and `relay_batch` distinguishes requested, completed, and verified actions. Once an actual operation result arrives, the model should report supported outcomes directly rather than routinely disclaiming that it did not personally execute the operation.

- A successful write result supports reporting that the file was created or updated.
- Read-back or a diff can verify contents; a filename in a listing establishes presence only, not creation time or content correctness.
- Missing, ambiguous, or failed results require a specific uncertainty, failure report, or verification request. An operation request alone is not evidence of success.

Full tool-definition refreshes include this rule through the shared formatter, including on-demand reminders. No response rewriting or blanket suppression of caveats is applied. Prompt assertions test delivery of the rule, not live model compliance; the behavioural hypothesis and probe are recorded in `hypotheses.md`, H39c.

## On-demand collaborative tool reminders

On every tool-enabled upstream attempt, the handler includes the current full tool definitions and detailed actionable guidance immediately before calling `session.run`. This replaces the previous every-third-upstream-turn hint. Follow-up deltas, internal retries, reminder refreshes, and recovery attempts all pass through the same injection point. Exact current definitions already present in the prompt are not appended again.

The guidance lists available operation names, explains collaborative access to the actual project, asks for an operation when project inspection or changes are needed, reinforces one request followed by waiting for real output, and preserves evidence-based outcome reporting. It also explicitly permits ordinary answers when no operation is needed. Tool-less requests receive neither the definitions nor this reminder. Repeating full definitions increases prompt size and upstream conversation growth; live compliance and Disengaged rates remain unmeasured.

The model can request the full definitions and collaborative request format by replying with exactly `Please remind me how to use the tools.`, allowing surrounding whitespace. The handler consumes this whole-response marker internally and immediately makes another upstream turn with the current tool definitions and request context. No operation runs for the marker, and it is not exposed in JSON or streaming output.

Quoted markers, fenced examples, prose containing the marker, and markers inside operation bodies are not intercepted. Without enabled tools, the marker remains ordinary text.

One refresh is allowed per client request, shared across the normal response and confabulation recovery paths. A repeated reminder request returns `tool_reminder_loop`: HTTP 502 for non-streaming responses, or a structured error in the already-open SSE stream. Prompt rebuilds and retries receive the current definitions and detailed reminder at the shared upstream execution boundary. Validation: the build succeeded, 440 tests passed and 6 were skipped, and `git diff --check` was clean. New scripted cases cover four consecutive JSON/SSE requests and an internal Disengaged retry; these establish prompt delivery, not improved live compliance.

Scripted tests cover JSON/SSE refresh, repeated-marker limits, embedded-marker discrimination and the no-tools path. Live model uptake and improvements in task completion remain unmeasured.

## Behaviour hardening

The proxy still applies the established deterministic safeguards:

- A model-written `
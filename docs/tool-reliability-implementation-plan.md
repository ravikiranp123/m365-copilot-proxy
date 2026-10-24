# Tool reliability and task continuity implementation plan

Status: Proposed implementation
Date: 2026-10-22

## 1. Goal

Improve reliable operation requests and preserve task continuity in real Pi coding sessions.

Treat three problems separately:

1. **Compliance:** the model remembers available operations and requests them when appropriate.
2. **Correctness:** requests are complete, schema-valid, and faithful to the intended action.
3. **Continuity:** the model retains the task, confirmed progress, and pending work across compaction, resume, and upstream resets.

Preserve the currently helpful every-call reminders as the baseline. Make dedicated operations first-class. Add deterministic validation and a small Pi extension before introducing another model.

## 2. Evidence and limitations

Observed in the development thread:

- Dedicated `read` and correctly formed `edit` requests worked successfully.
- One malformed `edit` request supplied a string where an edit object was required. Validation rejected it; a corrected request succeeded.
- Broad Bash inspections produced truncated output and noisy log searches.
- The user reported improved Claude behaviour with dedicated operations and more detailed reminders.
- The user also reported task-context loss followed by compaction failure. The cause has not been established.
- The latest reported unit validation was 440 tests passed and 6 skipped.

These observations justify investigation and controlled changes, not claims of measured live reliability improvements.

## 3. Architecture and ownership

| Layer | Responsibility |
|---|---|
| Published Copilot Studio agent | Short, stable operation contract on routes that use the agent |
| Proxy framing | Current definitions, actionable reminders, model-specific sandbox guidance |
| Proxy parser and validator | Explicit request recognition, argument validation, bounded correction |
| Proxy session management | Continuation decisions, fresh-conversation recovery, reset diagnostics |
| Pi reliability extension | Durable checkpoints, result tracking, bounded context, recovery commands |
| Optional local model | Shadow-mode repair proposals for explicit malformed requests |

The main model selects actions. Deterministic code validates structure. Pi executes operations. Actual results establish what happened.

Agent-less routes must retain a complete working contract in per-request framing.

## 4. Operating constraints

- Preserve unrelated working-tree changes.
- Keep experiments sequential and respect account throttling.
- Read `docs/m365-copilot-api.md` before protocol changes.
- Read `docs/prompt-engineering.md` before framing changes.
- Record hypotheses, falsification criteria, sample sizes, and evidence in `docs/hypotheses.md`.
- Add runnable experiments to `docs/experiments.md`.
- Validate behavioural wins in real Pi, not only unit tests.
- Do not silently interpret discussion or illustrative code as executable intent.
- Do not silently repair commands, paths, or file content.
- Keep rollback controls independent.

## 5. Phase A: diagnostics and baseline

### Implementation

Add structured diagnostics at the proxy request and upstream-attempt boundaries.

Record:

- Client request ID and upstream attempt number.
- Requested and effective model.
- Agent attachment and instruction version.
- Framing variant and reminder policy.
- Full-prompt versus delta mode.
- Safe upstream conversation identifier.
- Reset reason.
- Prompt characters and definition-block characters.
- Parser path and outcome.
- Validation failure category.
- Reminder, correction, and refusal-recovery attempts.
- Final outcome: text, operation, malformed request, refusal, or upstream error.

Do not log credentials or full payloads by default. Raw prompt and response capture must remain opt-in.

Distinguish local execution outcomes from proxy parsing outcomes. The proxy cannot claim an operation succeeded merely because it emitted a tool call.

### Baseline scenarios

Cover:

- Bounded file reads.
- Exact edits and new-file writes.
- Bash builds, tests, and searches.
- Multi-step tasks requiring actual project state.
- Successful, failed, and ambiguous results.
- Questions requiring no operation.
- Resume, compaction, and fresh upstream conversations.
- Long sessions as well as fresh-thread tasks.

### Acceptance

A failed turn can be diagnosed without searching large streamed logs for generic words. Reports separate models, routes, and framing variants.

## 6. Phase B: dedicated-operation-first framing

### Implementation

Add a selectable framing policy that prefers:

- `read` for bounded inspection.
- `edit` for precise replacements.
- `write` for complete new content.
- `bash` for commands, builds, tests, searches, and shell-specific work.

Use only operations present in the current request. Do not hard-code assumptions that every harness exposes these names.

Keep Bash available when it is the clearest operation. Do not prohibit legitimate shell file operations.

Preserve:

- One operation per reply by default.
- Waiting for actual results before dependent work.
- Longer fences for embedded Markdown.
- Existing envelope compatibility.
- Evidence-based outcome reporting.
- Ordinary answers when no operation is needed.

Retain current full every-call definitions and reminders as the control. Do not simultaneously reduce reminders and change operation preferences.

### Acceptance

- Dedicated operations produce valid calls.
- Shell-less toolsets remain usable.
- Routine questions do not trigger unnecessary operations.
- Existing fence and envelope regression tests pass.

## 7. Phase C: schema validation and bounded correction

### Implementation

Audit existing validation before adding another layer.

At the proxy parsing boundary, distinguish:

1. No explicit operation request.
2. Explicit, complete, valid request.
3. Explicit but invalid request.
4. Incomplete or ambiguous request.

For explicit candidates, validate:

- Known operation name.
- Decodable argument object.
- Required fields.
- Supported schema types and constraints.
- Complete payload boundaries.
- Explicit handling of multiple requests.

Document unsupported schema features rather than silently claiming complete validation.

For an invalid explicit request, allow one targeted correction attempt per client request initially.

Example feedback:

> No operation was executed. `edits[0]` must be an object containing `oldText` and `newText`; it was a string. Resubmit the operation with the same intended change.

Define a shared recovery budget so correction, reminder, and refusal recovery cannot multiply unexpectedly. Upstream throttling and quota failures must not trigger formatting repair.

### Safety rules

Never silently:

- Invent a missing path or command.
- Rewrite replacement text.
- Complete truncated content.
- Execute an illustrative example.
- Report rejected requests as executed.

If correction fails, return a structured error.

### Tests

Cover wrong types, missing fields, unknown tools, malformed edit arrays, truncated fences, nested examples, multiple requests, JSON/SSE errors, cancellation, and exhausted recovery budgets.

## 8. Phase D: Pi task-continuity extension

### API verification

Before implementation, inspect the installed extension types and relevant examples completely.

Confirm contracts for:

- `pi.appendEntry()`.
- `ctx.sessionManager.getBranch()`.
- `context`.
- `tool_call` and `tool_result`.
- Compaction and session lifecycle events.
- Command registration.
- Non-interactive modes and cancellation.

Avoid depending on undocumented event return values.

### Checkpoint model

Persist a versioned checkpoint containing:

- Goal.
- Constraints and permissions.
- Confirmed changes.
- Verification results.
- Pending work.
- Known uncertainties.
- Relevant operation and session-entry references.

Separate user instructions, model-authored plans, and observed execution facts.

A successful operation does not automatically establish completion of the whole task.

### Initial commands

Proposed commands:

- `/task-status`: inspect checkpoint and pending work.
- `/task-checkpoint`: explicitly update task state.
- `/task-handoff`: produce a bounded recovery handoff.

Check for command conflicts before finalizing names.

Start with explicit updates and deterministic result tracking. Do not introduce an automatic summarizer in the first version.

### Persistence and context

- Persist session data through documented APIs.
- Reconstruct branch-sensitive state from the active branch.
- Exclude abandoned branch state.
- Inject a bounded checkpoint into request-local context.
- Avoid permanently appending duplicate checkpoints on every call.
- Preserve relevant recent operation results.
- Restore state on resume and after compaction.
- Handle missing or outdated checkpoints explicitly.

### Acceptance

Resume and compaction tests recover the goal, confirmed progress, and next step without inventing completion. The extension works without terminal UI and cleans up session resources safely.

## 9. Phase E: upstream continuity and reset integration

### Proxy audit

Inspect continuation detection, message-count tracking, fingerprinting, full-prompt reconstruction, and reset paths.

Record reset reasons including:

- Non-continuation detection.
- Model fallback.
- Agent-route fallback.
- Upstream error recovery.
- Explicit replacement.

Test that a fresh upstream conversation receives the required task context and tool contract, not a continuation delta alone.

Compaction, title generation, and other tool-less requests must not accidentally share incompatible upstream conversations with tool-enabled tasks.

### Extension signal

Define a minimal reset diagnostic signal and verify transport through the actual Pi provider path.

Do not assume custom HTTP headers survive provider normalization.

If reliable transport is unavailable initially, retain proxy diagnostics and manual checkpoint restoration rather than guessing that a reset occurred.

### Acceptance

A reset is observable, its reason is recorded, and fresh-conversation requests contain the required context. Do not automatically reset solely because a model sounds confused.

## 10. Phase F: bounded output

Reuse existing Pi output controls where possible.

- Prefer bounded reads and focused searches.
- Preserve full output outside model context when truncating.
- Include a truncation marker and retrieval location.
- Preserve exit status and failure details.
- Keep textual and structured results consistent.
- Avoid rerunning commands merely because output was truncated.
- Do not truncate exact edit arguments or file-write payloads as if they were display output.

Test that useful failure evidence survives truncation.

## 11. Phase G: lean published-agent contract

Inspect the current agent instructions before editing.

Candidate stable instructions:

1. Request listed external operations when required.
2. Match operation names and argument keys.
3. Wait for real results before dependent actions.
4. Do not fabricate execution or results.
5. Distinguish requested, completed, and verified work.
6. Report supported outcomes directly.
7. Answer normally when no operation is needed.

Keep changing schemas, task state, file content, and retry policy outside the agent.

The proxy references the agent per enabled turn, but this does not prove Microsoft injects its instructions verbatim on every turn.

Test instruction changes on confirmed agent-enabled routes in fresh conversations. Preserve hash-based versioning and old agents.

Do not force Claude onto the agent route merely to deliver instructions. Route changes require separate evidence.

## 12. Optional local repair model

Proceed only if diagnostics show persistent failures that deterministic validation and targeted correction do not address.

### Initial experiment

Input:

- An already explicit malformed operation request.
- Its operation schema.
- Validation errors.

Output:

- A proposed corrected call.
- Or `cannot_repair`.

Run in shadow mode without execution.

Evaluate preservation of operation name, paths, commands, replacement text, and file content. Record latency and resource cost on the actual host.

Never use it to infer executable intent from ordinary discussion. Promotion to active use requires a separate decision and representative evidence.

## 13. Validation and rollout

### Deterministic validation

- Build all packages.
- Run unit tests.
- Check diffs.
- Add parser, schema, and JSON/SSE recovery tests.
- Add extension tests for resume, branching, compaction, cancellation, and missing state.
- Test fresh-conversation reconstruction.

### Behavioural validation

Run sequential, rotated comparisons using representative tasks.

Measure:

- Valid first-operation rate.
- Task completion.
- Malformed calls and correction success.
- Unsupported completion claims.
- Unnecessary execution disclaimers.
- Wrong-sandbox activity.
- Refusals and Disengaged responses.
- Upstream turns per task.
- Prompt growth.
- Task-state recovery.

Use independently checked artifacts. Define acceptance thresholds before each experiment. Do not treat a single successful run as confirmation.

### Rollback controls

Keep independently selectable:

- Framing policy.
- Reminder policy.
- Correction recovery.
- Checkpoint injection.
- Agent instruction version.
- Local repair shadow mode.

Preserve the current reminder behaviour as a rollback baseline.

## 14. Implementation order

1. Diagnostics and baseline.
2. Dedicated-operation-first framing.
3. Schema validation and bounded correction.
4. Pi checkpoint extension.
5. Reset diagnostics and continuity integration.
6. Output handling.
7. Lean agent-instruction experiment.
8. Optional local repair experiment.

Do not change routing, framing, checkpoints, and repair simultaneously.

## 15. Definition of done

The first release is complete when:

- Dedicated operations work without universal Bash-first steering.
- Invalid explicit requests receive precise, bounded recovery.
- Checkpoints survive resume and compaction.
- Upstream resets are diagnosable.
- Fresh conversations receive the required context.
- Output controls preserve actionable evidence.
- No regression is observed in illustrative-code handling or unsupported success claims.
- Real Pi sessions validate the selected behaviour.
- Documentation separates deterministic guarantees from measured model behaviour.

## 16. Documentation deliverables

Update:

- `docs/tool-calling.md`: current request contract, validation, correction, reminders.
- `docs/prompt-engineering.md`: only findings supported by sufficient behavioural evidence.
- `docs/m365-copilot-api.md`: protocol or routing changes, if any.
- `docs/hypotheses.md`: hypotheses, falsifiers, results, and evidence pointers.
- `docs/experiments.md`: exact runnable experiments.
- Extension documentation: installation, commands, persistence, privacy, limitations, and rollback.

The first implementation should improve structure and continuity without introducing another model into the execution path.
## Additional design notes: model differences and presentation versus execution

Status: Proposed investigation, not a confirmed mechanism.
Date: 2026-10-23

### Observations and scope

The user reports more reliable tool use with `gpt-6.1-sol` than with
`claude-sonnet-think-deeper` in the current setup, particularly when constructing
edit arguments containing quotes and escape characters. More frequent apparent
context loss was also reported. These observations have not been systematically
benchmarked and do not establish a general model ranking.

Bash-only is not a requirement or the goal. Shell quoting can introduce additional
failure modes. Dedicated operations can avoid those layers, but models may still
construct invalid arguments for them. Evaluate task success, argument validity,
tool selection, and task continuity separately.

### Hypothesis: presentation formatting leaks into operation content

One possible source of invalid calls is that output intended for machine
consumption receives formatting appropriate for web display. Another possibility
is that serialization, logging, or proxy parsing introduces or merely displays
the apparent extra escaping.

Do not infer the origin from rendered output alone. Distinguish:

1. Raw assistant text received from upstream.
2. Arguments produced by proxy parsing.
3. Exact argument values delivered to the operation.
4. Actual operation results and resulting file contents.

Use opt-in, access-controlled payload capture for representative failures.
Default diagnostics should avoid exposing source code or secrets.

### Two complementary approaches

**Instruction-side prevention.** Explicitly distinguish executable requests from
user-facing presentation. Keep the published agent contract short and stable,
and include the complete rule in per-request framing for agent-less routes.
Put operation-specific syntax and examples beside the relevant definitions.

Candidate wording for a controlled framing experiment:

> Operation requests are machine-readable input, not user-facing presentation.
> Follow the supplied request format exactly. Do not add explanatory text,
> decorative Markdown, HTML entities, or display-oriented escaping inside
> argument values unless the operation explicitly requires them. Required
> operation fences and envelopes are protocol syntax, not decoration.
> Preserve literal file content and apply only the encoding required by the
> declared request format.

Do not use blanket rules such as "never escape backslashes" or "always escape
quotes". Literal free-form bodies, JSON strings, shell commands, and nested
structured arguments have different requirements. Avoid teaching an additional
JSON or shell encoding layer where the request format does not require one.

**Proxy-side compatibility.** Define which presentation wrappers, if any, are
part of the accepted protocol and parse those deterministically. The user's
suggestion to handle output as a webview would is a hypothesis to investigate,
not permission to run arbitrary renderer transformations on execution input.

A webview is not itself an execution contract. Markdown rendering, HTML entity
decoding, whitespace normalization, and repeated unescaping can change source
code or command meaning.

Rules for any compatibility path:

- Recognize explicit operation intent before interpreting argument content.
- Remove only wrappers explicitly supported by the request grammar.
- Decode each declared encoding layer exactly once.
- Preserve resulting argument values without speculative rewriting.
- Never globally HTML-decode, repeatedly unescape, or normalize file content.
- Preserve literal strings such as `&quot;`, backslashes, regexes, and code fences
  when they are intended file content.
- Reject ambiguous or malformed requests with precise feedback rather than
  guessing the intended edit.
- Keep compatibility behavior independently selectable and observable.
- Preserve document-versus-operation discrimination and existing safety guards.

### Edit-tool contract improvements

Document whether each field is literal text, JSON, a patch, or a regular
expression. Specify exact-match behavior, whitespace significance, multiple-match
handling, and whether a failed operation can leave partial changes.

Include representative examples containing quotes, backslashes, newlines, and
embedded Markdown using the actual accepted format. Avoid unnecessarily nested
representations such as JSON containing shell commands containing replacement
code.

### Probe and acceptance criteria

First reproduce previously observed failures with deterministic parser fixtures.
Include literal HTML entities, single and double quotes, backslashes, regexes,
multiline edits, nested fences, and document examples that must not execute.
Assert exact argument values, not only successful parsing.

Then compare independently selectable arms:

1. Existing framing and parser control.
2. Presentation-versus-execution instruction only.
3. Explicitly specified proxy compatibility only.
4. Both changes together.

Run live comparisons sequentially with rotated arm order, fixed tasks, and
recorded model, route, agent attachment, and tool definitions. Confirm any
promising result in real Pi edit workflows, not only shell-based benchmarks.

Measure first-call validity, exact final content, retries, recovery turns,
unintended operation recognition, and task success. Track forgotten instructions
and stale file state separately from malformed arguments.

The presentation hypothesis is weakened if raw upstream requests are already
correct and corruption appears only after proxy processing. An instruction
variant is not a win unless it improves validity without damaging literal
content, task success, or operation discrimination. Reject any compatibility
change that silently changes intended arguments or executes document examples.

### Rationale

These additions separate observed model behavior from an unverified explanation,
make the execution-versus-display boundary explicit, and allow instruction and
proxy changes to be tested independently. No runtime behavior is changed by
these notes.

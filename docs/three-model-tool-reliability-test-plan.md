# Three-model tool reliability implementation and test plan

Status: Proposed, not executed
Date: 2026-10-23

## 1. Goal and scope

Determine which instruction and parser changes improve edit-call reliability for exactly these models:

- `gpt-6.1-sol`
- `gpt-5.5-think-deeper`
- `claude-sonnet-think-deeper`

Investigate quotes, escape characters, and presentation formatting without assuming the model is the source of every failure.

Bash-only is not a requirement. Keep dedicated operations and Bash available. Evaluate argument validity, exact edit correctness, and task success separately.

Use offline tests first, followed by a bounded, sequential live experiment. Minimize new conversations and account-level turn consumption.

Related design notes: `docs/tool-reliability-implementation-plan.md`.

## 2. Freeze the baseline

For each model, record:

- Requested model and effective tone.
- Scenario and agent attachment.
- Agent instruction version, where applicable.
- Framing variant and tool definitions.
- Reminder policy.
- Parser settings.
- Build or commit identifier.

Keep routing, tool availability, and full tool reminders unchanged during the experiment. Do not combine the formatting experiment with Bash-only routing, reduced reminders, or task-continuity changes.

Verify the effective routing rather than assuming these three models use the same upstream path.

## 3. Instrument the argument pipeline

Record these boundaries for explicit operation requests:

| Boundary | Evidence |
|---|---|
| Upstream output | Original assistant text before parsing |
| Parser | Recognized format, parsed arguments, validation errors |
| Dispatch | Exact argument values delivered to Pi |
| Execution | Actual result and independently checked file contents |

Correlate records using client request, upstream attempt, scenario, and operation identifiers.

Distinguish malformed upstream output, parser corruption, dispatch conversion errors, and valid calls that fail during execution.

Raw content capture must be opt-in and access-controlled because it can contain source code or secrets. Default diagnostics should record categories and metadata rather than full payloads.

Do not implement webview-like decoding until a captured failure establishes which transformation is needed.

## 4. Offline regression suite

Start with captured failures and synthetic fixtures covering:

- Single and double quotes.
- Backslashes, paths, and regular expressions.
- Multiline replacements and indentation.
- Literal HTML entities such as `&quot;`.
- JSON and source code embedded in replacement text.
- Markdown containing nested operation fences.
- Invalid edit arrays and wrong argument types.
- Truncated requests.
- Documentation examples that must not execute.

Assert exact parsed argument values and, where applicable, exact resulting file content. Successful parsing alone is insufficient.

Any compatibility transformation must:

- Recognize explicit operation intent.
- Remove only wrappers supported by the request grammar.
- Decode each declared encoding layer exactly once.
- Preserve literal content.
- Reject ambiguous requests rather than guessing.
- Preserve document-versus-operation discrimination.

Reject transformations that globally HTML-decode, repeatedly unescape, silently rewrite edits, or execute illustrative examples.

This phase consumes no upstream turns.

## 5. Independently selectable changes

Implement separate experiment controls for:

1. The execution-versus-display instruction.
2. A narrowly specified parser compatibility change.

Do not change production defaults merely to run the experiment.

Candidate instruction:

> Operation requests are machine-readable input, not user-facing presentation. Follow the supplied request format exactly. Do not add explanatory text, decorative Markdown, HTML entities, or display-oriented escaping inside argument values unless the operation explicitly requires them. Required operation fences and envelopes are protocol syntax, not decoration. Preserve literal file content and apply only the encoding required by the declared request format.

Include the complete contract in per-request framing for agent-less routes. Keep any published agent instruction stable unless changing it is explicitly part of the experiment.

Document operation-specific syntax beside its schema. Avoid blanket instructions such as “never escape backslashes.”

## 6. Experimental arms

| Arm | Prompt | Parser |
|---|---|---|
| A | Current | Current |
| B | Execution-versus-display instruction | Current |
| C | Current | Candidate compatibility |
| D | New instruction | Candidate compatibility |

Initially run only A and B live. Replay captured responses through both parser variants offline.

Replay tests immediate parsing behavior without spending additional live turns. It cannot establish how different parser feedback changes later model behavior.

Run C and D live only if the offline compatibility results justify testing the full interaction.

## 7. Bounded sequential pilot

Initial allocation:

- Three models.
- Two prompt conditions.
- One persistent conversation per model-condition pair.
- Six short scenarios per conversation.
- Maximum 12 upstream turns per conversation, including retries, reminders, and recovery attempts.

Total ceiling: six planned conversations and 72 upstream turns, excluding separately authorized setup probes.

Stop unfinished scenarios when their budget is exhausted. Report them as incomplete rather than silently extending the run.

Use isolated fixtures and unique identifiers between scenarios. Keep scenario difficulty comparable and rotate condition order across models.

One conversation per condition is screening evidence, not a conclusive model comparison. If a second pass is justified, reverse condition order and use fresh conversations under a separately declared budget.

Confirm that the harness actually preserves the intended upstream conversation. Do not assume that sending requests through the same client guarantees reuse.

## 8. Protect thread and turn budgets

Reusing conversations reduces thread creation but does not eliminate account-level throttling. Recorded project findings indicate that upstream turns also consume budget.

Use the existing `M365_AVOID_THROTTLING=1` protection on the actual proxy path.

Operational requirements:

- Run one live request at a time.
- Share account-level accounting across all three models.
- Preserve the existing reserve and cooldown behavior.
- Avoid fresh-thread-per-scenario loops.
- Count every upstream recovery attempt.
- Account for other traffic using the same account.
- Stop the experiment on an actual throttle response.
- Preserve partial results and distinguish throttled or transport-invalid runs from model failures.

The 72-turn cap is an experiment ceiling, not a claim that 72 turns are safe from the account’s current state.

If the budget guard requires waiting, let its existing bounded behavior apply. Do not bypass it with fresh conversations or retry loops.

## 9. Measures and decision rules

Primary measures:

1. First-call argument validity.
2. Exact final file content.
3. Task completion within budget.
4. Total upstream turns, including recovery.
5. Unintended operation recognition.

Also record parser path, validation category, correction attempts, and execution failures.

Reject any variant that corrupts literal content or executes documentation examples.

Select winners per model rather than forcing one global policy. Treat small pilot differences as provisional and report raw outcomes and limitations.

Before changing defaults, confirm promising variants in real Pi edit workflows, including quote-heavy and multiline edits. Shell-only benchmarks cannot establish dedicated-edit reliability.

Keep rollback controls independent for prompt and parser changes.

## 10. Implementation order and deliverables

1. Inspect current framing, parsing, dispatch, and budget integration.
2. Add boundary diagnostics and deterministic fixtures.
3. Add independently selectable prompt and parser variants.
4. Run offline regression and replay tests.
5. Run the bounded A/B live pilot.
6. Review results separately for each model.
7. Run compatibility arms only if justified.
8. Confirm promising variants in real Pi.
9. Record conclusions, limitations, and rollback settings.

Before implementation, read the project’s prompt-engineering guidance. Read protocol guidance before changing upstream protocol behavior.

Record hypotheses and falsification criteria in `docs/hypotheses.md`. Add runnable experiment commands to `docs/experiments.md` after verifying the actual script interfaces.

Deliverables:

- Deterministic regression fixtures.
- Correlated diagnostic records.
- Explicit experiment configuration and budgets.
- Per-model scorecards.
- A documented default or no-change decision for each model.

## 11. Separate follow-up: apparent amnesia

Track forgotten instructions and stale file state separately from malformed arguments.

Do not change compaction, checkpointing, reminder frequency, or session-reset behavior during this formatting experiment. Those changes would make the results harder to attribute.

## Rationale

This plan separates observed failures from an unverified presentation-formatting explanation. Offline replay reduces live traffic, independent controls isolate causes, and per-model decisions avoid assuming that one prompt or parser policy suits all three models.

No tests have been run and no runtime behavior has been changed by this document.
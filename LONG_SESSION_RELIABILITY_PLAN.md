# Long Session Reliability Plan for M365 Proxy + OMP

## Executive Summary

The primary remaining failures are not prompt-quality failures.

They are state-management failures:

- Tool amnesia
- Agent drift
- Premature satisfaction
- Context drift

The objective is to evolve from:

Model → Tool → Tool Response → Model

to:

Model → Verifier → Recovery Layer → Continue

---

# Findings From Branch Review

## Valuable Ideas Found

### 6eb238b - collaborative-tool-calls

Introduced:

- tool refresh requests
- collaborative reminders
- fake-tool-refusal recovery
- tool reminder loop

Key insight:

The model sometimes forgets the protocol rather than refusing tools.

### 52b04fd - RESTORECONTEXT

Introduced:

- replay of recent transcript
- fresh upstream conversation recovery

Key insight:

Long sessions need explicit context restoration.

### b76d33d

Improved RESTORECONTEXT by preserving:

- original task
- latest user request

Key insight:

Task anchors matter more than transcript volume.

### fb97312

Removed continuous tool-definition reinjection.

Key insight:

Repeating large tool definitions every turn likely hurts more than helps.

---

# Recommended Architecture

## Proxy Responsibilities

### Tool Refresh

Revive the useful parts of 6eb238b.

Add support for:

"Please remind me how to use the tools."

When emitted:

- reinject tool definitions
- continue automatically
- hide refresh cycle from client

Do NOT reintroduce giant reminder blobs.

---

### Periodic Reminder

Every 15-20 turns inject:

Reminder:

- Tools remain available.
- Tool responses are real observations.
- If work remains, act rather than describe.

Keep this under ~30 tokens.

---

### Continuation Verifier

Add a verifier layer.

Runs only when the assistant emits a non-tool response.

Possible outputs:

- COMPLETE
- BLOCKED
- CONTINUE
- CONTEXT_DRIFT

Inputs:

- original task
- current summary
- latest assistant response
- recent tool responses
- tool availability
- turn count

---

### CONTINUE Recovery

Automatically inject:

Continue working.

Do not summarize.

Take the next action.

Use tools if useful.

---

### CONTEXT_DRIFT Recovery

Do not attempt transcript replay automatically.

Return structured signal to OMP.

Example:

{
  "continuation_verdict": "context_drift"
}

---

# OMP Responsibilities

## Auto Continue

When proxy verdict is:

CONTINUE

OMP automatically sends:

Continue.

without user involvement.

---

## Auto Recovery

When proxy verdict is:

CONTEXT_DRIFT

OMP performs:

1. /compact
2. capture screenshots
3. continue automatically

---

# Screenshot-Based Recovery

Preferred over RESTORECONTEXT replay.

Capture:

## Terminal

Current terminal state.

## Editor

Current file.

Open tabs if available.

## Git

git status

## Diagnostics

Problems panel.

Test failures.

Lint output.

---

# Why Screenshots Beat RESTORECONTEXT

RESTORECONTEXT restores:

- chat history

Screenshots restore:

- workspace state
- editor state
- terminal state
- diagnostics
- test state

Coding agents care primarily about workspace state.

---

# Task Anchors

Maintain outside model context:

## Original Task

First user objective.

## Latest User Request

Most recent steering.

## Verified Progress

Generated only from:

- tool responses
- test results
- git state

Never from model claims.

---

# Explicit Non-Goals

Do not spend further effort on:

- larger trust prompts
- more anti-confab wording
- additional "tool responses are real" variants

The current repository already contains extensive versions of these.

Expected return is low.

---

# Implementation Order

## Phase 1

- revive tool refresh mechanism
- add periodic reminder

## Phase 2

- implement verifier
- classify COMPLETE/BLOCKED/CONTINUE/CONTEXT_DRIFT

## Phase 3

- wire verifier into OMP
- auto continue

## Phase 4

- compact + screenshots recovery

## Phase 5

- benchmark
- compare against current main

Metrics:

- premature completions
- tool amnesia events
- context drift events
- successful recoveries
- average turns to completion

---

# Recommendation

Do not cherry-pick RESTORECONTEXT wholesale.

Cherry-pick ideas from:

- 6eb238b
- b76d33d

Implement:

- verifier
- tool refresh
- compact+screenshot recovery

Those are the highest-leverage improvements for long-running coding sessions.

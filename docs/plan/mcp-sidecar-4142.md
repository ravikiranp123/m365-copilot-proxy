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

Notes
- Keep injected toolset lean to avoid disengage.
- Stringify function.arguments exactly when feeding assistant tool_calls.
- Prefer GPT‑6 Sol / 6.1 Sol for reliability; treat m365-copilot as lower-priority due to transient SystemError/ContentFiltered.

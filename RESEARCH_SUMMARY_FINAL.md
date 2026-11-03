# Final Research Summary

## Confirmed

- Native Copilot Studio MCP invocation works.
- ATO Standard successfully invoked WT-get_portfolio.
- Failure occurred in WT backend (404), not MCP orchestration.
- 4142 (ATO tenant) showed substantially better coding/tool-use quality than 4141.
- Sonnet 5.5 quota on 4142 was exhausted (`sonnet55_daily_remaining=0` observed).
- Opus quota counters were observed and decremented normally.
- 4141 GPT-family routes remained usable while Claude routes appeared unhealthy.
- A configured Studio agent (`M365_AGENT_ID`) bypasses transient `m365-tool-agent-*` creation.
- MCP viability is now proven; long multi-step coding loops remain unproven.

## Most Valuable Next Engineering Change

Add account profiles.

Example model IDs:

- m365/ato/claude-sonnet
- m365/ato/claude-opus
- m365/ato/gpt-6.1-sol
- m365/user2/claude-sonnet
- m365/user2/claude-opus
- m365/user2/gpt-6.1-sol

Benefits:

- Compare quotas between users.
- Compare tenants.
- Compare Studio-agent vs transient-agent behavior.
- Enable future automatic scheduling.

## MCP Direction

Keep existing fenced-tool path.

Add MCP path alongside it.

Do not replace the current path until:
- multi-step tool loops are validated,
- benchmark scores are compared,
- quota behavior across users is understood.

## Key Open Questions

1. Do new ATO users receive fresh Sonnet quotas?
2. Do new ATO users receive fresh Opus quotas?
3. Can all ATO users invoke the same published Studio agent?
4. Does Studio model selection materially affect behavior?
5. Can Studio sustain long coding loops?

## Artifacts

- SESSION_NOTES_2026-11-03.md
- SESSION_NOTES_2026-11-03.backup.md
- THREAD_FINDINGS_FULL.md
- RESEARCH_MERGED_2026-11-03.md


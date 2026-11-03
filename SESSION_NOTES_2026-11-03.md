# Session Notes (2026-11-03)

## Tenants

### 4141
- Different tenant/user.
- GPT-6.1 Sol works.
- GPT-6 Sol works.
- GPT-6 Think Deeper works.
- Claude routes (Sonnet/Opus) appeared unhealthy or returned empty responses.
- Long-running coding tasks reported as poor quality and destructive.

### 4142 (ATO)
- Uses Studio agent:
  T_26402370-428e-d802-c735-a2e224f9dea6
- Sonnet quality reported as dramatically better.
- Native MCP invocation proven to work.
- Sonnet quota later exhausted.

## Studio Agent Findings

Agent: ATO Standard

Observed:
- GenerativeActionsEnabled=true
- isAgentConnectable=true
- Copilot Chat enabled
- WT MCP connector attached
- modelNameHint=GPT5Reasoning

Important:
- MCP execution is real.
- This is not prompt-emulated tooling.

## MCP Proof

Probe executed:

WT-get_portfolio

Result:

{'error': "Client error '404 Not Found' for url 'http://localhost:8000/portfolio'"}

Interpretation:
- Tool invocation succeeded.
- MCP orchestration succeeded.
- Studio agent succeeded.
- Failure occurred inside WT backend.

Architecture validated.

## Model Checks (4142)

Observed working:
- claude-sonnet-5.5
- claude-sonnet-4.6
- claude-opus-5.5
- claude-opus-4.8
- gpt-5.5
- gpt-5.6
- gpt-6-sol
- gpt-6.1-sol
- gpt-6-think-deeper

Self-identification generally matched Claude/GPT families except GPT-6 variants often self-reported as GPT-5 chat.

## Quotas

Observed:
- sonnet55_daily_remaining reached 0
- opus counters decremented normally

Hypothesis:
- Model quotas are attached to invoking user identity.
- Studio agent itself showed no obvious billing signal.

Not yet proven.

## Agent Routing

4142:
- Uses configured Studio agent.
- Bypasses transient m365-tool-agent creation.

4141:
- Uses transient auto-created m365-tool-agent instances.

## Architecture Direction

Current recommendation:

1. Add multi-account support.
2. Keep existing fenced-tool path.
3. Add MCP path alongside it.
4. Benchmark both paths.

## Account Model (implemented)

Profiles live in `config/profiles.json`; one proxy process per account, with its
own credentials, MSAL cache, agent and log. Model IDs are namespaced per
profile:

ato/gpt-6.1-sol
ato/claude-opus
default/gpt-6.1-sol
h2564/gpt-6.1-sol
new-user/gpt-6.1-sol

The legacy `m365/<profile>/<model>` form is still accepted. Any proxy port
forwards a prefixed model to the profile that owns it, so one base URL serves
every account.

Manage them with:

```sh
pnpm profiles add h2564 --port 4143 --secrets secrets.h2564.json
pnpm profiles start all
pnpm profiles sync
```

Benefits:
- Easy quota discovery.
- Easy tenant comparison.
- Easy Studio-agent comparison.
- No scheduler required initially.

## Key Conclusion

The most important result of the session:

Studio Agent
-> Native MCP
-> WT Tool
-> Backend

worked.

The backend failed.

The architecture did not.


Verified SHA256: ba3579936ab007ed00657384b128602f26cf1826d160ba114c0aba2fcd85efd7
Generated: Tue Nov  3 01:47:49 IST 2026

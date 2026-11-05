# Account Profiles — Implemented

Status: implemented in `pnpm profiles` (see the "Multiple accounts (profiles)"
section of the README).

Goal
- One M365 identity per proxy process: credentials, MSAL cache, browser profile,
  tool agent and debug log all belong to that profile.
- Route by model-ID prefix: `<profile>/<model>` (and the legacy
  `m365/<profile>/<model>`).

Registry
- `config/profiles.json` (template: `config/profiles.example.json`, schema:
  `config/profiles.schema.json`).
- Each profile: `port`, `dataDir`, `env` (e.g. `M365_AGENT_ID`,
  `M365_FRAMING_VARIANT`), optional `models` allow-list, `notes`.
- `M365_PROFILES_FILE` overrides the registry path.

Commands
```sh
pnpm profiles list
pnpm profiles add h2564 --port 4143 --secrets secrets.h2564.json --agent T_...
pnpm profiles start all            # background, per-profile pid/log
pnpm profiles status
pnpm profiles stop all
pnpm profiles sync                 # pi catalog + alias map for running profiles
pnpm profiles env h2564            # inspect the launcher env
```

Behaviour
- `/v1/models` keeps the local bare IDs and adds `<profile>/<model>` for every
  registered profile.
- A prefixed model for another profile is forwarded to
  `http://127.0.0.1:<port>/v1/chat/completions` with the prefix stripped and the
  response stream passed through, so one base URL serves every account.
- Unknown prefix → 400 naming the known profiles; registered but stopped → 502
  telling you to start it.
- Each profile's `M365_LOG_FILE` is `<data dir>/debug.log`; lines are tagged
  `[<profile>]` when `M365_PROFILE` is set.
- Agent attachment is per process: the launcher sets `M365_AGENT_ID` from the
  registry and deletes it for an agent-less profile (so `.env` cannot leak
  another tenant's agent).

Examples
- `ato/gpt-6.1-sol` → profile `ato`, model `gpt-6.1-sol`
- `h2564/gpt-6.1-sol` → profile `h2564`, model `gpt-6.1-sol`
- `new-user/claude-sonnet` → profile `new-user`, model `claude-sonnet`

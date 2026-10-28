# Synchronizing Pi and OpenCode models

The existing Pi synchronization command also supports OpenCode. No OpenCode plugin
is required: the script registers the proxy through the OpenAI-compatible provider.

## Commands

- Pi: `pnpm sync:pi`
- OpenCode: `pnpm sync:opencode`
- OpenCode offline: `pnpm sync:opencode --offline`
- Explicit OpenCode configuration: `pnpm sync:opencode --target /path/to/opencode.jsonc`
- Project-local OpenCode configuration: `pnpm sync:opencode --local`
- Custom proxy discovery port: `pnpm sync:opencode --port 4242`

Run `pnpm build` before using the offline fallback. The script tries the running
proxy's `/v1/models` endpoint first unless `--offline` is supplied. Discovery does
not make chat requests or consume model turns.

Pi defaults to `~/.pi/agent/models.json`. OpenCode defaults to
`$XDG_CONFIG_HOME/opencode/opencode.json` or `~/.config/opencode/opencode.json`.
An existing `opencode.jsonc` is selected instead when present. If both JSON and
JSONC exist in the selected directory, use `--target` to choose explicitly.

## Preservation and safety

Only the M365 provider is updated. Other providers, selected models, plugins,
credentials, provider URLs, and existing per-model overrides are preserved.
The advertised catalogue replaces the M365 model list, so retired entries are
removed. New OpenCode models receive advertised context and output hints when
available. These are proxy hints, not independently verified upstream limits.

JSONC comments outside the replaced model catalogue are preserved. Comments
inside that catalogue may be replaced. Malformed configurations and invalid
model catalogues cause an error rather than a destructive reset. Writes use a
temporary file and atomic rename.

The discovery port supplies a default URL for new providers. It does not override
an existing provider URL. To move an existing provider to another proxy port,
edit its URL explicitly.

Synchronization does not start the proxy, authenticate to M365, change model
routing, or verify chat/tool-call behavior. Start the proxy separately and select
an advertised `m365/<model-id>` in OpenCode.

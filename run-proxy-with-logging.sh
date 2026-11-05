#!/usr/bin/env bash
# Start one profile's proxy in the foreground with its own debug log.
#
#   ./run-proxy-with-logging.sh            # default profile (:4141)
#   ./run-proxy-with-logging.sh ato        # ATO profile (:4142)
#
# The launcher pins M365_LOG_FILE to <profile data dir>/debug.log, so two
# proxies no longer write the same file. For background processes and the full
# lifecycle use `pnpm profiles start|stop|status`.
set -euo pipefail
PROFILE="${1:-default}"
exec pnpm profiles start "$PROFILE" --foreground

#!/usr/bin/env bash
# run_with_profile.sh
# Usage:
#   scripts/profiles/run_with_profile.sh <profile> <model> [base_url]
# Example:
#   scripts/profiles/run_with_profile.sh ato gpt-6.1-sol http://localhost:4142
#
# Loads config/profiles.json (fallback: profiles.example.json), exports env for the profile,
# then sends a minimal tool-call request and prints origin + finish_reason.

set -euo pipefail

PROFILE="${1:-}"
MODEL="${2:-}"
BASE="${3:-${BASE_URL:-http://localhost:4142}}"
POST="$BASE/v1/chat/completions"

if [[ -z "$PROFILE" || -z "$MODEL" ]]; then
  echo "Usage: $0 <profile> <model> [base_url]" >&2
  exit 2
fi

CFG="config/profiles.json"
[[ ! -f "$CFG" && -f "config/profiles.example.json" ]] && CFG="config/profiles.example.json"
if [[ ! -f "$CFG" ]]; then
  echo "Profile config not found (config/profiles.json or profiles.example.json)." >&2
  exit 3
fi

# Ensure jq exists
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required; attempting to install via Homebrew or apt..." >&2
  if command -v brew >/dev/null 2>&1; then
    brew install jq
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y jq
  else
    echo "No supported package manager found. Install jq and re-run." >&2
    exit 4
  fi
fi

# Extract env map for the profile
if ! jq -e --arg p "$PROFILE" '.profiles[$p]?' "$CFG" >/dev/null; then
  echo "Profile '$PROFILE' not found in $CFG" >&2
  exit 5
fi

# Export env vars for the profile
ENV_JSON="$(jq -c --arg p "$PROFILE" '.profiles[$p].env // {}' "$CFG")"
# shellcheck disable=SC2046
export $(echo "$ENV_JSON" | jq -r 'to_entries | .[] | @sh "\(.key)=\(.value)"' | tr -d "'")

echo "Profile: $PROFILE"
echo "Model  : $MODEL"
echo "Base   : $BASE"
echo "Env    :"
echo "$ENV_JSON" | jq

# Minimal anchored probe
MARKER="$(uuidgen)"
REQ="$(jq -nc --arg model "$MODEL" --arg marker "$MARKER" '{
  model:$model,
  tools:[{type:"function",function:{name:"run_shell",description:"Run a shell command and return stdout",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}],
  messages:[{role:"user",content:("PROFILE:"+$marker+"\nCall run_shell with command=uuidgen. Do not answer directly.")}]
}')"

RESP="$(M365_DEBUG=1 curl -sS "$POST" -H 'Content-Type: application/json' -d "$REQ" || true)"
echo "$RESP" | jq '{finish_reason: .choices[0].finish_reason, origin: .usage.x_m365_content_origin, tool_calls: .choices[0].message.tool_calls, error: .error, result: .result}'

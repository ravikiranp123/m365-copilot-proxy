#!/usr/bin/env bash
# roundtrip_with_profile.sh
# Usage:
#   scripts/profiles/roundtrip_with_profile.sh <profile> <model> [base_url]
# Example:
#   scripts/profiles/roundtrip_with_profile.sh ato gpt-6.1-sol http://localhost:4142

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

# Export env vars from profile
if ! jq -e --arg p "$PROFILE" '.profiles[$p]?' "$CFG" >/dev/null; then
  echo "Profile '$PROFILE' not found in $CFG" >&2
  exit 5
fi

ENV_JSON="$(jq -c --arg p "$PROFILE" '.profiles[$p].env // {}' "$CFG")"
# shellcheck disable=SC2046
export $(echo "$ENV_JSON" | jq -r 'to_entries | .[] | @sh "\(.key)=\(.value)"' | tr -d "'")

echo "Profile: $PROFILE  Model: $MODEL  Base: $BASE"
echo "Env:"
echo "$ENV_JSON" | jq

# Turn 1: ask for a tool call
MARKER="$(uuidgen)"
REQ1="$(jq -nc --arg model "$MODEL" --arg marker "$MARKER" '{
  model:$model,
  tools:[{type:"function",function:{name:"run_shell",description:"Run a shell command and return stdout",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}],
  messages:[{role:"user",content:("PROFILE:"+$marker+"\nCall run_shell with command=uuidgen. Do not answer directly.")}]
}')"

RESP1="$(M365_DEBUG=1 curl -sS "$POST" -H 'Content-Type: application/json' -d "$REQ1" || true)"
echo "Turn1:"; echo "$RESP1" | jq '{finish_reason: .choices[0].finish_reason, origin: .usage.x_m365_content_origin, tool_calls: .choices[0].message.tool_calls, error: .error}'

FR="$(echo "$RESP1" | jq -r '.choices[0].finish_reason // empty')"
ORIGIN="$(echo "$RESP1" | jq -r '.usage.x_m365_content_origin // empty')"
CALL_ID="$(echo "$RESP1" | jq -r '.choices[0].message.tool_calls[0].id // empty')"
ARGS_STR="$(echo "$RESP1" | jq -r '.choices[0].message.tool_calls[0].function.arguments // "{}"')"

if [[ "$FR" != "tool_calls" || -z "$CALL_ID" ]]; then
  echo "FAIL: No tool_calls in turn 1 (finish_reason=$FR, origin=$ORIGIN)"; exit 10
fi

# Turn 2: feed tool result; arguments must remain a JSON STRING
UUID="$(uuidgen)"
REQ2="$(jq -nc \
  --arg model "$MODEL" \
  --arg call_id "$CALL_ID" \
  --arg args_str "$ARGS_STR" \
  --arg uuid "$UUID" '
  {
    model:$model,
    tools:[{type:"function",function:{name:"run_shell",description:"Run a shell command and return stdout",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}],
    messages:[
      {role:"user",content:"Call run_shell with command=uuidgen. Do not answer directly."},
      {role:"assistant",content:null,tool_calls:[{id:$call_id,type:"function",function:{name:"run_shell",arguments:$args_str}}]},
      {role:"tool",tool_call_id:$call_id,content:$uuid}
    ]
  }')"

RESP2="$(curl -sS "$POST" -H 'Content-Type: application/json' -d "$REQ2" || true)"
echo "Turn2:"; echo "$RESP2" | jq --arg uuid "$UUID" '{finish_reason: .choices[0].finish_reason, origin: .usage.x_m365_content_origin, content: .choices[0].message.content, expected: $uuid}'

CONTENT="$(echo "$RESP2" | jq -r '.choices[0].message.content // ""')"
ORIGIN2="$(echo "$RESP2" | jq -r '.usage.x_m365_content_origin // empty')"
if [[ "$CONTENT" == *"$UUID"* && "$ORIGIN2" == "CustomEngineCopilot" ]]; then
  echo "PASS: Round-trip confirmed (origin=$ORIGIN2)"
  exit 0
else
  echo "FAIL: Missing UUID echo or wrong origin (origin=$ORIGIN2)"; exit 11
fi

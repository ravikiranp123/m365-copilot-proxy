#!/usr/bin/env bash
# 4142-mcp-multistep.sh
# Validate multi-step tool-calls on 4142 (Copilot Chat agent path).
# Usage:
#   BASE_URL=http://localhost:4142 ITER=5 MODELS="gpt-6-sol gpt-6.1-sol" ./scripts/probes/4142-mcp-multistep.sh

set -euo pipefail

BASE="${BASE_URL:-http://localhost:4142}"
POST="$BASE/v1/chat/completions"
ITER="${ITER:-5}"
MODELS_DEFAULT="gpt-6-sol gpt-6.1-sol"
MODELS="${MODELS:-$MODELS_DEFAULT}"
SLEEP_SECS="${SLEEP_SECS:-1}"

jqf(){ jq -r "$1" 2>/dev/null || true; }

run_model () {
  local model="$1"
  echo
  echo "================================================================================"
  echo "Model: $model — $ITER iterations (origin should be CustomEngineCopilot)"

  # Single conversation thread
  local messages pass=0 fail=0
  local marker; marker="$(uuidgen)"
  messages="$(jq -nc --arg m "$marker" '[
    {role:"user", content:("MULTISTEP:"+$m+"\nCall run_shell with command=uuidgen. Do not answer directly.")}
  ]')"

  for i in $(seq 1 "$ITER"); do
    echo
    echo "--- Iteration $i: Turn 1 (expect tool_calls) ---"

    local req1; req1="$(jq -nc --arg model "$model" --argjson messages "$messages" '{
      model:$model,
      tools:[{type:"function",function:{name:"run_shell",description:"Run a shell command and return stdout",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}],
      messages:$messages
    }')"

    local resp1; resp1="$(M365_DEBUG=1 curl -sS "$POST" -H 'Content-Type: application/json' -d "$req1" || true)"
    echo "$resp1" | jq '{finish_reason: .choices[0].finish_reason, origin: .usage.x_m365_content_origin, tool_calls: .choices[0].message.tool_calls, error: .error, result: .result}'

    local fr; fr="$(echo "$resp1" | jqf '.choices[0].finish_reason // empty')"
    local origin; origin="$(echo "$resp1" | jqf '.usage.x_m365_content_origin // empty')"

    if [[ "$fr" != "tool_calls" || "$origin" != "CustomEngineCopilot" ]]; then
      echo "!! FAIL: no tool_calls or wrong origin ($origin)"
      fail=$((fail+1))
      local atext; atext="$(echo "$resp1" | jqf '.choices[0].message.content // ""')"
      messages="$(jq -nc --argjson prev "$messages" --arg t "$atext" '$prev + [{role:"assistant", content:$t}]')"
      sleep "$SLEEP_SECS"
      continue
    fi

    local call_id; call_id="$(echo "$resp1" | jqf '.choices[0].message.tool_calls[0].id // empty')"
    # function.arguments must be a JSON STRING; capture as raw string
    local args_str; args_str="$(echo "$resp1" | jqf '.choices[0].message.tool_calls[0].function.arguments // "{}"')"
    local uuid; uuid="$(uuidgen)"

    # Extend with assistant tool_call using string args
    messages="$(jq -nc \
      --argjson prev "$messages" \
      --arg call_id "$call_id" \
      --arg args_str "$args_str" '
      $prev + [
        { role:"assistant", content:null,
          tool_calls:[
            { id:$call_id, type:"function", function:{ name:"run_shell", arguments:$args_str } }
          ]
        }
      ]')"

    echo "--- Iteration $i: Turn 2 (feed tool result; expect final) ---"
    local req2; req2="$(jq -nc \
      --arg model "$model" \
      --argjson messages "$messages" \
      --arg call_id "$call_id" \
      --arg uuid "$uuid" '
      { model:$model,
        tools:[{type:"function",function:{name:"run_shell",description:"Run a shell command and return stdout",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}],
        messages: ($messages + [{role:"tool", tool_call_id:$call_id, content:$uuid}])
      }')"

    local resp2; resp2="$(curl -sS "$POST" -H 'Content-Type: application/json' -d "$req2" || true)"
    echo "$resp2" | jq --arg uuid "$uuid" '{finish_reason: .choices[0].finish_reason, origin: .usage.x_m365_content_origin, content: .choices[0].message.content, expected: $uuid}'

    local content; content="$(echo "$resp2" | jqf '.choices[0].message.content // ""')"
    local origin2; origin2="$(echo "$resp2" | jqf '.usage.x_m365_content_origin // empty')"

    if [[ "$content" == *"$uuid"* && "$origin2" == "CustomEngineCopilot" ]]; then
      echo "OK"
      pass=$((pass+1))
    else
      echo "!! FAIL: missing UUID echo or wrong origin ($origin2)"
      fail=$((fail+1))
    fi

    # Extend for next iteration
    messages="$(jq -nc --argjson prev "$messages" --arg call_id "$call_id" --arg uuid "$uuid" --arg c "$content" \
      '$prev + [{role:"tool", tool_call_id:$call_id, content:$uuid}, {role:"assistant", content:$c}, {role:"user", content:"Call run_shell with command=uuidgen. Do not answer directly."}]')"

    sleep "$SLEEP_SECS"
  done

  echo
  echo "Summary for $model — Pass: $pass / Fail: $fail"
}

for m in $MODELS; do
  run_model "$m"
done

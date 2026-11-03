#!/usr/bin/env bash
# 4142-mcp-multistep-jsonl.sh (fixed)
# Emit one JSON record per step. Fields: ts, model, iter, phase, origin, finish_reason, ok, uuid, echoed, error

set -euo pipefail
BASE="${BASE_URL:-http://localhost:4142}"
POST="$BASE/v1/chat/completions"
MODELS_DEFAULT="gpt-6-sol gpt-6.1-sol"
MODELS="${MODELS:-$MODELS_DEFAULT}"
ITER="${ITER:-5}"
OUT_DIR="${OUT_DIR:-scripts/probes/out}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_FILE="${OUT_FILE:-$OUT_DIR/4142-mcp-${RUN_ID}.jsonl}"
SLEEP_SECS="${SLEEP_SECS:-1}"

mkdir -p "$OUT_DIR"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
jqr() { jq -rc "$1" 2>/dev/null || true; }

logrec() {
  local model="$1" iter="$2" phase="$3" origin="$4" fr="$5" ok="$6" uuid="$7" echoed="$8" error="$9"
  # ok and echoed are booleans ("true"/"false"); coerce properly with --argjson
  jq -nc \
    --arg ts "$(ts)" \
    --arg model "$model" \
    --argjson iter "$iter" \
    --arg phase "$phase" \
    --arg origin "$origin" \
    --arg fr "$fr" \
    --argjson ok "$ok" \
    --arg uuid "$uuid" \
    --argjson echoed "$echoed" \
    --arg error "$error" '
    {
      ts: $ts,
      model: $model,
      iter: $iter,
      phase: $phase,
      origin: $origin,
      finish_reason: $fr,
      ok: $ok,
      uuid: $uuid,
      echoed: $echoed,
      error: (if $error != "" then $error else null end)
    }'
}

run_model () {
  local model="$1"
  echo "== $model → $OUT_FILE"
  local messages
  local start_marker; start_marker="$(uuidgen)"
  messages="$(jq -nc --arg m "$start_marker" '[
    {role:"user", content:("JSONL_START:"+$m+"\nCall run_shell with command=uuidgen. Do not answer directly.")}
  ]')"

  for i in $(seq 1 "$ITER"); do
    # Turn 1
    local req1; req1="$(jq -nc --arg model "$model" --argjson messages "$messages" '{
      model:$model,
      tools:[{type:"function",function:{name:"run_shell",description:"Run a shell command and return stdout",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}],
      messages:$messages
    }')"
    local resp1; resp1="$(M365_DEBUG=1 curl -sS "$POST" -H 'Content-Type: application/json' -d "$req1" || true)"
    local fr1; fr1="$(echo "$resp1" | jqr '.choices[0].finish_reason // empty')"
    local origin1; origin1="$(echo "$resp1" | jqr '.usage.x_m365_content_origin // empty')"
    local tc_id; tc_id="$(echo "$resp1" | jqr '.choices[0].message.tool_calls[0].id // empty')"
    local args_str; args_str="$(echo "$resp1" | jqr '.choices[0].message.tool_calls[0].function.arguments // "{}"')"
    local err1; err1="$(echo "$resp1" | jqr '.error // empty')"
    local ok1=false
    if [[ "$fr1" == "tool_calls" && "$origin1" == "CustomEngineCopilot" && -n "$tc_id" ]]; then ok1=true; fi
    logrec "$model" "$i" "turn1" "$origin1" "$fr1" "$ok1" "" "false" "$err1" >> "$OUT_FILE"

    if [[ "$ok1" != true ]]; then
      local atext; atext="$(echo "$resp1" | jqr '.choices[0].message.content // ""')"
      messages="$(jq -nc --argjson prev "$messages" --arg t "$atext" '$prev + [{role:"assistant", content:$t}]')"
      sleep "$SLEEP_SECS"
      continue
    fi

    # Turn 2
    local uuid; uuid="$(uuidgen)"
    messages="$(jq -nc --argjson prev "$messages" --arg call_id "$tc_id" --arg args_str "$args_str" '
      $prev + [
        { role:"assistant", content:null,
          tool_calls:[{ id:$call_id, type:"function", function:{ name:"run_shell", arguments:$args_str } }]
        }
      ]')"
    local req2; req2="$(jq -nc --arg model "$model" --argjson messages "$messages" --arg call_id "$tc_id" --arg uuid "$uuid" '{
      model:$model,
      tools:[{type:"function",function:{name:"run_shell",description:"Run a shell command and return stdout",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}],
      messages: ($messages + [{role:"tool", tool_call_id:$call_id, content:$uuid}])
    }')"
    local resp2; resp2="$(curl -sS "$POST" -H 'Content-Type: application/json' -d "$req2" || true)"
    local fr2; fr2="$(echo "$resp2" | jqr '.choices[0].finish_reason // empty')"
    local origin2; origin2="$(echo "$resp2" | jqr '.usage.x_m365_content_origin // empty')"
    local content2; content2="$(echo "$resp2" | jqr '.choices[0].message.content // ""')"
    local err2; err2="$(echo "$resp2" | jqr '.error // empty')"
    local echoed=false
    if [[ "$content2" == *"$uuid"* ]]; then echoed=true; fi
    local ok2=false
    if [[ "$fr2" == "stop" && "$origin2" == "CustomEngineCopilot" && "$echoed" == true ]]; then ok2=true; fi
    logrec "$model" "$i" "turn2" "$origin2" "$fr2" "$ok2" "$uuid" "$echoed" "$err2" >> "$OUT_FILE"

    messages="$(jq -nc --argjson prev "$messages" --arg call_id "$tc_id" --arg uuid "$uuid" --arg c "$content2" \
      '$prev + [{role:"tool", tool_call_id:$call_id, content:$uuid}, {role:"assistant", content:$c}, {role:"user", content:"Call run_shell with command=uuidgen. Do not answer directly."}]')"

    sleep "$SLEEP_SECS"
  done
}

for m in $MODELS; do
  run_model "$m"
done

echo "Wrote JSONL: $OUT_FILE"
jq -s '
  group_by(.model) |
  map({
    model: .[0].model,
    turns: length,
    turn1_ok: (map(select(.phase=="turn1" and .ok==true)) | length),
    turn2_ok: (map(select(.phase=="turn2" and .ok==true)) | length),
    iters: ( [.[].iter] | max ),
    pass_iters: (
      [ group_by(.iter)[] | any(.[] | (.phase=="turn2" and .ok==true)) ] | map(select(.==true)) | length
    )
  })
' "$OUT_FILE" | tee "${OUT_FILE%.jsonl}.summary.json"

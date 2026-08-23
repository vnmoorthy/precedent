#!/bin/bash

# Probe-only hook: deny one unique shell marker and fail open otherwise.
IN=$(cat)
TOOL=$(printf '%s' "$IN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
CMD=$(printf '%s' "$IN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)

if [ "$TOOL" = "Bash" ] && printf '%s' "$CMD" | grep -q 'precedent-hook-probe'; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"PRECEDENT_TUI_HOOK_PROBE_FIRED: repo-local PreToolUse hook blocked the probe command."}}'
fi

exit 0

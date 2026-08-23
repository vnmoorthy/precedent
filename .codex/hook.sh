#!/bin/bash
IN=$(cat)
RESP=$(printf '%s' "$IN" | curl -s -m 1.5 -X POST 127.0.0.1:4747/gate \
        -H 'content-type: application/json' --data-binary @- 2>/dev/null)
[ -n "$RESP" ] && printf '%s' "$RESP"
exit 0

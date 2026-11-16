#!/bin/bash
# Smoke test: ./selftest.sh [base_url] [client_key]
B=${1:-http://127.0.0.1:8080}
K=${2:-}
fail=0
chk() {
  if [ "$2" = "$3" ]; then echo "ok   $1 ($2)"; else echo "FAIL $1 want $3 got $2"; fail=1; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$@"; }

chk healthz "$(code "$B/healthz")" 200
chk no-auth  "$(code "$B/v1/models")" 401
chk bad-key  "$(code -H 'Authorization: Bearer sk-gw-nope' "$B/v1/models")" 401
chk models   "$(code -H "Authorization: Bearer $K" "$B/v1/models")" 200
chk chat     "$(code -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"model":"prem/deepseek-v4.1-flash-1017","messages":[{"role":"user","content":"say ok"}],"max_tokens":8}' \
  "$B/v1/chat/completions")" 200
chk stream   "$(code -N -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"model":"prem/deepseek-v4.1-flash-1017","messages":[{"role":"user","content":"count 1 to 5"}],"stream":true}' \
  "$B/v1/chat/completions")" 200

[ $fail -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit $fail

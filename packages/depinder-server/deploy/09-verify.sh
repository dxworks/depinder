#!/usr/bin/env bash
# Checks the stack from outside, through Caddy, the way depinder will reach it.
source "$(dirname "$0")/lib.sh"

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

check() {  # expected status, label, path, extra curl args...
  local expected="$1" label="$2" path="$3" code
  shift 3
  code="$(curl -sS -o "$body" -w '%{http_code}' --max-time 20 "$@" "$PUBLIC_URL$path" 2>/dev/null)" || code="---"
  printf '%-18s %s  %s\n' "$label" "$code" "$(head -c 200 "$body" | tr '\n' ' ')"
  [ "$code" = "$expected" ]
}

auth=(-H "Authorization: Bearer $RESOLVER_API_TOKEN")
failed=0

step "$PUBLIC_URL"
check 200 'resolver /health' /health || failed=1
check 200 'vuln /health' /vuln/health || failed=1
check 401 '/feeds no token' /feeds || failed=1
check 200 '/feeds' /feeds "${auth[@]}" || failed=1
check 200 '/queue' /queue "${auth[@]}" || failed=1

echo
if [ $failed = 0 ]; then
  echo "all good. depinder: DEPINDER_RESOLVER_URL=$PUBLIC_URL, DEPINDER_RESOLVER_TOKEN=<RESOLVER_API_TOKEN>"
else
  echo "something failed above; logs: ssh $SERVER_SSH_ALIAS depinder logs --tail 100"
  exit 1
fi

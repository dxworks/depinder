#!/usr/bin/env bash
# Builds the image on the server and (re)starts the stack, then waits until resolver and vuln
# report healthy. vuln's first boot on an empty volume downloads both scanner databases first.
# The resolver picks the database up where it was: migrations run on boot (only missing ones
# apply), and feed cursors and the fetch queue live in Postgres.
source "$(dirname "$0")/lib.sh"

step "build the image (a few minutes on 2 cores)"
remote 'depinder build'

step "start"
remote 'depinder up -d --remove-orphans'

wait_healthy() {  # service, timeout in seconds
  local service="$1" deadline=$((SECONDS + $2)) status
  while :; do
    status="$(remote "docker inspect --format '{{.State.Health.Status}}' \$(depinder ps -q $service)" 2>/dev/null || echo unknown)"
    if [ "$status" = healthy ]; then echo "$service: healthy"; return 0; fi
    if [ $SECONDS -ge $deadline ]; then
      echo "$service: $status after $2 s; see: ssh $SERVER_SSH_ALIAS depinder logs $service"
      return 1
    fi
    sleep 10
  done
}

step "wait for health"
wait_healthy resolver 180
wait_healthy vuln 900
remote 'depinder ps'

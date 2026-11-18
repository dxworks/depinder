#!/usr/bin/env bash
# Runs ON the server as the only command of the release deploy key (10-deploy-key.sh).
# The release workflow sends: deploy <x.y.z> <sha256:digest>. It switches the stack to that
# published image, pinned by digest, and waits until resolver and vuln report healthy.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/depinder}"
REPO=ghcr.io/dxworks/depinder-server

read -r verb version digest extra <<< "${SSH_ORIGINAL_COMMAND:-}"
[ "$verb" = deploy ] && [ -z "${extra:-}" ] \
  && [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || { echo "usage: deploy <x.y.z> <sha256:digest>" >&2; exit 2; }
image="$REPO:$version@$digest"

cd "$APP_DIR"
compose() { docker compose --env-file compose.vars -f compose.yml "$@"; }

echo "== pull $image"
docker pull -q "$image"

echo "== start"
grep -v '^DEPINDER_IMAGE=' compose.vars > compose.vars.new || true
echo "DEPINDER_IMAGE=$image" >> compose.vars.new
mv compose.vars.new compose.vars
compose up -d --no-build --remove-orphans

wait_healthy() {  # service, timeout in seconds
  local deadline=$((SECONDS + $2)) status
  while :; do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q "$1")" 2>/dev/null || echo unknown)"
    [ "$status" = healthy ] && { echo "$1: healthy"; return 0; }
    [ $SECONDS -lt $deadline ] || { echo "$1: $status after $2 s" >&2; compose logs --tail 50 "$1" >&2; return 1; }
    sleep 10
  done
}

echo "== wait for health"
wait_healthy resolver 180
wait_healthy vuln 900
compose ps
echo "deployed $image"

#!/usr/bin/env bash
# Docker Engine + Compose plugin from Docker's install script, with log rotation so container logs
# cannot fill the disk.
source "$(dirname "$0")/lib.sh"

step "install docker"
remote bash -s <<'REMOTE'
set -euo pipefail
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
systemctl restart docker
docker run --rm hello-world | grep 'Hello from Docker'
docker image rm hello-world >/dev/null
docker --version
docker compose version
REMOTE

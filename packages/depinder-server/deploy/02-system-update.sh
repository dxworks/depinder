#!/usr/bin/env bash
# Upgrades every package without prompts, keeping existing config files.
source "$(dirname "$0")/lib.sh"

step "apt upgrade on $SERVER_IP"
remote bash -s <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
REMOTE

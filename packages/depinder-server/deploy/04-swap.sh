#!/usr/bin/env bash
# A swap file of SERVER_SWAP_GB: a safety net when a big Grype scan peaks on a small machine.
source "$(dirname "$0")/lib.sh"

step "${SERVER_SWAP_GB} GB swap"
remote "SWAP_GB=$SERVER_SWAP_GB bash -s" <<'REMOTE'
set -euo pipefail
if ! swapon --show | grep -q /swapfile; then
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
sysctl -q --system
free -h
REMOTE

#!/usr/bin/env bash
# Reboots only when an upgrade asked for it, then waits until SSH answers again.
source "$(dirname "$0")/lib.sh"

step "reboot if needed"
if remote '[ -f /var/run/reboot-required ]'; then
  echo "rebooting $SERVER_IP"
  remote 'systemctl reboot' || true
  sleep 10
  deadline=$((SECONDS + 300))
  until remote true 2>/dev/null; do
    [ $SECONDS -lt $deadline ] || die "no SSH 5 min after the reboot; check the Hetzner Console, then re-run this script"
    sleep 5
  done
  echo "back up"
else
  echo "no reboot needed"
fi
remote 'uptime; free -h; df -h /; systemctl is-active docker'

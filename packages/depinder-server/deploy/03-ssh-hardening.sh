#!/usr/bin/env bash
# Key-only SSH. Named 00- so it wins over cloud-init's 50- file (sshd keeps the first value it
# reads). The config is checked before the reload, and a fresh login is tried after it.
source "$(dirname "$0")/lib.sh"

step "disable password logins"
remote bash -s <<'REMOTE'
set -euo pipefail
echo 'PasswordAuthentication no' > /etc/ssh/sshd_config.d/00-hardening.conf
sshd -t
systemctl reload ssh
sshd -T | grep -i '^passwordauthentication'
REMOTE

step "a new session still logs in"
remote 'echo ok'

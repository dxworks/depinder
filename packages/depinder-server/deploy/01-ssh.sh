#!/usr/bin/env bash
# First contact with a fresh (or freshly reset) server: forget the old host key for its IP, log in
# with the key, and add `Host <alias>` to ~/.ssh/config so `ssh depinder` works by hand.
source "$(dirname "$0")/lib.sh"

step "forget any old host key for $SERVER_IP (a reset server has a new one)"
ssh-keygen -R "$SERVER_IP" >/dev/null 2>&1 || true

step "log in as root with $SSH_KEY"
remote 'echo "ok: $(hostname), $(. /etc/os-release && echo "$PRETTY_NAME"), $(nproc) cpu, $(free -h | awk "/Mem/{print \$2}") ram"'

step "ssh alias $SERVER_SSH_ALIAS"
if grep -qE "^Host[[:space:]]+$SERVER_SSH_ALIAS\$" ~/.ssh/config 2>/dev/null; then
  configured="$(ssh -G "$SERVER_SSH_ALIAS" | awk '/^hostname /{print $2}')"
  if [ "$configured" = "$SERVER_IP" ]; then
    echo "already in ~/.ssh/config"
  else
    echo "WARNING: Host $SERVER_SSH_ALIAS in ~/.ssh/config points at $configured, not $SERVER_IP; fix it by hand"
  fi
else
  printf '\nHost %s\n  HostName %s\n  User root\n  IdentityFile %s\n  IdentitiesOnly yes\n' \
    "$SERVER_SSH_ALIAS" "$SERVER_IP" "$SSH_KEY" >> ~/.ssh/config
  echo "added to ~/.ssh/config: ssh $SERVER_SSH_ALIAS"
fi

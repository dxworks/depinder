#!/usr/bin/env bash
# Once per server: lets the release workflow deploy. Adds the deploy key's public half to root's
# authorized_keys, restricted to depinder-deploy (07-upload.sh installs it), and prints the
# values for the GitHub environment `production`.
#   DEPINDER_DEPLOY_PUBKEY=<file.pub> ./10-deploy-key.sh
source "$(dirname "$0")/lib.sh"

PUBKEY="${DEPINDER_DEPLOY_PUBKEY/#\~/$HOME}"
[ -f "${PUBKEY:-}" ] || die 'DEPINDER_DEPLOY_PUBKEY must point at the deploy key'"'"'s .pub file (ssh-keygen -t ed25519 -N "" -C depinder-release-deploy -f <file>)'
key="$(cat "$PUBKEY")"
[[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._-]+)?$ ]] || die "$PUBKEY is not one ssh-ed25519 public key"

step "depinder-deploy is installed"
remote 'test -x /usr/local/bin/depinder-deploy' || die 'run ./07-upload.sh first'

step "restricted deploy key in /root/.ssh/authorized_keys"
remote "KEY='$key' bash -s" <<'REMOTE'
set -euo pipefail
file=/root/.ssh/authorized_keys
line="restrict,command=\"/usr/local/bin/depinder-deploy\" $KEY"
grep -qxF "$line" "$file" && { echo "already there"; exit 0; }
echo "$line" >> "$file"
echo "added"
REMOTE

step "GitHub environment production (Settings > Environments) needs these secrets"
echo "DEPLOY_HOST        $SERVER_IP"
echo "DEPLOY_SSH_KEY     the private key next to $PUBKEY"
echo "DEPLOY_KNOWN_HOSTS (the lines below)"
ssh-keyscan -t ed25519 "$SERVER_IP" 2>/dev/null

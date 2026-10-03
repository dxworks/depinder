# Sourced by every numbered script (with the script's arguments, so `--ip` works on each). Loads
# .depinder.server.env, checks what the scripts need, and
# defines `remote` (run a command on the server) and `upload` (copy a file to it).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$DEPLOY_DIR")"
ENV_FILE="${DEPINDER_ENV_FILE:-$DEPLOY_DIR/.depinder.server.env}"

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

# --- parameters: `--ip <address>` on any script beats DEPINDER_SERVER_IP from the shell ---
ip_arg=''
while [ $# -gt 0 ]; do
  case "$1" in
    --ip) [ $# -ge 2 ] || die '--ip needs a value: --ip <server address>'; ip_arg="$2"; shift 2 ;;
    --ip=*) ip_arg="${1#--ip=}"; shift ;;
    -h | --help) echo "usage: $(basename "$0") [--ip <server address>]   (or: export DEPINDER_SERVER_IP=<server address>)"; exit 0 ;;
    *) die "unknown argument: $1 (usage: $(basename "$0") [--ip <server address>])" ;;
  esac
done

# --- local settings: exported in your shell, never in the env file ---
[ -n "${DEPINDER_SSH_KEY:-}" ] || die 'DEPINDER_SSH_KEY is not set. Run: export DEPINDER_SSH_KEY=~/.ssh/<your key>'
SSH_KEY="${DEPINDER_SSH_KEY/#\~/$HOME}"
[ -f "$SSH_KEY" ] || die "DEPINDER_SSH_KEY points at $SSH_KEY, which does not exist"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Copy .depinder.server.env.example to it and fill it in (README step 0)"

# --- the env file: parsed, not sourced, so a password with $ or & in it stays literal. Everything
# after the first `=` is the value, exactly as the containers will see it (compose reads the file
# raw), so quotes would become part of the value and are refused. ---
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | \#*) continue ;; esac
  key="${line%%=*}"
  val="${line#*=}"
  [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "$ENV_FILE: not a KEY=value line: $line"
  case "$val" in \"* | \'*) die "$ENV_FILE: $key is quoted; write the value without quotes" ;; esac
  printf -v "$key" '%s' "$val"
done < "$ENV_FILE"

# The server's address is not kept in the env file (nor anywhere in the repo): it comes from
# `--ip` or DEPINDER_SERVER_IP. A SERVER_IP line left in an older env file is ignored.
[ -z "${SERVER_IP:-}" ] || echo "note: SERVER_IP in $ENV_FILE is ignored; the address comes from --ip or DEPINDER_SERVER_IP (you can delete that line)" >&2
SERVER_IP="${ip_arg:-${DEPINDER_SERVER_IP:-}}"
[ -n "$SERVER_IP" ] || die 'No server address. Run: export DEPINDER_SERVER_IP=<server ip>   (or pass --ip <server ip>)'
[[ "$SERVER_IP" =~ ^[A-Za-z0-9.:-]+$ ]] || die "server address '$SERVER_IP' is not an IP or host name"

for required in DATABASE_URL RESOLVER_API_TOKEN; do
  [ -n "${!required:-}" ] || die "$required is empty in $ENV_FILE"
done
[ "${#RESOLVER_API_TOKEN}" -ge 16 ] || die 'RESOLVER_API_TOKEN must be at least 16 characters (openssl rand -hex 32)'

SERVER_SSH_ALIAS="${SERVER_SSH_ALIAS:-depinder}"
APP_DIR="${APP_DIR:-/opt/depinder}"
SERVER_SWAP_GB="${SERVER_SWAP_GB:-4}"
SITE_ADDRESS="${SITE_ADDRESS:-:80}"

# Where the server answers from outside: a bare `:port` means plain HTTP on the IP.
if [[ "$SITE_ADDRESS" == :* ]]; then PUBLIC_URL="http://$SERVER_IP"; else PUBLIC_URL="https://$SITE_ADDRESS"; fi

SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

remote() { ssh "${SSH_OPTS[@]}" "root@$SERVER_IP" "$@"; }
upload() { scp -q "${SSH_OPTS[@]}" "$1" "root@$SERVER_IP:$2"; }

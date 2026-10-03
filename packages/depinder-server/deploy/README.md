# Deploy

All commands run on your Mac, from this folder:

```bash
cd ~/Work/Endava/ImproveDepinder/depinder/packages/depinder-server/deploy
```

## Before you start

1. **Server**: Hetzner Console → create or **Rebuild** with Ubuntu, tick your SSH key.
2. **Firewall**: Hetzner → Firewalls → inbound TCP 22, 80, 443 → apply to the server.
3. **Settings file**: get it from 1Password, or copy the example and fill it in.
   ```bash
   op document get "depinder server env" --out-file .depinder.server.env
   # first time only: cp .depinder.server.env.example .depinder.server.env
   ```
4. **SSH key and server address**, in your shell (never in a file in this repo):
   ```bash
   export DEPINDER_SSH_KEY=~/.ssh/<your key>
   export DEPINDER_SERVER_IP=<server ip>      # from the Hetzner Console
   ```
   Any script also takes `--ip <server ip>`, which wins over `DEPINDER_SERVER_IP`. A script stops
   and says so when either is missing.
5. **Only one stack per database**: stop any other one (e.g. on your Mac: `docker compose down` in `packages/depinder-server`).

## Deploy a new server

```bash
for s in ./0*.sh; do "$s" || break; done
```

If it stops, fix the step that failed and run it again. Every script is safe to re-run.

| Step | Does |
|---|---|
| `./01-ssh.sh` | First login, adds `ssh depinder` |
| `./02-system-update.sh` | apt upgrade |
| `./03-ssh-hardening.sh` | Key-only SSH |
| `./04-swap.sh` | Swap file |
| `./05-docker.sh` | Docker + Compose |
| `./06-reboot-if-needed.sh` | Reboot if needed |
| `./07-upload.sh` | Code + settings → `/opt/depinder` |
| `./08-start.sh` | Build, start, wait for healthy (first start ~5 min) |
| `./09-verify.sh` | Check it from outside |

## Ship new code or a changed setting

```bash
./07-upload.sh && ./08-start.sh && ./09-verify.sh
```

Changed a setting? Also save it to 1Password: `op document edit "depinder server env" .depinder.server.env`

## When it breaks

```bash
./09-verify.sh                       # what is down?
ssh depinder depinder ps             # what runs, is it healthy?
ssh depinder depinder logs --tail 100 resolver   # or: vuln, caddy
ssh depinder depinder restart        # restart everything
./07-upload.sh && ./08-start.sh      # redeploy
```

Server gone or unfixable: **Rebuild** in Hetzner, then "Deploy a new server". Nothing is lost:
the data is in Supabase.

## Settings (`.depinder.server.env`)

`KEY=value`, no quotes, no comments. Blank lines separate groups.

| Key | What it is |
|---|---|
| `SERVER_SSH_ALIAS` | Name for `ssh <alias>` (`depinder`) |
| `APP_DIR` | App folder on the server (`/opt/depinder`) |
| `SERVER_SWAP_GB` | Swap size in GB |
| `SITE_ADDRESS` | `:80` = plain HTTP on the IP. A domain pointing at the server = HTTPS |
| `DATABASE_URL` | Supabase session pooler string, port 5432 |
| `DATABASE_SSL` | `true` for Supabase |
| `DATABASE_LISTEN` | `true`: one extra connection for notifications |
| `DATABASE_POOL_SIZE` | Max DB connections (32; the Pro pooler allows 45 in total) |
| `API_POOL_SIZE` | Of those, reserved for the API (8) |
| `RESOLVER_API_TOKEN` | API token, `openssl rand -hex 32`. depinder uses it as `DEPINDER_RESOLVER_TOKEN` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `FETCH_CONCURRENCY` | Registry fetches at once (64) |
| `PAYLOAD_CACHE_MAX_PACKAGES` | Packages cached in memory (50000; 0 = off) |
| `VULN_MAX_SCANS` | Scans at once (1 on a 4 GB server) |
| `VULN_MAX_QUEUED` | Requests waiting for a scan before 503 |
| `VULN_MAX_PURLS` | Max purls per request (5000) |
| `VULN_CPUS` / `VULN_MEM_LIMIT` | Limits for the vuln container (1.5 / 2500m) |

The SSH key and the server address are never in this file: they come from `DEPINDER_SSH_KEY` and
`DEPINDER_SERVER_IP` (or `--ip`). An old `SERVER_IP` line is ignored, with a note.

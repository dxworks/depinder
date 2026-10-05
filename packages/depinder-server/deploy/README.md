# Deploying the depinder server

The resolver, the vuln scanner and Caddy run with Docker Compose on one Ubuntu server. Every
script runs **on your computer** and works on the server over SSH as `root`. You never have to log
in to the server to deploy.

## 1. Your environment (set this first)

Put these in your shell, or in your `~/.zshrc`. They are per developer and never go in the repo.

```bash
export DEPINDER_SSH_KEY=~/.ssh/<your key>          # private key the server accepts for root
export DEPINDER_SERVER_IP=<server ip>              # from the Hetzner Console
# optional: settings file somewhere other than this folder
# export DEPINDER_ENV_FILE=/path/to/.depinder.server.env
```

Every script also accepts `--ip <server ip>`, which wins over `DEPINDER_SERVER_IP`. A script stops
with a clear message when something is missing.

You also need the **settings file** (database, API token and limits). It goes here:

```
<monorepo>/packages/depinder-server/deploy/.depinder.server.env
```

Get it from 1Password or start from the template in the same folder:

```bash
op document get "depinder server env" --out-file .depinder.server.env
# first time ever: cp .depinder.server.env.example .depinder.server.env  and fill it in
```

It is git-ignored. Format: `KEY=value`, no quotes. All keys are listed in [Settings](#settings).

## 2. Where everything is

| What | Where |
|---|---|
| Scripts and this guide | `<monorepo>/packages/depinder-server/deploy/`: **run every script from here** |
| Settings file (yours) | `deploy/.depinder.server.env`, or `$DEPINDER_ENV_FILE` |
| App on the server | `/opt/depinder/` (`compose.yml`, `server.env`, `src/`) |
| Shortcut on the server | `depinder <compose command>`, e.g. `depinder ps` |
| Database | Supabase. Migrations are in `packages/depinder-server/migrations/` and the server applies them by itself on start |

```bash
cd <monorepo>/packages/depinder-server/deploy
```

## 3. A brand-new server

Before running anything:

1. In the Hetzner Console, create the server or **Rebuild** it with Ubuntu, with your SSH key ticked.
2. Under Firewalls, allow inbound TCP 22, 80 and 443 and apply the firewall to the server.
3. Update `DEPINDER_SERVER_IP` if the IP changed.
4. Run only one stack per database. Stop any other stack using the same database, e.g. a local one:
   `docker compose down` in `packages/depinder-server`.

Then run the scripts one by one from your computer. Each one is safe to re-run, so if one
fails, fix the cause and run it again.

| # | Command | What it does |
|---|---|---|
| 1 | `./01-ssh.sh` | Forgets the old host key, logs in, and points `ssh depinder` at this server in `~/.ssh/config` |
| 2 | `./02-system-update.sh` | `apt upgrade` |
| 3 | `./03-ssh-hardening.sh` | Turns off password logins (key only) |
| 4 | `./04-swap.sh` | Adds a swap file |
| 5 | `./05-docker.sh` | Installs Docker and Compose with log rotation |
| 6 | `./06-reboot-if-needed.sh` | Reboots if the upgrade asked for it and waits for SSH |
| 7 | `./07-upload.sh` | Copies code, compose file and settings to `/opt/depinder` |
| 8 | `./08-start.sh` | Builds the image on the server and starts the stack, then waits until it is healthy. The first time takes about 5 min while vuln downloads its databases |
| 9 | `./09-verify.sh` | Checks it from outside: health, token, `/feeds`, `/queue` |

To run them all in one go: `for s in ./0*.sh; do "$s" || break; done`

When `09` says "all good", depinder can use it. It calls `https://libs.dxworks.org` by default, so
clients only set `DEPINDER_RESOLVER_TOKEN=<RESOLVER_API_TOKEN>`; for another server, also set
`DEPINDER_RESOLVER_URL` to its domain.

## 4. Ship new code or a changed setting

```bash
./07-upload.sh && ./08-start.sh && ./09-verify.sh
```

`07` uploads your **working tree**, uncommitted changes included. Its version gets `+dirty` when
they are present. If you changed a setting, also save it to 1Password:
`op document edit "depinder server env" .depinder.server.env`

## 5. When it breaks

From your computer:

```bash
./09-verify.sh                                  # what is down?
ssh depinder depinder ps                        # what runs, is it healthy?
ssh depinder depinder logs --tail 100 resolver  # or: vuln, caddy
ssh depinder depinder restart                   # restart everything
./07-upload.sh && ./08-start.sh                 # redeploy
```

Or log in (`ssh depinder`) and run on the server:

```bash
depinder ps                                     # status and health
depinder logs -f resolver                       # follow logs (vuln, caddy)
depinder restart                                # or: stop / start
cat /opt/depinder/src/VERSION                   # which commit is deployed
```

| Problem | Fix |
|---|---|
| `DEPINDER_SSH_KEY is not set` / `No server address` | Set the variables from section 1 |
| `.depinder.server.env not found` | Get the settings file (section 1) |
| `Host key verification failed` | The server was rebuilt: run `./01-ssh.sh` |
| `Permission denied (publickey)` | Wrong key, or the key was not ticked at Rebuild |
| `08` times out on vuln | First boot is still downloading databases: `ssh depinder depinder logs -f vuln`, then re-run `./08-start.sh` |
| resolver unhealthy | `ssh depinder depinder logs --tail 100 resolver`. Usually `DATABASE_URL`, or another stack using the same database |

If the server is gone or can't be fixed, **Rebuild** it in Hetzner and go through section 3. Nothing is
lost because the data lives in Supabase.

## Settings

`.depinder.server.env`: `KEY=value`, no quotes. The SSH key and server IP never go here.

| Key | What it is |
|---|---|
| `SERVER_SSH_ALIAS` | Name for `ssh <alias>` (`depinder`) |
| `APP_DIR` | App folder on the server (`/opt/depinder`) |
| `SERVER_SWAP_GB` | Swap size in GB (4) |
| `SITE_ADDRESS` | `:80` serves plain HTTP on the IP. A domain that points at the server gets HTTPS |
| `DATABASE_URL` | Supabase session pooler string, port 5432 |
| `DATABASE_SSL` | `true` for Supabase |
| `DATABASE_LISTEN` | `true` uses one extra connection for notifications |
| `DATABASE_POOL_SIZE` | Max DB connections (32; the Pro pooler allows 45 in total) |
| `API_POOL_SIZE` | How many of those are reserved for the API (8) |
| `RESOLVER_API_TOKEN` | API token, from `openssl rand -hex 32`. depinder uses it as `DEPINDER_RESOLVER_TOKEN` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `FETCH_CONCURRENCY` | Registry fetches at once (64) |
| `PAYLOAD_CACHE_MAX_PACKAGES` | Packages cached in memory (50000; 0 = off) |
| `VULN_MAX_SCANS` | Scans at once (1 on a 4 GB server) |
| `VULN_MAX_QUEUED` | Requests that can wait for a scan before the server answers 503 |
| `VULN_MAX_PURLS` | Max purls per request (5000) |
| `VULN_CPUS` / `VULN_MEM_LIMIT` | Limits for the vuln container (1.5 / 2500m) |

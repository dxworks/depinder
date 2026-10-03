# Configuration

For whoever runs the service: every environment variable of the resolver, and the Docker setup for
both roles. The vulnerability server's own variables are in [vuln-server.md](vuln-server.md).

All of it is environment variables; `.env.example` is the annotated copy.

| variable | default | meaning |
|---|---|---|
| `DATABASE_URL` | — | **required.** Postgres connection string |
| `RESOLVER_API_TOKEN` | — | **required**, at least 16 characters. The bearer token. The server refuses to start without it |
| `DATABASE_SSL` | `true` | `true` connects with `rejectUnauthorized: false`, which is what Supabase's shared certificate needs |
| `DATABASE_LISTEN` | `true` | Keep one extra connection, outside the pool, that `LISTEN`s for queue and settle notifications, so an api and a worker in different processes hear each other at once. Off: they find out by polling. See [The fetch queue](resolver-internals.md#the-fetch-queue) |
| `ROLE` | `all` | `api` (HTTP only), `worker` (demand-fill + feeds only), `all` (both), `vuln` (the vulnerability server, no Postgres; its own settings are under [Vulnerabilities](vuln-server.md)) |
| `PORT` | `8080` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `MAVEN_PER_VERSION_LICENSES` | `false` | Fetch a POM per maven version. Off: per-version licenses fall back to the library-level list |
| `FETCH_CONCURRENCY` | `64` | Package fetches the demand-fill worker keeps in flight at once. Just above what the per-ecosystem limiters add up to, so those stay the constraint |
| `DATABASE_POOL_SIZE` | `15` | Postgres connections this process opens at most. The write side of a fill runs on these; about half `FETCH_CONCURRENCY` keeps every fetch slot moving |
| `API_POOL_SIZE` | `8` | Of those, the api's own. Carved out of `DATABASE_POOL_SIZE`, so the worker gets the rest and the process still opens no more than the ceiling. `ROLE=all` only |
| `PAYLOAD_CACHE_MAX_PACKAGES` | `50000` | Packages whose version tuples the api holds in memory. An entry is used only when the `package` row read this request carries the same `fetched_at`, so it is multi-instance safe. `0` switches it off |

`FETCH_CONCURRENCY` and `DATABASE_POOL_SIZE` are a pair. A package is a registry request and then a
write, and against a hosted database the write — five statements, five round trips — takes about as
long as the request did, so a fetch pool of 64 wants roughly 32 connections underneath it to never
stand still waiting for one. The default is 15, not 32, because of the pooler: **a Supabase session
pooler serves its own "Pool Size" (Dashboard > Settings > Database > Connection pooling) and refuses
everything past it outright with `EMAXCONNSESSION` rather than queueing**, and a stock project's
Pool Size is 15 — for the whole process, api role and migrations included. Raise it there (or
connect directly, which on a small instance is ~60 connections) and then set
`DATABASE_POOL_SIZE=32`. Splitting the roles across two containers gives each its own pool, so count
both against the same ceiling.

`API_POOL_SIZE` divides that allowance rather than adding to it. Under `ROLE=all` the two halves
used to share one pool, and a fill keeps `FETCH_CONCURRENCY` writes in flight, so the worker held
every client in it; pg does not queue a waiter indefinitely, and a `/resolve` query left in the
pending queue is rejected after ten seconds with `timeout exceeded when trying to connect` — an HTTP
500 for a caller who did nothing wrong. Each half now has a pool of its own, and so a queue of its
own. A process running a single role gives the whole of `DATABASE_POOL_SIZE` to it.

The default of 8 is what a depinder run asks for at once. It posts every chunk of a run together, up
to 2,000 purls each, so a 10,000-purl run is six requests in flight, and it never retries one: a
chunk whose stream breaks is answered from the registries instead, and the rest of the run skips the
resolver. A stream holds a client for one query at a time, never for the length of its deadline, but
on a cold version cache a chunk's 500-package version reads take 2–8 s each against a hosted
database. With 4 clients, six such chunks queued for longer than pg's ten-second connect timeout;
one stream lost its trailer and its 2,000 purls, and a run that takes 15 s took 152. Eight gives
each of six chunks a client and leaves two for `/feeds`, `/health` and a seventh. With the Pro
pooler's 45 and `DATABASE_POOL_SIZE=32` that is 8 for the api, 24 for the worker and one `LISTEN`
connection, 33 in all; with the stock 15 the worker keeps 7.

The api's pool also waits longer for a client than the worker's: 60 seconds, the longest
`deadline_ms` a `/resolve` may ask for, instead of 10. A request whose read has to queue becomes
slow rather than broken, and a client is held for one query at a time, so the queue moves every few
seconds. The worker keeps ten: a package that cannot get a client is better retried later than left
holding a fetch slot.

A caller that gives up is stopped being worked for. `POST /resolve` watches its own response stream
and, when the socket closes before the stream is finished, ends the wait at once, starts no further
read and sends nothing more — no trailer — instead of spending another poll interval and a
multi-megabyte `json_agg` on a socket that has gone. It is checked before every read and every
batch, so it can happen between two flushes. A read already running cannot be unmade, but what it
cost is kept in the payload cache for the next caller. Nothing is logged but one debug line, and the
queue rows the request already committed stay committed.

With Supabase use the **direct or session pooler** connection string (port 5432), not the
transaction pooler on 6543: migrations and the `FOR UPDATE SKIP LOCKED` queue need session
semantics — and so does `LISTEN`, which is why the listen connection works through the session
pooler. It is one connection per process on top of `DATABASE_POOL_SIZE`; count it against the
pooler's Pool Size too. `.env` is gitignored.

## Docker

```bash
cp .env.example .env
docker compose up --build
```

Three services, one address (`localhost:8080`, or `PUBLIC_PORT`), one token:

| service | what | published |
|---|---|---|
| `resolver` | `ROLE=all`: `/resolve`, `/feeds`, `/queue`, `/health` | no |
| `vuln` | `ROLE=vuln`: `/vulnerabilities`, its `/health` | no |
| `caddy` | routes `/vulnerabilities` to `vuln`, `/vuln/health` to `vuln`'s `/health`, everything else to `resolver` (`Caddyfile`) | `${PUBLIC_PORT:-8080}` |

No database container — the database is hosted. Both servers read `.env` for the token;
`docker-compose.yml` sets `ROLE`, `PORT` and the `VULN_*` settings itself.

- **Image.** One image for every role, multi-stage, run on `node:24-alpine` as the unprivileged
  `node` user. It carries Trivy 0.74.0 and Grype 0.118.0, copied from their official images pinned
  by multi-arch digest (amd64 and arm64). 572 MB (136 MB compressed); 256 MB before the scanners.
  The `HEALTHCHECK` asks `/health`.
- **Databases** live in the named volume `vuln-data` at `/var/lib/vuln` (`VULN_DATA_DIR`), not in
  the image: ~4.4 GB, up to ~9 GB while both tools download. The first `up` on an empty volume
  downloads them (~75 s), during which `/vuln/health` and `/vulnerabilities` answer 503 and the
  resolver serves as usual — caddy does not wait for `vuln` to be healthy, and `vuln`'s health
  check has a 5 min start period. Restarts and rebuilds serve in about a second, with no download.
  `docker compose down -v` deletes the volume. **One `vuln` container per volume**: two would
  both update it.
- **Proxy.** No `encode` (both servers compress their own answers), `flush_interval -1` so the
  `/resolve` stream reaches the client batch by batch, 120 s upstream timeouts, 11 MB bodies.
  `SITE_ADDRESS` (default `:8080`, plain HTTP) set to a domain, with ports 80 and 443 published,
  gets a certificate automatically.
- **Limits.** `vuln` gets 2 CPUs and 4 GB with `VULN_MAX_SCANS=2`, `VULN_MAX_QUEUED=8`, so scans
  cannot starve the resolver. Placeholders: tune them on the machine it runs on (`bench/micro/vuln-bench.cjs`).
  The page cache of Grype's 2.9 GB database counts against the memory limit.
- **Shutdown.** 70 s grace, so a `/resolve` stream or a scan in flight can finish.

Splitting the resolver across two containers is a matter of running the same image twice with
`ROLE=api` and `ROLE=worker`; disable the health check on the worker, which serves no HTTP.

# Resolver internals

For whoever changes the resolver: the source layout, how a package gets fetched and written, and
what the fetch queue guarantees.

## How it works

```
src/
  main.ts                  boot by ROLE, migrations, graceful shutdown
  shared/                  used by both roles; imports nothing from resolver/ or vuln/
    config.ts  log.ts        env parsing helpers; the logger
    purl.ts                  parse/canonicalise -> packageKey, registryName, versionPurl
    http-server.ts           auth, compression, error handler, body limit, clientGone
    errors.ts                BadRequestError, answered as a 400
  resolver/                ROLE=api|worker|all
    config.ts                env
    events.ts                what the api and the worker tell each other in one process
    db/db.ts                 pg pool, migration runner, transactions
    db/queue.ts  db/rows.ts  fetch_queue priorities; row shapes
    db/notify.ts             the same as events.ts, between processes, over LISTEN/NOTIFY
    db/fetch-log.ts          every upstream request, for provenance
    api/                     fastify server, /resolve, /feeds, /health
    registries/<type>(.ts|/) one per ecosystem (all eight; maven/ and pypi/ are folders), plus
                             deps-dev.ts for go licenses
    registries/http.ts       timeout, User-Agent, per-ecosystem limiter, fetch recording
    registries/latest.ts     the latest-version policy
    worker/fill/             the demand-fill queue consumer: fetch, write, retry, backoff, sweeper
    worker/feeds.ts          per-registry change feeds and conditional-GET polling
  vuln/                    ROLE=vuln: POST /vulnerabilities, no Postgres; imports nothing from resolver/
    config.ts  main.ts       env; boot, scanner versions, database check
    request.ts  sbom.ts      purls in, sorted; the dummy CycloneDX file
    scanners.ts              Trivy and Grype as child processes, side by side
    merge                    depinder's Trivy + Grype merge, keyed by bom-ref
    databases.ts  limiter.ts the databases' build dates; scan slots and the waiting line
    server.ts                the route
migrations/                plain SQL, applied at boot, tracked in schema_migrations
```

A request for an unknown package inserts it as `pending` and queues it, and — when the two share a
process — tells the worker so rather than leaving it to find out when its nap ends. The worker keeps
`FETCH_CONCURRENCY` package fetches in flight at once and tops that pool back up — dequeuing as
many rows as it has free slots, with `FOR UPDATE SKIP LOCKED` — as each one settles, rather than
awaiting a batch. That matters because the batch would only finish when its slowest member did:
a slow package now costs one slot instead of leaving every other registry idle. Politeness stays
where it belongs, in the per-ecosystem limiters in `registries/http.ts`, which also let the most important
request waiting through first rather than the oldest — but a fetch waiting in a limiter
still holds its slot, so each ecosystem may only hold twice its limiter's width of them (cargo 2,
maven and pypi 8, the rest 16). Without that cap, a queue whose front is three hundred crates would
fill every slot with cargo at one request a second while npm sat idle behind it. Each fetch goes through its registry and writes the package, its versions and its
`fetch_log` rows in one transaction. A failure backs off 30 s, then 2 min; after three attempts
the package is flagged `error` and retried in an hour — unless it already had good data, which
keeps being served. `not_found` is retried after 24 hours, and a package whose registry said its
facts are not final yet (golang, see [Ecosystems](../README.md#ecosystems)) is fetched again when it asked to be. Every terminal status is announced back
to whatever request is waiting, after the commit that wrote it: see `src/resolver/events.ts` in one
process and `src/resolver/db/notify.ts` between two. How the queue behaves as a whole is under
[The fetch queue](#the-fetch-queue).

That transaction is counted in round trips, not in rows, because the database is hosted and a
statement costs a network hop whether it carries one row or five thousand. A resolved package is
five statements: `begin`, the package upsert — which takes the `fetch_queue` row with it, in the
same statement — one statement for every version it has, the `fetch_log` insert, `commit`. The
versions travel as arrays through `unnest` and are upserted, with a `delete` of everything the
registry no longer lists riding along as a CTE, so replacing 137 versions costs one round trip
rather than the delete plus one insert per 200 rows it used to. The registry stays the whole truth
about a package — a version that disappears upstream disappears here — and the package never
sits versionless mid-transaction. Version lists past 5 000 rows take one more statement per chunk;
the stale delete goes on the first of them and is told the whole list.

## The fetch queue

`fetch_queue` is the resolver's message queue. A request, a feed, a poll sweep and the retry sweeper
only ever add rows to it; the demand-fill worker is the only thing that fetches. What it guarantees:

- **The work outlives the request.** A package queued by `/resolve` is fetched whether or not the
  stream that asked for it is still open, has timed out, or was abandoned by its caller.
- **At least once, one row per package.** The primary key is the package, so asking again while it
  is queued merges into the same row: its priority can only rise, its backoff schedule is kept, and
  its `requests` count goes up. A count that moved while the package was being fetched keeps the row
  for one more fetch, since that fetch may have started too early to see the change.
- **Somebody waiting comes first.** A package a `/resolve` caller waits for is urgent until that
  caller's deadline (`wanted_until`; several callers keep the latest), whatever queued it — the
  request itself, another request, a feed. Then everything nobody waits for, in this order:

  | rank | work |
  |---|---|
  | urgent | a caller is waiting; the soonest deadline first |
  | 20 | asked for, its caller gone (`demand`) — level with news from a feed (`feed`) |
  | 30 | a stale package nobody waits for (`refresh`) |
  | 50 | a retry (`retry`) |
  | 100 | feed polls and poll-sweep checks, which look for news rather than fetch it (limiters only) |

  Oldest first among equals. The order holds end to end: in the dequeue, and in every registry's
  limiter, which lets the best-ranked request waiting through next rather than the first to arrive.
  A fetch already running when somebody asks for its package becomes urgent there too. A request
  overtaken eight times in a limiter goes next regardless, so the feeds and sweeps that keep the
  database current always progress.
- **Capacity per ecosystem, not priority.** Each ecosystem may hold at most twice its limiter's
  width of the worker's slots (cargo 2, maven and pypi 8, the rest 16): a worker takes the most
  important row that can start now, and skips what its registry could not serve yet. A front of
  three hundred crates cannot hold up the npm behind it.
- **Leases.** A dequeued row is invisible to other workers for 2 minutes, and a heartbeat renews
  that every 30 s for as long as the fetch runs. A live fetch never loses its row; a worker that
  died gives its rows back after 2 minutes. Any number of workers can share the queue
  (`FOR UPDATE SKIP LOCKED`).
- **Retries.** A failed fetch backs off 30 s, then 2 min, and after three attempts the package is
  marked `error` (keeping any good data it had). The sweeper re-queues it an hour later, and
  `not_found` a day later.
- **Atomic settle.** The queue row goes in the same statement as the package write that answers
  it, so there is no window in which a package is written but still queued, or dropped but not
  written.
- **Signals, not dependencies.** Every queue write notifies `fetch_queued`, every terminal
  package write notifies `package_settled`, and a caller waiting for a package a worker holds
  notifies `package_wanted`, delivered by Postgres on commit only. A worker hears new work and new
  urgency, and a `/resolve` hears its packages land, without waiting for a poll, even across
  processes.
  Without them (`DATABASE_LISTEN=false`, or the connection down) everything still works, by polling.
- **Visible.** [`GET /queue`](resolver-api.md#get-queue) shows depth, urgency, age, retries and dead letters per
  ecosystem.

Why a table and not a broker (SQS, RabbitMQ, Redis): settling a queue row is part of the package
write's own statement, which no external broker can join without an outbox table that would be
this table again; the merge rule above — one row per package, priority only rising, backoff kept,
asks counted — is not something a broker expresses; and the limit on throughput is what the
registries allow, not how fast a queue can hand out work.

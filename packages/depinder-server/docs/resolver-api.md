# Resolver API

The contract a client (depinder) relies on: the resolver's endpoints, what `latest` means, and how
fresh an answer is.

## Endpoints

Every route except `/health` needs `Authorization: Bearer <RESOLVER_API_TOKEN>`; without it the
answer is `401`. Bodies are capped at 10 MB.

Answers are compressed when the caller sends `Accept-Encoding`, brotli (quality 4) for preference
and gzip (level 1) otherwise; a caller that sends none is answered uncompressed. Both sit at the
cheap end of their scales on purpose — on a 7 MB chunk, gzip 1 gives 3.9x and brotli 4 gives 5.8x,
while brotli's *default* quality would spend 36 s on the same payload for another 20%. `/feeds`,
`/queue` and the error bodies go through `@fastify/compress`, and only past 1 KB. `/resolve` cannot: the
plugin has no way to flush, so every line would sit in the compressor until the end. It compresses
for itself (`src/resolver/api/stream.ts`) whatever its size, sets `Content-Encoding` and
`Vary: Accept-Encoding`, and flushes after each batch of lines — brotli `BROTLI_OPERATION_FLUSH`,
gzip `Z_SYNC_FLUSH` — never after each line, so the window is kept and the ratio stays close to a
single body's. Node's `fetch` decodes both as the bytes arrive, but on its own it asks only for
`gzip, deflate`, and so would be answered in gzip. Depinder therefore sends
`Accept-Encoding: br, gzip` itself, as do the bench scripts (`bench/micro/bench-stream.cjs`).

### `POST /resolve`

```json
{ "purls": ["pkg:npm/express@4.18.2"], "max_age": 86400, "deadline_ms": 10000 }
```

| field | rule |
|---|---|
| `purls` | at most 5000 strings |
| `max_age` | seconds, default 86400 (a day — depinder's own default), may be 0. A resolved package whose `confirmed_at` is older than that, or null, is **stale** |
| `deadline_ms` | how long the stream may stay open, measured from when the request arrived. Default 10000, at most 60000; 0 = send what is known now |

`wait_ms`, the field `deadline_ms` replaced, is refused with a `400` that names `deadline_ms`, so an
old client fails loudly rather than misreading the answer.

The answer is `200` with `content-type: application/x-ndjson`: one JSON object per line, `\n` after
every line. Each line is final when it is sent, so a caller can act on it at once, while the server
is still fetching the rest. Purls are canonicalised and grouped by package key (a purl with no
version, no qualifiers and no subpath), and **each package key appears in exactly one line**,
carrying every purl that named it — forty versions of lodash cost one version list.

```json
{"key":"pkg:npm/express","purls":["pkg:npm/express@4.18.2","pkg:npm/express@4.17.1"],"status":"resolved","package":{
  "type": "npm", "namespace": null, "name": "express",
  "description": "…", "homepage_url": "…", "repo_url": "…",
  "licenses": ["MIT"],
  "latest": {"version": "4.18.2", "released_at": "…"},
  "latest_prerelease": {"version": "5.0.0-alpha.8", "released_at": "…"},
  "versions": [["4.17.1", 1558802552, 0], ["5.0.0-alpha.8", 1585150200, 1], ["4.18.2", 1665262010, 0, ["ISC"]]],
  "as_of": "…", "source": "registry.npmjs.org", "fetched_at": "…", "confirmed_at": "…"}}
{"key":null,"purls":["not-a-purl"],"status":"invalid","reason":"…"}
{"done":true,"feeds":{"npm":{"mode":"feed","lag_seconds":12,"cursor_time":"…"},"maven":{"mode":"poll","lag_seconds":3400,"cursor_time":null}}}
```

(The first line is wrapped here; on the wire every line is one line.)

| field | present |
|---|---|
| `key` | always. The package key, or `null` for an `invalid` purl |
| `purls` | always. The purls of this package **exactly as the caller sent them**. An invalid purl gets a line of its own, with one purl |
| `status` | always. One of the statuses below |
| `package` | for `resolved` and `refreshing` only |
| `reason` | for `error` and `invalid` only |

The last line is the trailer, `{"done":true,"feeds":{…}}`, exactly once, with each ecosystem's
freshness as `GET /feeds` reports it.

| status | sent when |
|---|---|
| `resolved` | known and confirmed within `max_age`: at once. Unknown, or stale: as soon as its fetch lands. A package fetched while the request waited is fresh whatever `max_age` says |
| `refreshing` | stale, and its refetch did not land by the deadline: at the deadline, with the last known facts. At once, if the refetch is scheduled after the deadline (a failed refresh's retry, a golang re-check), or as soon as a refresh gives up |
| `pending` | unknown and still not fetched at the deadline. It stays queued — ask again later |
| `not_found` | the registry says no such package: at once, or when a fetch ends that way. Re-checked after 24 h |
| `error` | the registry could not be read after three tries; `reason` says what failed. At once, or when a fetch ends that way |
| `invalid` | not a parseable purl, or a purl type this service does not cover; `reason` says which. At once |

On the wire the lines come roughly in this order: `invalid`, then everything final at once, then
unknown and stale packages as they land, then the leftovers at the deadline, then the trailer. Only
"trailer last" is part of the contract. A request with nothing left to wait for writes its trailer
and closes at once; it never idles until the deadline.

**Errors and truncation.** Everything up to the first database read and the queue writes is an
ordinary HTTP answer: `400` for a body it cannot use, `401` for a bad token, `500` if that first
read fails. The `200` is sent only once they have succeeded. After it the status cannot change, so
a failure is logged and the stream ends **without its trailer**. A stream that ends without one —
that, a reset socket, a crash — was cut short: every line already received is still a final fact,
and only the purls that got no line need asking again.

**Staleness.** A stale package is queued for a refetch below first-time fetches and feed events,
unless a fetch of it is already queued (that one is waited for) or a refetch is already scheduled
(`next_retry_at`: a failed refresh waiting out its retry, or a golang re-check), which a request
never pulls forward. A stream holds a stale package back while its refetch can still land, and
sends it `resolved` when its `fetched_at` moves — or `refreshing` at the deadline. Keep `max_age` at
six hours or more: maven and cargo are confirmed by a poll every 6 h, so below that they are
refetched on nearly every request — allowed, not advised. `not_found` and `error` keep their own
retry schedules, whatever `max_age` asks.

**How it waits.** The worker announces every package it commits — they share a process in the
default `ROLE=resolver` — and the stream gathers those announcements for 100 ms, then reads every
package they name in one query, and sends them. One read runs at a time per stream; whatever lands
during it goes into the next. Every 2 s it also reads every package it is still waiting on, which
is all it gets with the worker somewhere else or more than one instance. The versions of packages
known at once are read 500 packages at a time, with a flush after each slice, so the first lines
leave after the first round trip rather than after the whole read. There are no keepalive lines:
the deadline is capped at a minute, well inside undici's 300 s body timeout.

`versions` holds **every version the registry has**, oldest first (release date ascending, undated
first, then version), as compact tuples rather than objects:

    [version, released_at, flags]
    [version, released_at, flags, licenses]

- `released_at` is Unix epoch **seconds**, or `null` when the registry publishes no date.
- `flags` is a bitfield: `1` = prerelease, `2` = yanked, `0` = neither.
- `licenses` is present only when this version's list differs from the package-level `licenses`;
  a three-element tuple means "the same as the package". An explicit empty list on a version whose
  package has one is a difference, and ships as `[]`.

The tuples are built by the query itself (`json_agg` in `src/resolver/api/store.ts`), which is what keeps a
2 000-purl chunk to a few MB: the field names, the ISO strings and the two booleans this replaced
were three quarters of the bytes, and 88-94% of versions repeat their package's license list.
Package-level dates stay ISO — `latest` and `latest_prerelease` are derived from the tuples on the
way out. There is no per-purl `requested_version`: the caller finds its version in `versions`.

The package shape is `PackageRecord` in `@depinder/core` (`src/wire/package-record.ts`), defined
once for this server and the CLI. Core's `toPackageRecord` builds the same record straight from a
fetch, for the CLI's own fallback.

### `GET /feeds`

One row per ecosystem, all eight: mode, cursor, cursor time, last run, last success, last error
and the computed `lag_seconds`. The rows are read from the database at most every 5 s and shared
with `/resolve`, which ends every answer with the same eight rows; a cursor moves every 30 s at the
quickest, so nothing is lost by it.

### `GET /queue`

The fetch queue at a glance, read live (one query, not memoised):

```json
{
  "listener": "connected",
  "errors": 4,
  "total": {"queued": 35, "urgent": 13, "in_flight": 5, "due": 29, "retrying": 2, "oldest_due_s": 700},
  "types": {
    "cargo": {"queued": 30, "urgent": 10, "in_flight": 2, "due": 28, "retrying": 0, "oldest_due_s": 95, "by_priority": {"demand/feed": 30}},
    "npm": {"queued": 5, "urgent": 3, "in_flight": 3, "due": 1, "retrying": 2, "oldest_due_s": 700, "by_priority": {"demand/feed": 3, "retry": 2}}
  }
}
```

`urgent` is what a `/resolve` caller is waiting for right now (its deadline has not passed);
`in_flight` is held by a worker under a live lease; `due` is waiting for a free slot (or for the
cap its ecosystem is at); `retrying` has failed at least once; `oldest_due_s` is how long the oldest
due row has been asked for. `errors` counts packages that ran out of attempts and wait for the
sweeper's hourly retry — the dead letters. `listener` is this process's `LISTEN` connection:
`connected`, `reconnecting`, or `off` (`DATABASE_LISTEN=false`). See
[The fetch queue](resolver-internals.md#the-fetch-queue).

### `GET /health`

`{"status":"ok","db":"ok"}`, or `503` when the database is unreachable. Unauthenticated, because
container health checks have no token.

## What `latest` means

Depinder shows this number to users, so the policy is explicit:

- `latest` is the registry's own designation where one exists: npm `dist-tags.latest`, pypi
  `info.version`, gem `gems/<g>.json .version`, golang `@latest`, cargo `max_stable_version`. A
  designation naming a version that is missing or yanked is ignored.
- nuget and composer designate nothing and get the **highest version among versions that are not
  pre-releases**, by version order — what nuget.org's search answers with `prerelease=false`. Not
  the newest by date: both keep several majors alive, so the newest publish is often a servicing
  release of an older one (`Microsoft.Extensions.*` 9.0.20 published after 10.0.12,
  `laravel/framework` v11.57.0 after v13.34.0). A date-stamped version (`20020529`) ranks below
  any ordinary one.
- maven uses `<release>` from `maven-metadata.xml`, but only when it is not a pre-release
  (`2.2.0-M1`, `3.5.0-BETA7`) and not stale (some stable version deployed more than a day after
  it). Otherwise it gets the **newest release date among versions that are not pre-releases**,
  with version order breaking ties between versions deployed in the same minute. Either way, a
  latest with a letter-led qualifier gives way to its plain sibling when one exists
  (`1.18.14-jdk5` -> `1.18.14`); guava's `-jre` has no plain sibling and stays.
- Pre-release means a semver pre-release tag, or a version matching
  `/(alpha|beta|rc|milestone|snapshot|preview|dev|m\d+|cr\d+)/i`. Two carve-outs: composer treats
  `dev-<branch>` and `<branch>-dev` as pre-releases, and maven is exempt from the semver rule,
  because `-` there separates a qualifier — `32.1.2-jre` and `32.1.2-android` are guava's shipping
  flavours, not release candidates. pypi additionally follows PEP 440 (`1.0a1`, `2.0rc2`,
  `1.0.dev3`).
- Yanked, withdrawn and unlisted versions never win either slot, and neither do composer
  branches (`dev-master`, `0.x-dev`) — not even for a package whose tags are all pre-releases.
  Unlisted nuget versions still carry their release date (the catalog leaf's `created`; the
  registration's `published` is a `1900-01-01` sentinel for them).
- `latest_prerelease` is the newest version overall (the highest, for nuget and composer) when it
  differs from `latest`. It is therefore not always a pre-release: a stable version the registry
  has not promoted yet shows up here too.
- If every version looks like a pre-release, `latest` is the newest of them rather than nothing.

Both values are stored, so a caller can choose.

## Freshness: `fetched_at`, `as_of` and feed lag

Every package, in every ecosystem, records two instants:

- **`fetched_at`** — its last full fetch from the registry of record, stamped when that fetch
  *started*. A fetch asked for by a request, by a feed event, by a poll that saw a change, or by a
  retry all count. Nothing else moves it, and it only moves together with the version list, which
  is why the api's version cache keys on it.
- **`as_of`** — the latest instant the registry vouched for these facts. It is `fetched_at` after
  a full fetch, and moves later only when a maven or cargo poll is answered 304.

What each kind of row gets:

| row | `fetched_at` | `as_of` |
|---|---|---|
| `resolved` | the fetch that resolved it | `fetched_at`, or a later 304 (maven, cargo) |
| `not_found` | the fetch the registry answered 404 to — that is a full answer | `fetched_at` |
| `error`, never resolved | null | null |
| `resolved`, then a refresh gave up | unchanged: the last fetch that worked; `error` says the latest did not | unchanged |

Six ecosystems publish a change feed with a cursor; maven and cargo do not, and are kept fresh by
conditional GETs over the packages we track. `GET /feeds` says which mode each one is in. Between
fetches, the two modes vouch for a package differently:

- **poll mode** — a 304 moves `as_of` up to when the check was sent. A 200 re-queues the package
  and clears its validators, so a re-fetch that fails is found again on the next sweep. A
  package's first check holds no validators and gets a 200 either way: if the file's
  `Last-Modified` is more than ten minutes older than `fetched_at`, the fetch saw this state and
  the check vouches for it; if it is newer, the package is re-queued.
- **feed mode** — nothing is written per package: a feed that has moved on without naming a
  package vouches for it up to the feed's `cursor_time`, and rewriting every tracked row every
  30 s to say so would be absurd. It is worked out when a request reads the row, as
  `confirmed_at = greatest(as_of, cursor_time)`, and only when all of these hold — otherwise
  `confirmed_at` is `as_of`:
  - the package is `tracked`;
  - `fetched_at >= registry_feed.covered_since` — the feed was already running when the package
    was fetched, so it cannot have missed a change in between (`covered_since` is set when the
    cursor is first initialised);
  - `error` is null — the last attempt to refresh it did not fail;
  - it has no `fetch_queue` row — no event about it is still waiting to be fetched.

**`confirmed_at`** is what a package's age is measured from: the latest instant we can show its facts
matched the registry, in every ecosystem. It is computed, never stored (`PACKAGES_SQL` in
`src/resolver/api/store.ts`), shipped on every package next to `as_of` and `fetched_at`, and compared with
the request's `max_age`. In poll mode it is `as_of`; in feed mode it is the rule above. A feed that
stops moving stops vouching, so its packages go stale on their own.

A package asked for again while it is being fetched — a feed event arriving mid-fetch — keeps its
queue row and is fetched once more, because the fetch in hand may have been too early to see it.
`fetch_queue.requests` counts the asks; a fetch removes the row only if the count is still the one
it dequeued.

`lag_seconds` is time since `cursor_time` in feed mode, time since the last successful sweep
(`last_ok_at`) in poll mode. The 6 h poll interval would make that null for six hours after every
restart, so the first sweep runs 60 s after boot.

**The lag caveat for npm and gem.** Both feeds carry no timestamps — npm's `_changes` rows have
none, and rubygems' compact index is plain appended text — so for those two `cursor_time` is the
wall-clock time of the last successful read. Their lag answers "how long since we looked", not
"how far behind the head are we". Since both loops start at the current head and read every 30 s
and 120 s, the two numbers are the same in practice; they diverge only while draining a backlog
after downtime, where the reported lag is optimistic.

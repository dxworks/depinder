# depinder-server

The `depinder-server` project of the depinder monorepo (`packages/depinder-server`).

A purl resolver. It owns one problem: **the facts about a package** — its versions, their release
dates and their licenses — for the eight ecosystems depinder analyses (maven, npm, pypi, nuget,
composer, gem, golang, cargo).

Depinder today asks every registry about every dependency, project after project, and pays the
full upstream latency on every run. This service answers thousands of purls in one call. It fills
itself on demand, keeps what it holds fresh from each registry's change feed, and records where
every fact came from and how old it is.

All eight registries are implemented. How a package is fetched lives in `@depinder/core`
(`packages/depinder-core/src/registries/`, shared with the depinder CLI); how it is kept fresh — one
feed or poll file each — under `src/resolver/registries/`. See
[docs/adding-a-registry.md](docs/adding-a-registry.md) for the contract they share.

## Roles

One image, one entry point (`src/main.ts`); `ROLE` decides what a process runs:

- **resolver** — `ROLE=resolver-api` serves `/resolve`, `/feeds`, `/queue` and `/health`;
  `ROLE=resolver-worker` fills the fetch queue and follows the registries' feeds; `ROLE=resolver`
  (the default) runs both in one process. It needs Postgres.
- **vulnerability server** — `ROLE=vuln`: purls in, Trivy and Grype findings out. No Postgres. See
  [docs/vuln-server.md](docs/vuln-server.md).

## Ecosystems

| purl type | source(s) of record | freshness | interval |
|---|---|---|---|
| `npm` | `registry.npmjs.org` (packument) | feed — `replicate.npmjs.com/_changes`, cursor = sequence | 30 s |
| `pypi` | `pypi.org/pypi/<name>/json` | feed — XML-RPC `changelog_since_serial`, cursor = serial | 60 s |
| `nuget` | `api.nuget.org` (registration pages) | feed — catalog, cursor = `commitTimeStamp` | 60 s |
| `composer` | `repo.packagist.org` (p2 metadata) | feed — `packagist.org/metadata/changes.json` | 60 s |
| `golang` | `proxy.golang.org`, `api.deps.dev` (licenses) | feed — `index.golang.org/index?since=` | 60 s |
| `gem` | `rubygems.org/api/v1` | feed — compact index `rubygems.org/versions`, cursor = byte offset | 120 s |
| `maven` | `repo1.maven.org` (`maven-metadata.xml`, POMs) | poll — conditional GET on `maven-metadata.xml` | 6 h |
| `cargo` | `crates.io/api/v1` | poll — conditional GET on `index.crates.io` | 6 h |

Only golang needs a second host: `proxy.golang.org` has the versions and their times but no
licenses, so those come from deps.dev, and such a package's `source` names both
(`proxy.golang.org, api.deps.dev`). deps.dev scans a version some time after it is published, so a
golang version the feed has just announced can be stored with no licence; while that version is
under a week old the package is fetched again every 6 h until deps.dev knows it. What `fetched_at` and `as_of` mean, how the two freshness
modes vouch for a package between fetches, how that becomes `confirmed_at` and decides whether a
request's `max_age` is met, and `lag_seconds` — including the caveat for npm and gem — is under [Freshness](docs/resolver-api.md#freshness-fetched_at-as_of-and-feed-lag).

## Quick start

```bash
cp .env.example .env          # set DATABASE_URL and RESOLVER_API_TOKEN
npm ci                        # once, at the monorepo root
npm run dev                   # in packages/depinder-server; migrations run at boot

curl -s localhost:8080/health
curl -sN --compressed -X POST localhost:8080/resolve \
  -H "Authorization: Bearer $RESOLVER_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"purls":["pkg:npm/express@4.18.2","pkg:npm/@babel/core@7.24.0"],"deadline_ms":10000}'
```

The answer is a stream, one line per package. A package we hold comes back at once; an unknown one
is queued and comes back `resolved` as soon as the worker has fetched it, or `pending` if
`deadline_ms` runs out first. A package we hold but have not confirmed within the request's
`max_age` is refetched, and comes back when that lands — or `refreshing`, with the facts we have,
at the deadline.

## Read next

- [docs/resolver-api.md](docs/resolver-api.md) — the resolver's endpoints, what `latest` means, freshness
- [docs/resolver-internals.md](docs/resolver-internals.md) — how it works, the fetch queue
- [docs/vuln-server.md](docs/vuln-server.md) — the vulnerability server (`ROLE=vuln`)
- [docs/configuration.md](docs/configuration.md) — environment variables, Docker
- [docs/development.md](docs/development.md) — tests, integration tests, typecheck, build
- [docs/benchmarks.md](docs/benchmarks.md) — the end-to-end bench and the micro benches
- [docs/adding-a-registry.md](docs/adding-a-registry.md) — the contract every registry holds to
- The dev database: bring your own Postgres (`DATABASE_URL` in your local env file), or ask Alex
  for access to the shared dev database

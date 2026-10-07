# Adding a registry

An ecosystem has two halves, each one file (or folder) per purl type:

- **fetching** lives in `@depinder/core`, shared with the depinder CLI:
  `packages/depinder-core/src/registries/<purl-type>.ts`, exporting a `PackageFetcher`, registered in
  `packages/depinder-core/src/registries/index.ts`. Core's `npm.ts` is the reference implementation —
  read it first, it is short.
- **keeping fresh** lives in this server: `src/resolver/registries/<purl-type>-feed.ts` (or
  `-poll.ts`), exporting a `FeedSpec`, registered in `src/resolver/registries/index.ts`.

All eight ecosystems depinder analyses (npm, maven, pypi, nuget, composer, gem, golang, cargo) are
implemented, so this is the guide for adding a ninth, and the contract to hold to when changing one
of the eight. The table at the end says what each existing registry reads.

Nothing outside your two files and the line in each `index.ts` should need to change — a purl type
that is not one of the eight also needs a line in `SUPPORTED_TYPES` in core's `src/purl.ts`. If
anything else does, say so rather than reaching into the worker or the API.

## The interface

From core's `src/registries/types.ts`:

```ts
export interface PackageFetcher {
    /** purl type, e.g. `npm`. Must match the key in the `fetchers` map. */
    type: string
    /**
     * All facts about one package. `null` means the registry answered "no such package" (404).
     * Anything else — a 5xx, a timeout, a malformed body — must throw, so the caller can retry.
     */
    fetchPackage(key: ParsedPurl, ctx: FetchContext): Promise<FetchedPackage | null>
}

export interface FetchedPackage {
    description?: string
    homepageUrl?: string
    repoUrl?: string
    /** Library-level licenses. `[]` when the registry publishes none. */
    licenses: string[]
    versions: FetchedVersion[]
    /** The registry's own "latest" designation, if it has one. */
    registryLatest?: string
    /** Hosts the facts came from, e.g. `['registry.npmjs.org']`. Stored as provenance. */
    sources: string[]
    /** Facts known to be incomplete for now: fetch the package again at this time. */
    recheckAt?: Date
}

export interface FetchedVersion {
    /** Exactly as the registry spells it. Not normalised, not stripped of a leading `v`. */
    version: string
    releasedAt: Date | null
    /** SPDX-ish strings, already normalised by the registry file. `[]` when unknown. */
    licenses: string[]
    prerelease: boolean
    /** Yanked (cargo), unlisted (nuget), withdrawn (pypi). Excluded from `latest`. */
    yanked: boolean
}

export interface FetchContext {
    /** Timeout, User-Agent and the caller's per-ecosystem limiter. Never call `fetch`. */
    http: HttpClient
    log: Logger
}
```

Nobody calls a fetcher directly: callers go through core's `fetchPackage(key, ctx)`, which picks
the fetcher for the purl type. In this server that is the demand-fill worker: a `null` is stored as
`not_found` and retried in 24 h, a throw is retried by the queue with backoff.

The server's half, from `src/resolver/registries/types.ts`, is the `FeedSpec` described under
[Feeds](#feeds).

## fetchPackage

- The name the registry wants is `registryName(key)` from core's `src/purl.ts`: maven gets
  `group:artifact`, npm `@scope/name`, composer `vendor/pkg`, golang the full module path,
  everything else the bare name. Do not reassemble it yourself, and URL-encode whatever the
  registry's URL scheme needs.
- `404` (and any other "we have never heard of this package" answer) → return `null`. Everything
  else that is not a usable response → throw. The queue retries a throw three times with 30 s /
  2 min backoff and then flags the package `error`; a `null` is stored as `not_found` and retried
  in 24 hours. Getting this distinction right is the whole difference between a typo costing one
  request a day and costing three an hour.
- Return every version the registry lists, in the registry's own order (oldest first is what the
  latest-version tie-breaker assumes when release dates are missing).
- `prerelease` comes from `isPrerelease(type, version)` in core's `src/registries/latest.ts`.
  Use it rather than inventing a rule; if your ecosystem needs a carve-out, add it there with a test in
  core's `test/registries/latest.test.ts` — maven and composer already have one.
- Do **not** compute `latest` yourself. Set `registryLatest` when the registry designates one
  (npm `dist-tags.latest`, pypi `info.version`, gem `gems/<g>.json .version`, golang `@latest`,
  cargo `max_stable_version`) and leave it undefined otherwise; core's `fetchPackage` applies
  `computeLatest` to every fetch, so no caller can skip it.
- Licenses: run whatever the registry gave you through `normaliseLicenses` from
  `./normalise.ts`. It flattens strings, `{type}` objects and arrays, and leaves SPDX expressions
  (`"MIT OR Apache-2.0"`) whole. `toDate` and `normaliseRepoUrl` are there for the same reason —
  so that eight registries agree on what a date and a repository URL look like.
- When a registry has no per-version license (maven, while core's `MAVEN_PER_VERSION_LICENSES` is
  off), fall back to the library-level list rather than leaving versions empty.
- A setting that would change the facts (not just the speed) is never a per-side option: it is a
  constant in core's `src/facts.ts`, the same for the CLI and this server.
- `sources` is the host list, for provenance: `['repo1.maven.org']`, or
  `['proxy.golang.org', 'api.deps.dev']` when two hosts contributed.
- `recheckAt` is for facts you know are not final yet and that no feed will tell you about when
  they are. It is stored as `next_retry_at`, and the sweeper re-queues the package when it comes
  due. golang sets it when deps.dev has not scanned a version under a week old; leave it unset
  otherwise, and never use it as a polling schedule.

## HTTP

Everything goes through `ctx.http` — `get(url, opts)` and `request(url, opts)`, core's client. It
applies the timeout, the User-Agent that crates.io and others require, and the caller's
per-ecosystem limiter. **Never call global `fetch`**: a request that bypasses `ctx.http` bypasses
politeness and provenance both.

Responses are already buffered: `response.status`, `response.ok` (200–299, so a 304 is *not* ok),
`response.headers`, `response.text`, `response.json<T>()`. gzip/br is decoded by undici — do not
set `accept-encoding` yourself.

Core has no numbers of its own: every caller passes its limits. This server's live in
`src/resolver/registries/http.ts`, which also ranks waiting requests (urgent fetches first) and
records every request for `fetch_log`:

```ts
export const RATE_LIMITS: Record<string, LimitSpec> = {
    cargo: {concurrency: 1, minIntervalMs: 1000},
    maven: {concurrency: 4, minIntervalMs: 0},
    pypi: {concurrency: 4, minIntervalMs: 0},
}
export const DEFAULT_LIMIT: LimitSpec = {concurrency: 8, minIntervalMs: 0}
```

If your registry publishes a rate limit, add a row there (and to the CLI's limits).

## Feeds

`feed` is one of two shapes. Which one you pick is visible on `GET /feeds` and changes what can
vouch for your packages between fetches — the live feed cursor, or a 304 — so pick the one that
matches what upstream actually offers. See [Freshness](resolver-api.md#freshness-fetched_at-as_of-and-feed-lag).

### `mode: 'feed'` — the registry has a change stream

```ts
{
    mode: 'feed'
    intervalMs: number
    initialCursor(ctx): Promise<string>
    poll(cursor: string, ctx): Promise<FeedResult>
}
// FeedResult: { events: {packageKey, at: Date|null}[]; cursor: string; cursorTime: Date|null; headTime: Date|null }
```

- `initialCursor` is called once, when nothing is stored: return the **current head**, not the
  beginning of time. The worker records that moment as `covered_since`; packages fetched before
  it are not counted as covered by the feed.
- `poll` reads one batch from the stored cursor and returns the new cursor. The worker persists it
  in `registry_feed`, so an interrupted process resumes where it stopped.
- Build `packageKey` with `fromRegistryName(type, name).packageKey` (or `parsePurl`) — never by
  string concatenation, or your keys will not match the ones in the database.
- Emit **every** event in the batch. The worker filters them against the packages we track with a
  single query; filtering in the registry would make that query wrong.
- `cursorTime` is the freshness claim: the newest event time the batch reached. `headTime` is
  upstream's own head time if it publishes one, used when a batch was empty. Return `null` for
  either when the feed gives you nothing to base it on; the stored value is then left alone.
- Intervals in use: npm 30 s, pypi/nuget/composer/golang 60 s, gem 120 s. A feed loop makes its
  first read one interval after boot; the cursor is stored, so a skipped tick costs nothing.

### `mode: 'poll'` — no change stream (maven, cargo)

```ts
{
    mode: 'poll'
    intervalMs: number
    check(target: PollTarget, ctx): Promise<PollResult>
}
// PollTarget: { packageKey; key: ParsedPurl; etag: string|null; lastModified: string|null; fetchedAt: Date|null }
// PollResult: { changed: boolean; confirmed: boolean; etag?: string|null; lastModified?: string|null }
```

- The worker walks the tracked packages of your type in pages of 200 and calls `check` on each,
  concurrently — the limiter is what keeps that polite, so do not add sleeps.
- Make a conditional GET on the cheapest thing that changes when the package changes
  (`maven-metadata.xml`, the crates.io sparse index entry) with `If-None-Match` / 
  `If-Modified-Since` from `target.etag` / `target.lastModified`.
- Answer with the helpers in `poll-validators.ts`, as maven and cargo do: `notModified(target)` for a 304,
  `modified(target, response.headers)` for a 200, `{changed: false, confirmed: false}` for anything
  that says nothing either way (a 404 on a file that should be there). They hold the rules below,
  which are what make a 304 safe to believe.
- `confirmed: true` means the registry vouched that nothing changed since the last full fetch;
  the worker moves the package's `as_of` up to the time of the check (never `fetched_at`). A 304
  confirms, but only for a package with a `fetchedAt` — a row never fully fetched has nothing to vouch for.
- A 200 against stored validators is a change: the package is re-queued and its validators are
  **cleared**, not replaced. Stored now, they would outlive a re-fetch that fails, and the next
  304 would vouch for data that never saw the change.
- **The first check of a package holds no validators**, so upstream can only answer 200.
  `Last-Modified` decides: older than `fetchedAt` by more than `FIRST_CHECK_MARGIN_MS` (10 min)
  means the fetch saw this state — store the validators and confirm. Newer means it changed after
  we looked — re-queue. No header means nothing can be said: store the validators, confirm nothing.
- Omitting `etag`/`lastModified` keeps what is stored; passing `null` clears it.
- A throw fails that one package's check and is logged at debug; it does not stop the sweep.
- Interval in use: 6 h (`6 * 60 * 60 * 1000`). The **first** sweep runs 60 s after boot
  (`POLL_FIRST_SWEEP_MS` in `src/resolver/worker/feeds.ts`), not 6 h in: lag in poll mode is measured from
  the last successful sweep, so a first sweep an interval away would leave `/feeds` reporting
  `lag_seconds: null` for six hours after every restart.

## Registering it

```ts
// packages/depinder-core/src/registries/index.ts — the eight that are there today, plus yours
export const fetchers: Readonly<Record<string, PackageFetcher>> = {
    npm: npmFetcher,
    // ...
    swift: swiftFetcher, // <- your line
}

// src/resolver/registries/index.ts
const feeds: Record<string, FeedSpec> = {
    npm: npmFeed,
    // ...
    swift: swiftFeed, // <- your line
}
```

Until that line exists, purls of your type are accepted by the API and the worker marks them
`error` with `no registry implemented for type "<x>"`. Nothing crashes, which is what let the
eight files land independently, and it is what keeps a new purl type harmless while its registry
file is being written.

`src/main.ts` calls `ensureFeedRows` at boot, which creates the `registry_feed` row from your
`feed.mode`. There is nothing else to wire up.

## Tests

No network. The fetcher's tests are core's `test/registries/<type>.test.ts`, the pattern is in
core's `test/registries/npm.test.ts`:

- put a trimmed real response in core's `test/fixtures/<type>-<thing>.json` and read it with
  `fixtureJson` / `fixtureText` from `test/registries/registry.helpers.ts`;
- `vi.stubGlobal('fetch', ...)` returning `new Response(JSON.stringify(body), {status})`, and
  `vi.unstubAllGlobals()` in `afterEach`;
- build the `FetchContext` with `testContext(records)`, which records every request.

Cover at least: the happy path mapping (versions, dates, licenses, `registryLatest`), each license
spelling your registry uses, 404 → `null`, 5xx → throws, and the URL you build for an awkward name
(scope, group, module path).

The feed's tests are this server's `test/resolver/registries/<type>-feed.test.ts` (fixtures in
`test/fixtures/`, helpers in `feed.helpers.ts`). Cover both feed methods.

`npx nx run-many -t typecheck lint test -p depinder-core depinder-server` must pass before you hand back.

## What the registries look like (probed 2026-09-16)

| type | facts | change detection |
|---|---|---|
| maven | `repo1.maven.org/maven2/<g/>/<a>/maven-metadata.xml`, directory listing for dates, `<a>-<v>.pom` for `<licenses>` with a parent walk (depth 5). Per-version POMs only when core's `MAVEN_PER_VERSION_LICENSES` (off). Never search.maven.org. | poll: conditional GET on `maven-metadata.xml` (ETag + Last-Modified both present) |
| pypi | `pypi.org/pypi/<name>/json`: `releases[v][0].upload_time_iso_8601`, `yanked`, `info.version`, license precedence `license_expression` > `license` > `License ::` classifier | feed: XML-RPC `changelog_since_serial(serial)` on `pypi.org/pypi` |
| nuget | `api.nuget.org/v3/registration5-gz-semver2/<id-lower>/index.json` plus non-inlined pages: `catalogEntry.version/published/licenseExpression/licenseUrl/listed`. Cap the page fan-out. | feed: catalog `api.nuget.org/v3/catalog0/index.json`, cursor = `commitTimeStamp` |
| composer | `repo.packagist.org/p2/<vendor>/<pkg>.json` and `~dev.json`, minified (expand per composer/metadata-minifier) | feed: `packagist.org/metadata/changes.json?since=<ts*10000>` |
| gem | `rubygems.org/api/v1/versions/<gem>.json` (`number`, `created_at`, `licenses[]`, `prerelease`), `api/v1/gems/<gem>.json` for latest + urls | feed: compact index `rubygems.org/versions` with `Range: bytes=<offset>-` and ETag |
| golang | `proxy.golang.org/<esc>/@v/list`, `/@v/<v>.info`, `/@latest`; licenses from `api.deps.dev/v3/systems/go/packages/<enc>/versions/<v>` | feed: `index.golang.org/index?since=<RFC3339>&limit=2000` |
| cargo | `crates.io/api/v1/crates/<name>`: `versions[].num/created_at/license/yanked`, `max_stable_version` | poll: conditional GET on `index.crates.io/<p1>/<p2>/<name>` |

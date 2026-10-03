import type {HttpClient} from './http.js'
import type {Logger} from '../../shared/log.js'
import type {ParsedPurl} from '../../shared/purl.js'

/**
 * The contract every ecosystem implements. One file per purl type in this folder, registered in
 * `index.ts`. See `docs/adding-a-registry.md`.
 */

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
    /**
     * Set when these facts are known to be incomplete for now, and when to fetch the package
     * again. Stored as `next_retry_at`, which the sweeper re-queues once it is due. golang uses it
     * for a new version deps.dev has not scanned yet. Absent means the facts are as complete as
     * the registry can make them.
     */
    recheckAt?: Date
}

/** A package the feed says changed. `at` is the event time when the feed carries one. */
export type FeedEvent = {packageKey: string; at: Date | null}

export interface FeedResult {
    events: FeedEvent[]
    /** Cursor to store and pass to the next `poll`. */
    cursor: string
    /** How far the consumed batch reaches in time; null leaves the stored value alone. */
    cursorTime: Date | null
    /** Upstream's own head time, when it reports one. Used for lag when a batch was empty. */
    headTime: Date | null
}

/** What a poll-mode registry is asked about: one tracked package and its stored validators. */
export interface PollTarget {
    packageKey: string
    key: ParsedPurl
    etag: string | null
    lastModified: string | null
    /** The package's last full fetch. Null for a row never fully fetched, which nothing can vouch for yet. */
    fetchedAt: Date | null
}

export interface PollResult {
    /** true => the worker enqueues a full re-fetch of the package. */
    changed: boolean
    /**
     * true => the registry vouched that nothing changed since the last full fetch, and the
     * package's `as_of` moves up to the time of this check. A 304, or a first check whose
     * `Last-Modified` predates the fetch. See `notModified` and `modified` in `shared.ts`.
     */
    confirmed: boolean
    /** Validators to store for the next round. Omit to keep what is stored; null clears one. */
    etag?: string | null
    lastModified?: string | null
}

// [11] Freshness, two shapes: 'feed' = upstream has a change stream, 'poll' = it has none (maven, cargo). Next [12], npm.ts.
export type FeedSpec =
    | {
          mode: 'feed'
          /** How often the loop runs. */
          intervalMs: number
          /** Cursor to start from when nothing is stored yet: the current head, not the beginning. */
          initialCursor(ctx: FetchContext): Promise<string>
          poll(cursor: string, ctx: FetchContext): Promise<FeedResult>
      }
    | {
          mode: 'poll'
          intervalMs: number
          check(target: PollTarget, ctx: FetchContext): Promise<PollResult>
      }

export interface FetchContext {
    /** Timeout, User-Agent, per-ecosystem limiter and fetch_log recording. Never call `fetch`. */
    http: HttpClient
    log: Logger
    options: RegistryOptions
}

export interface RegistryOptions {
    mavenPerVersionLicenses: boolean
}

// [10] THE CONTRACT [7] calls. An ecosystem is exactly these three members — one file per purl type.
export interface Registry {
    /** purl type, e.g. `npm`. Must match the key in the `registries` map. */
    type: string
    /**
     * All facts about one package. `null` means the registry answered "no such package" (404),
     * which is stored as `not_found` and retried in 24 h. Anything else — a 5xx, a timeout, a
     * malformed body — must throw, so the queue retries with backoff.
     */
    fetchPackage(key: ParsedPurl, ctx: FetchContext): Promise<FetchedPackage | null>
    feed: FeedSpec
}

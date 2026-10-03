/** Row shapes as `pg` returns them: snake_case columns, `timestamptz` as Date, `text[]` as string[]. */

export type PackageStatus = 'pending' | 'resolved' | 'not_found' | 'error'

export interface PackageRow {
    package_key: string
    type: string
    namespace: string | null
    name: string
    description: string | null
    homepage_url: string | null
    repo_url: string | null
    licenses: string[]
    latest_version: string | null
    latest_prerelease_version: string | null
    status: PackageStatus
    error: string | null
    source: string | null
    /** The last full fetch from the registry of record, stamped when it started. Null until one completes. */
    fetched_at: Date | null
    /** The latest instant the registry vouched for these facts: `fetched_at`, or later after a poll 304. */
    as_of: Date | null
    tracked: boolean
    poll_etag: string | null
    poll_last_modified: string | null
    next_retry_at: Date | null
}

/**
 * A package as `POST /resolve` reads it: the row, plus what the request needs to decide whether it
 * is still fresh. Both are worked out by the query, from `registry_feed` and `fetch_queue`.
 */
export interface ResolvePackageRow extends PackageRow {
    /**
     * The latest instant we can show these facts matched the registry: `as_of`, or the feed's
     * `cursor_time` when the feed vouches for the package. See "Freshness" in docs/resolver-api.md.
     */
    confirmed_at: Date | null
    /** The package has a `fetch_queue` row: a fetch of it is already on its way. */
    queued: boolean
}

export interface PackageVersionRow {
    purl: string
    package_key: string
    version: string
    released_at: Date | null
    licenses: string[]
    prerelease: boolean
    yanked: boolean
    source: string | null
    fetched_at: Date | null
}

/**
 * A version as `POST /resolve` ships it — a tuple, not an object, and the wire contract both repos
 * implement:
 *
 *     [version, released_at, flags]
 *     [version, released_at, flags, licenses]
 *
 * `released_at` is Unix epoch **seconds** (integer, floored), or `null` when the registry publishes
 * no date. `flags` is a bitfield: 1 = prerelease, 2 = yanked, 0 = neither. The fourth element is
 * present only when this version's license list differs from the package-level one; a three-element
 * tuple means "the same as `package.licenses`", which is what 88-94% of versions are.
 *
 * The shape exists because the version array is 95% of a response: the field names, the ISO strings
 * and the two booleans that this replaces were three quarters of those bytes. Never a subset —
 * every version the registry has is still sent, in the same order as before.
 */
export type CompactVersion =
    | [version: string, releasedAt: number | null, flags: number]
    | [version: string, releasedAt: number | null, flags: number, licenses: string[]]

/**
 * One row of the version query: every version of one package, already aggregated and ordered by
 * Postgres. `versions` arrives parsed, because `pg` decodes `json` for us.
 */
export interface PackageVersionsRow {
    package_key: string
    versions: CompactVersion[]
}

export interface RegistryFeedRow {
    type: string
    mode: 'feed' | 'poll'
    cursor: string | null
    cursor_time: Date | null
    last_run_at: Date | null
    last_ok_at: Date | null
    upstream_head_time: Date | null
    last_error: string | null
    /** When the feed began covering its ecosystem: set when the cursor is first initialised. */
    covered_since: Date | null
    /** Computed in SQL: now() - cursor_time (feed mode) or now() - last_ok_at (poll mode). */
    lag_seconds: number | null
}

/** One `(type, priority)` group of `fetch_queue`, as `GET /queue` reports it. */
export interface QueueGroupRow {
    type: string
    priority: number
    queued: number
    /** Somebody is waiting for it: `wanted_until` is still ahead. Queued or in flight. */
    urgent: number
    /** Held by a worker whose lease has not run out. */
    in_flight: number
    /** Waiting for a free slot: `next_attempt_at` has passed and nobody holds it. */
    due: number
    /** Failed at least once and waiting out its backoff, or due again after it. */
    retrying: number
    /** Seconds since the oldest due row was asked for. 0 when nothing is due. */
    oldest_due_s: number
}

export interface QueueStats {
    groups: QueueGroupRow[]
    /** Packages that ran out of attempts and wait for the sweeper's hourly retry: the dead letters. */
    errors: number
}

export interface FetchQueueRow {
    package_key: string
    priority: number
    requested_at: Date
    attempts: number
    next_attempt_at: Date
    last_error: string | null
    /** Times the package was asked for while queued; see `enqueue`. */
    requests: number
    /** The purl type, derived from the key by the database. What fair dequeue counts slots by. */
    type: string
    /** A worker holds the row: what the lease heartbeat renews. */
    leased: boolean
    /** Until when a `/resolve` caller waits for this package; urgent while it is in the future. */
    wanted_until: Date | null
}

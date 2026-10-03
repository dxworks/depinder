import type {FetchContext, ParsedPurl} from '@depinder/core'

/**
 * The server's half of an ecosystem: how it learns that a package changed. The fetch half is
 * core's `PackageFetcher`. One file per purl type in this folder, registered in `index.ts`. See
 * `docs/adding-a-registry.md`.
 */

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
     * `Last-Modified` predates the fetch. See `notModified` and `modified` in `poll-validators.ts`.
     */
    confirmed: boolean
    /** Validators to store for the next round. Omit to keep what is stored; null clears one. */
    etag?: string | null
    lastModified?: string | null
}

// [11] Freshness, two shapes: 'feed' = upstream has a change stream, 'poll' = it has none (maven, cargo). Next [12], core's npm.ts.
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

/** An ecosystem as the feed loops see it: its purl type and its feed. */
export interface Registry {
    /** purl type, e.g. `npm`. Must match the key in the `registries` map. */
    type: string
    feed: FeedSpec
}

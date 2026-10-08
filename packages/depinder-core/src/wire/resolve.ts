import type {PackageRecord} from './package-record.js'

/**
 * `POST /resolve`: the request body, its limits, and the NDJSON lines of the answer, as the server
 * sends them and the CLI reads them. See "POST /resolve" in the server's docs/resolver-api.md.
 */

/** The most purls one request may carry; more is a 400. */
export const RESOLVE_MAX_PURLS = 5000
/** How long the stream may stay open when the request names no `deadline_ms`. */
export const RESOLVE_DEFAULT_DEADLINE_MS = 10_000
/** The longest `deadline_ms` a request may ask for (more is a 400); well inside undici's 300 s body timeout. */
export const RESOLVE_MAX_DEADLINE_MS = 60_000
/** The `max_age` a request gets when it names none: a day. */
export const RESOLVE_DEFAULT_MAX_AGE_S = 86_400

export interface ResolveRequestBody {
    purls: string[]
    /** Milliseconds the stream may stay open waiting for packages, at most `RESOLVE_MAX_DEADLINE_MS`. */
    deadline_ms?: number
    /** Seconds since `confirmed_at` a package may be and still count as fresh. */
    max_age?: number
}

/**
 * `resolved` and `refreshing` carry a package; `refreshing` is one held but not confirmed within
 * `max_age`, sent with its last known facts. `pending` is a package never seen and not fetched by
 * the deadline, `error` one whose registry could not be read.
 */
export type ResolveStatus = 'resolved' | 'refreshing' | 'not_found' | 'pending' | 'invalid' | 'error'

/** How current one ecosystem's registry feed is. */
export interface FeedFreshness {
    mode: 'feed' | 'poll'
    lag_seconds: number | null
    cursor_time: string | null
}

/** One line per package key, sent once per stream. */
export interface ResolveItem {
    /** The canonical package key, or null for an `invalid` purl (which gets an item of its own). */
    key: string | null
    /** The purls exactly as the caller sent them that belong to this package. */
    purls: string[]
    status: ResolveStatus
    /** Present for `resolved` and `refreshing`. */
    package?: PackageRecord
    /** Present for `error` and `invalid`. */
    reason?: string
}

/** The last line, exactly once. A stream that ends without it was cut short. */
export interface ResolveTrailer {
    done: true
    /** Per ecosystem type; empty when the server knows no feed state. */
    feeds: Record<string, FeedFreshness>
}

export type ResolveLine = ResolveItem | ResolveTrailer

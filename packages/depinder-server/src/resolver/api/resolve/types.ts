import type {ResolverEvents} from '../../events.js'
import type {Logger} from '@depinder/core'
import type {CompactVersion} from '../../db/rows.js'
import type {ResolveStore} from '../store.js'
import type {VersionCache} from '../version-cache.js'

/**
 * The limits of `POST /resolve` and the shapes that cross its edges: the request, the lines of
 * the answer, the sink they go to and what the handler is given. `handle.ts` is how it is answered.
 */

export const MAX_PURLS = 5000
/** How long a request may keep its stream open when it names no `deadline_ms`. */
export const DEFAULT_DEADLINE_MS = 10_000
/**
 * The longest a caller may ask for. Well inside undici's 300 s body timeout, and short enough that
 * no idle-timing proxy has been met that would cut a quiet stream first — which is why there are
 * no keepalive lines. If one ever is, a bare `\n` every 15 s, which clients skip, is the fix.
 */
export const MAX_DEADLINE_MS = 60_000
/**
 * The `max_age` a request gets when it names none: a day, which is depinder's own default. Below
 * six hours maven and cargo are stale on almost every request — their poll vouches for a package
 * every 6 h — so a caller asking for less gets those refetched, which is allowed, not advised.
 */
export const DEFAULT_MAX_AGE_S = 86_400
/**
 * How often the wait reads every key it is still waiting on, whatever it has heard.
 *
 * With the worker in the same process this is the fallback rather than the mechanism — a `settled`
 * event is what makes the stream look — so it can be slow. It is what a split `ROLE`, or a second
 * instance, whose workers never tell this process anything, falls back to.
 */
export const POLL_INTERVAL_MS = 2_000
/**
 * How long the wait keeps gathering after the first `settled` event, before reading. A busy worker
 * lands packages a few milliseconds apart, and one read for twenty of them costs one round trip
 * where twenty reads would cost twenty; a tenth of a second is invisible next to the fetch itself.
 */
export const GATHER_MS = 100
/**
 * The most packages one version read asks for, and so the most one flush carries. A 2 000-package
 * `json_agg` is several megabytes the client would otherwise wait for whole; in slices of 500 the
 * first bytes leave after the first ~50-100 ms round trip, and a chunk still costs four queries,
 * never one per package.
 */
export const VERSION_SLICE = 500

export type ResultStatus = 'resolved' | 'refreshing' | 'not_found' | 'pending' | 'invalid' | 'error'

/**
 * One version on the wire. See {@link CompactVersion}: `[version, epochSeconds | null, flags]`,
 * with a fourth `licenses` element only when this version's licenses differ from the package's.
 */
type VersionPayload = CompactVersion

export interface PackagePayload {
    type: string
    namespace: string | null
    name: string
    description: string | null
    homepage_url: string | null
    repo_url: string | null
    licenses: string[]
    latest: {version: string; released_at: string | null} | null
    latest_prerelease: {version: string; released_at: string | null} | null
    /** Every version the registry has, oldest first. Never a subset. */
    versions: VersionPayload[]
    as_of: string | null
    source: string | null
    fetched_at: string | null
    /** The latest instant we can show these facts matched the registry; `max_age` is measured from it. */
    confirmed_at: string | null
}

export interface FeedPayload {
    mode: 'feed' | 'poll'
    lag_seconds: number | null
    cursor_time: string | null
}

/** One line per package key, sent once per stream. See "POST /resolve" in docs/resolver-api.md. */
export interface ResolveItem {
    /** The canonical package key, or null for an `invalid` purl. */
    key: string | null
    /** The purls exactly as the caller sent them that belong to this package. */
    purls: string[]
    status: ResultStatus
    /** Present for `resolved` and `refreshing`. */
    package?: PackagePayload
    /** Present for `error` and `invalid`. */
    reason?: string
}

/** The last line, exactly once. A stream that ends without it was cut short. */
export interface ResolveTrailer {
    done: true
    feeds: Record<string, FeedPayload>
}

export type ResolveLine = ResolveItem | ResolveTrailer

/** Where the lines go. The route's writes bytes; a test's collects them. */
export interface ResolveSink {
    /**
     * Called once, before the first line, after the first read and the queue writes have
     * succeeded. Nothing before it has been sent, so a failure up to here is still an HTTP status.
     */
    open(): void | Promise<void>
    /** One batch of lines, to be flushed together. Resolves when the sink can take the next one. */
    emit(lines: readonly ResolveLine[]): Promise<void>
}

/** `'abandoned'`: the caller went away, and no trailer was sent. */
export type ResolveOutcome = 'done' | 'abandoned'

export interface ResolveDeps {
    store: ResolveStore
    /** Version tuples this process already holds. Absent means "ask the database every time". */
    cache?: VersionCache
    /** The worker in this process, if there is one. Absent means "wait on the poll alone". */
    events?: ResolverEvents
    /** Where the request says how it went. Absent means "say nothing". */
    log?: Logger
    /**
     * Fires when the caller has gone away, at which point there is nobody left to answer. See
     * `clientGone` in `api/server.ts` for where a Fastify request's comes from. Absent means "no
     * caller ever gives up", which is what every test that is not about this passes.
     */
    signal?: AbortSignal
    /** Injected in tests. */
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    pollIntervalMs?: number
    gatherMs?: number
    versionSlice?: number
}

export interface ResolveRequest {
    purls: string[]
    /** How long, from when the request arrived, the stream may stay open waiting for packages. */
    deadlineMs: number
    /** How old, in seconds since `confirmed_at`, a package may be and still count as fresh. */
    maxAgeS: number
}

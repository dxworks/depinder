import type {ResolverEvents} from '../../events.js'
import type {Logger, ResolveLine} from '@depinder/core'
import type {ResolveStore} from '../store.js'
import type {VersionCache} from '../version-cache.js'

/**
 * How `POST /resolve` is answered inside the server: its timings, the parsed request, the sink the
 * lines go to and what the handler is given. The wire shapes and limits are core's (`wire/resolve.ts`).
 */

/**
 * How often the wait reads every key it is still waiting on, whatever it has heard.
 *
 * This is the fallback rather than the mechanism — a `settled` event from the worker in the same
 * process is what makes the stream look — so it can be slow. It is what catches a package settled
 * by a second instance, whose worker never tells this process anything.
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

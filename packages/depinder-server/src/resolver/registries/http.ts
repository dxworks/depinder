import {
    createHttpClient,
    createLimiter,
    createLimiterPool,
    type EcosystemLimits,
    type HttpClient,
    type LimitSpec,
    type RequestEvent,
    type RequestLimiter,
    type WaiterPicker,
} from '@depinder/core'

/**
 * The server's side of core's registry HTTP client: its own polite limits (D18), the order in
 * which its limiters let waiting requests through, and the recording that becomes `fetch_log`.
 *
 * Order: when a limiter is full, the next request it lets through is the most important one
 * waiting, not the one that came first. A package somebody is waiting for goes before the feed
 * and sweep traffic that keeps the database current, however much of that is already queued.
 */

export const USER_AGENT = 'depinder-server-side/0.1 (+https://github.com/dxworks/depinder)'

/**
 * Per-purl-type politeness. crates.io asks for ~1 request/second from an identified client;
 * maven central and pypi are shared infrastructure worth being gentle with; the rest cope with 8.
 */
export const RATE_LIMITS: Record<string, LimitSpec> = {
    cargo: {concurrency: 1, minIntervalMs: 1000},
    maven: {concurrency: 4, minIntervalMs: 0},
    pypi: {concurrency: 4, minIntervalMs: 0},
}

export const DEFAULT_LIMIT: LimitSpec = {concurrency: 8, minIntervalMs: 0}

const SERVER_LIMITS: EcosystemLimits = {byType: RATE_LIMITS, fallback: DEFAULT_LIMIT}

/**
 * How important a request is to its limiter. Lower goes first. A fetch somebody is waiting for
 * ranks `URGENT_RANK`; a queued fetch nobody waits for ranks its queue priority (20-50); feed
 * polls and poll-sweep checks — looking for news rather than fetching it — rank `BACKGROUND_RANK`.
 *
 * It is a function, read each time a slot is handed out rather than once on arrival, because a
 * fetch can become urgent while its request waits: a caller asks for the package it is fetching.
 */
export type Rank = () => number

export const URGENT_RANK = 0
const BACKGROUND_RANK = 100

/**
 * Grants in a row a limiter may give to a request that overtook an older one, before it gives one
 * to the oldest waiting regardless. Ranking alone would let a steady stream of urgent requests
 * starve the feeds and sweeps outright, and then the database drifts out of date — which is what
 * they are there to prevent. Counted per limiter, not per waiter: a backlog of two hundred sweep
 * checks gets one turn in nine, not all two hundred at once the moment they have all waited long
 * enough.
 */
export const MAX_PASSES = 8

/**
 * Package fetches of one ecosystem the demand-fill pool lets run at once: twice what its limiter
 * lets through, so the next package is already waiting when a request slot frees and the limiter
 * never idles, but no more than that. A fetch waiting in the limiter still holds a pool slot, and
 * without this cap a queue whose front is all cargo would fill every slot at one request a second.
 */
export function fetchSlots(type: string): number {
    return 2 * (RATE_LIMITS[type] ?? DEFAULT_LIMIT).concurrency
}

/**
 * The best rank, the earliest arrival among equals — unless the last `MAX_PASSES` grants all
 * overtook somebody, in which case the oldest waiter goes. A request with no rank is background.
 */
export function rankedPicker(): WaiterPicker<Rank | undefined> {
    let overtakes = 0
    const rankOf = (rank: Rank | undefined): number => (rank ? rank() : BACKGROUND_RANK)
    return waiting => {
        let chosen = 0
        if (overtakes < MAX_PASSES) {
            let best = rankOf(waiting[0])
            for (let i = 1; i < waiting.length; i++) {
                const rank = rankOf(waiting[i])
                if (rank < best) {
                    best = rank
                    chosen = i
                }
            }
        }
        overtakes = chosen === 0 ? 0 : overtakes + 1
        return chosen
    }
}

const limiters = createLimiterPool<Rank>(SERVER_LIMITS, rankedPicker)

/** The shared limiter for a purl type. One per type per process. */
export function limiter(type: string): RequestLimiter<Rank> {
    return limiters.forType(type)
}

/** A standalone ranked limiter. `limiter(type)` is the one registries go through; this is for tests. */
export function createRankedLimiter(spec: LimitSpec): RequestLimiter<Rank> {
    return createLimiter<Rank>(spec, rankedPicker())
}

/** Tests only: drop the memoised limiters so each test starts with an empty queue. */
export function resetLimiters(): void {
    limiters.reset()
}

/** One upstream request, as `fetch_log` stores it. */
export interface FetchRecord extends RequestEvent {
    /** Host the request went to, e.g. `registry.npmjs.org`. Stored as provenance. */
    source: string
}

type FetchRecorder = (record: FetchRecord) => void

interface RegistryClientOptions {
    /** purl type, used to pick the limiter. */
    type: string
    /** Gets every request, successful or not; the worker turns them into `fetch_log` rows. */
    recorder?: FetchRecorder
    timeoutMs?: number
    /** How every request of this client ranks in its limiter. Background unless said otherwise. */
    rank?: Rank
}

/** Core's client behind this server's limiter for `type`, ranked and recorded. */
export function createRegistryClient(options: RegistryClientOptions): HttpClient {
    const limit = limiter(options.type)
    const recorder = options.recorder
    return createHttpClient({
        limiter: {run: task => limit.run(task, options.rank)},
        userAgent: USER_AGENT,
        timeoutMs: options.timeoutMs,
        onRequest: recorder && (event => recorder({source: hostOf(event.url), ...event})),
    })
}

function hostOf(url: string): string {
    try {
        return new URL(url).host
    } catch {
        return 'unknown'
    }
}

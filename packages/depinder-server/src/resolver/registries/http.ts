/**
 * The only way this service talks to the internet.
 *
 * Three things every registry gets for free by going through here:
 *  - a timeout, so one hung upstream cannot pin a worker slot forever;
 *  - an identifying User-Agent, which several registries (crates.io in particular) require;
 *  - a per-ecosystem limiter, so politeness is a property of the client rather than something
 *    every registry file has to remember — and so is order: when the limiter is full, the next
 *    request it lets through is the most important one waiting, not the one that came first. A
 *    package somebody is waiting for goes before the feed and sweep traffic that keeps the
 *    database current, however much of that is already queued.
 *
 * Every request, successful or not, is handed to the `FetchRecorder` the caller passed in. The
 * demand-fill worker turns those records into `fetch_log` rows, which is the provenance trail.
 *
 * Compression is left to `fetch`: undici advertises gzip/deflate/br and decodes the response
 * before we see it. Do not set `accept-encoding` by hand.
 */

export const USER_AGENT = 'depinder-server-side/0.1 (+https://github.com/dxworks/depinder)'

const DEFAULT_TIMEOUT_MS = 15_000

interface LimitSpec {
    /** Requests in flight at once for this ecosystem. */
    concurrency: number
    /** Minimum gap between two request *starts*. 0 = no pacing. */
    minIntervalMs: number
}

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

export interface FetchRecord {
    /** Host the request went to, e.g. `registry.npmjs.org`. Stored as provenance. */
    source: string
    url: string
    method: string
    /** null when the request never got a response (DNS failure, timeout, reset). */
    status: number | null
    startedAt: Date
    finishedAt: Date
    error: string | null
}

type FetchRecorder = (record: FetchRecord) => void

export interface RequestOptions {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
}

export interface HttpResponse {
    url: string
    status: number
    /** status in [200, 300). 304 is *not* ok, but is a normal answer for conditional GETs. */
    ok: boolean
    headers: Headers
    /** Body as text; empty string for 204/304 and other bodyless answers. */
    text: string
    json<T = unknown>(): T
}

export interface HttpClient {
    get(url: string, opts?: RequestOptions): Promise<HttpResponse>
    request(url: string, opts?: RequestOptions): Promise<HttpResponse>
}

export class HttpError extends Error {
    constructor(message: string, readonly url: string, readonly status: number | null) {
        super(message)
        this.name = 'HttpError'
    }
}

// --- limiter ------------------------------------------------------------------------------

interface Limiter {
    readonly spec: LimitSpec
    /** Runs `fn` once a slot is free and it is the best-ranked waiter. `rank` defaults to background. */
    run<T>(fn: () => Promise<T>, rank?: Rank): Promise<T>
}

interface Waiter {
    rank: Rank
    grant: () => void
}

const background: Rank = () => BACKGROUND_RANK

class QueueLimiter implements Limiter {
    private active = 0
    /** In arrival order; which one goes next is decided by {@link next}. */
    private waiters: Waiter[] = []
    /** Earliest wall-clock time the next request may start, reserved synchronously. */
    private nextSlot = 0
    /** Grants in a row that went to a waiter other than the oldest. */
    private overtakes = 0

    constructor(readonly spec: LimitSpec) {}

    async run<T>(fn: () => Promise<T>, rank: Rank = background): Promise<T> {
        await this.acquire(rank)
        try {
            return await fn()
        } finally {
            this.release()
        }
    }

    private async acquire(rank: Rank): Promise<void> {
        if (this.active < this.spec.concurrency) {
            this.active++
        } else {
            await new Promise<void>(grant => this.waiters.push({rank, grant}))
        }
        await this.pace()
    }

    private release(): void {
        const next = this.next()
        if (next) next.grant() // hand the slot straight over, `active` stays as it is
        else this.active--
    }

    /**
     * Takes the waiter that goes next: the best rank, the earliest arrival among equals — unless the
     * last `MAX_PASSES` grants all overtook somebody, in which case the oldest waiter goes.
     */
    private next(): Waiter | undefined {
        if (this.waiters.length === 0) return undefined
        let chosen = 0
        if (this.overtakes < MAX_PASSES) {
            let best = this.waiters[0]!.rank()
            for (let i = 1; i < this.waiters.length; i++) {
                const rank = this.waiters[i]!.rank()
                if (rank < best) {
                    best = rank
                    chosen = i
                }
            }
        }
        this.overtakes = chosen === 0 ? 0 : this.overtakes + 1
        return this.waiters.splice(chosen, 1)[0]
    }

    /**
     * Reserves an interval slot before awaiting, so two callers that arrive in the same tick get
     * two different start times instead of both reading the same `Date.now()`.
     */
    private async pace(): Promise<void> {
        const min = this.spec.minIntervalMs
        if (min <= 0) return
        const now = Date.now()
        const start = Math.max(now, this.nextSlot)
        this.nextSlot = start + min
        const delay = start - now
        if (delay > 0) await sleep(delay)
    }
}

/** A standalone limiter. `limiter(type)` is the one registries go through; this is for tests. */
export function createLimiter(spec: LimitSpec): Limiter {
    return new QueueLimiter(spec)
}

const limiters = new Map<string, Limiter>()

/** The shared limiter for a purl type. One per type per process. */
export function limiter(type: string): Limiter {
    let found = limiters.get(type)
    if (!found) {
        found = new QueueLimiter(RATE_LIMITS[type] ?? DEFAULT_LIMIT)
        limiters.set(type, found)
    }
    return found
}

/** Tests only: drop the memoised limiters so each test starts with an empty queue. */
export function resetLimiters(): void {
    limiters.clear()
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// --- client -------------------------------------------------------------------------------

interface HttpClientOptions {
    /** purl type, used to pick the limiter. */
    type: string
    recorder?: FetchRecorder
    timeoutMs?: number
    /** How every request of this client ranks in its limiter. Background unless said otherwise. */
    rank?: Rank
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
    const limit = limiter(opts.type)
    const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
        return limit.run(() => send(url, options, defaultTimeout, opts.recorder), opts.rank)
    }

    return {
        request,
        get: (url, options) => request(url, {...options, method: 'GET'}),
    }
}

async function send(
    url: string,
    options: RequestOptions,
    defaultTimeout: number,
    recorder: FetchRecorder | undefined,
): Promise<HttpResponse> {
    const method = options.method ?? 'GET'
    const startedAt = new Date()
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? defaultTimeout
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const record = (status: number | null, error: string | null) => {
        recorder?.({source: hostOf(url), url, method, status, startedAt, finishedAt: new Date(), error})
    }

    try {
        const response = await fetch(url, {
            method,
            headers: {'user-agent': USER_AGENT, accept: 'application/json', ...lowercaseKeys(options.headers)},
            body: options.body,
            signal: controller.signal,
            redirect: 'follow',
        })
        const text = response.status === 204 || response.status === 304 ? '' : await response.text()
        record(response.status, null)
        return {
            url,
            status: response.status,
            ok: response.status >= 200 && response.status < 300,
            headers: response.headers,
            text,
            json<T>(): T {
                try {
                    return JSON.parse(text) as T
                } catch (e) {
                    throw new HttpError(
                        `${url} did not return JSON: ${e instanceof Error ? e.message : String(e)}`,
                        url,
                        response.status,
                    )
                }
            },
        }
    } catch (e) {
        const aborted = controller.signal.aborted
        const message = aborted
            ? `${method} ${url} timed out after ${timeoutMs} ms`
            : `${method} ${url} failed: ${e instanceof Error ? e.message : String(e)}`
        record(null, message)
        throw new HttpError(message, url, null)
    } finally {
        clearTimeout(timer)
    }
}

function lowercaseKeys(headers: Record<string, string> | undefined): Record<string, string> {
    if (!headers) return {}
    return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
}

function hostOf(url: string): string {
    try {
        return new URL(url).host
    } catch {
        return 'unknown'
    }
}

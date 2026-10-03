import {retryAfterMs} from './retry-after.js'
import {sleep} from './limiter.js'

/**
 * The only way registry code talks to the internet. Every request gets a timeout, so one hung
 * upstream cannot hold a slot forever; an identifying User-Agent, which several registries
 * (crates.io in particular) require; and the caller's per-ecosystem limiter.
 *
 * Compression is left to `fetch`: undici advertises gzip/deflate/br and decodes the response
 * before we see it. Do not set `accept-encoding` by hand.
 */

export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_USER_AGENT = 'depinder (+https://github.com/dxworks/depinder)'

/** One request as it went, successful or not. What a caller's `onRequest` hook receives. */
export interface RequestEvent {
    url: string
    method: string
    /** null when the request never got a response (DNS failure, timeout, reset). */
    status: number | null
    startedAt: Date
    finishedAt: Date
    error: string | null
}

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

/** Runs a request when the ecosystem's limits allow it: a `RequestLimiter`, or one wrapped by the caller. */
export interface RequestGate {
    run<T>(task: () => Promise<T>): Promise<T>
}

export interface HttpClientOptions {
    limiter: RequestGate
    userAgent?: string
    timeoutMs?: number
    /** Told about every request once it settles, retries included. */
    onRequest?: (event: RequestEvent) => void
    /**
     * Waits out a 429 once, honouring `Retry-After`, then asks again, keeping its limiter slot
     * meanwhile. Off: the 429 is returned like any other answer.
     */
    retryRateLimited?: boolean
    /**
     * Retries once, after about a second, a request that failed on the way (network error,
     * timeout) or got a 502/503/504, keeping its limiter slot meanwhile. Off: the first outcome stands.
     */
    retryTransient?: boolean
}

/** The wait before retrying a transient failure; a little jitter keeps a failed burst from retrying in step. */
export const TRANSIENT_RETRY_DELAY_MS = 1_000
export const TRANSIENT_RETRY_JITTER_MS = 250
const TRANSIENT_STATUSES = new Set([502, 503, 504])

export function createHttpClient(options: HttpClientOptions): HttpClient {
    const settings: SendSettings = {
        userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        onRequest: options.onRequest,
    }

    async function sendOrRetryTransient(url: string, requestOptions: RequestOptions): Promise<HttpResponse> {
        if (!options.retryTransient) return send(url, requestOptions, settings)
        try {
            const response = await send(url, requestOptions, settings)
            if (!TRANSIENT_STATUSES.has(response.status)) return response
        } catch (e) {
            if (!(e instanceof HttpError)) throw e
        }
        await sleep(TRANSIENT_RETRY_DELAY_MS + Math.random() * TRANSIENT_RETRY_JITTER_MS)
        return send(url, requestOptions, settings)
    }

    async function attempt(url: string, requestOptions: RequestOptions): Promise<HttpResponse> {
        const response = await sendOrRetryTransient(url, requestOptions)
        if (response.status !== 429 || !options.retryRateLimited) return response
        await sleep(retryAfterMs(response.headers.get('retry-after')))
        return sendOrRetryTransient(url, requestOptions)
    }

    async function request(url: string, requestOptions: RequestOptions = {}): Promise<HttpResponse> {
        return options.limiter.run(() => attempt(url, requestOptions))
    }

    return {
        request,
        get: (url, requestOptions) => request(url, {...requestOptions, method: 'GET'}),
    }
}

interface SendSettings {
    userAgent: string
    timeoutMs: number
    onRequest: ((event: RequestEvent) => void) | undefined
}

async function send(url: string, options: RequestOptions, settings: SendSettings): Promise<HttpResponse> {
    const method = options.method ?? 'GET'
    const startedAt = new Date()
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? settings.timeoutMs
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const settle = (status: number | null, error: string | null) => {
        settings.onRequest?.({url, method, status, startedAt, finishedAt: new Date(), error})
    }

    try {
        const response = await fetch(url, {
            method,
            headers: {'user-agent': settings.userAgent, accept: 'application/json', ...lowercaseKeys(options.headers)},
            body: options.body,
            signal: controller.signal,
            redirect: 'follow',
        })
        const text = response.status === 204 || response.status === 304 ? '' : await response.text()
        settle(response.status, null)
        return bufferedResponse(url, response, text)
    } catch (e) {
        const message = controller.signal.aborted
            ? `${method} ${url} timed out after ${timeoutMs} ms`
            : `${method} ${url} failed: ${e instanceof Error ? e.message : String(e)}`
        settle(null, message)
        throw new HttpError(message, url, null)
    } finally {
        clearTimeout(timer)
    }
}

function bufferedResponse(url: string, response: Response, text: string): HttpResponse {
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
                const reason = e instanceof Error ? e.message : String(e)
                throw new HttpError(`${url} did not return JSON: ${reason}`, url, response.status)
            }
        },
    }
}

function lowercaseKeys(headers: Record<string, string> | undefined): Record<string, string> {
    if (!headers) return {}
    return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
}

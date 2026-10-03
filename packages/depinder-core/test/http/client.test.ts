import {afterEach, describe, expect, it, vi} from 'vitest'
import {
    createHttpClient,
    DEFAULT_USER_AGENT,
    TRANSIENT_RETRY_DELAY_MS,
    TRANSIENT_RETRY_JITTER_MS,
    type RequestEvent,
} from '../../src/http/client.js'
import {createLimiter} from '../../src/http/limiter.js'
import {DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS, retryAfterMs} from '../../src/http/retry-after.js'

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

const open = () => createLimiter({concurrency: 8, minIntervalMs: 0})

describe('createHttpClient', () => {
    it('sends the user agent and tells onRequest about the request', async () => {
        const events: RequestEvent[] = []
        vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
            expect((init.headers as Record<string, string>)['user-agent']).toBe(DEFAULT_USER_AGENT)
            return Promise.resolve(new Response('{"ok":true}', {status: 200}))
        })

        const client = createHttpClient({limiter: open(), onRequest: event => events.push(event)})
        const response = await client.get('https://registry.npmjs.org/express')

        expect(response.ok).toBe(true)
        expect(response.json<{ok: boolean}>()).toEqual({ok: true})
        expect(events).toEqual([
            expect.objectContaining({url: 'https://registry.npmjs.org/express', method: 'GET', status: 200, error: null}),
        ])
    })

    it("sends the caller's user agent instead when it has one", async () => {
        vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
            expect((init.headers as Record<string, string>)['user-agent']).toBe('caller/1.0')
            return Promise.resolve(new Response('{}', {status: 200}))
        })
        await createHttpClient({limiter: open(), userAgent: 'caller/1.0'}).get('https://x.test/')
    })

    it('reports a failed request and throws', async () => {
        const events: RequestEvent[] = []
        vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNRESET')))

        const client = createHttpClient({limiter: open(), onRequest: event => events.push(event)})

        await expect(client.get('https://registry.npmjs.org/express')).rejects.toThrow(/ECONNRESET/)
        expect(events[0]).toMatchObject({status: null})
        expect(events[0]!.error).toMatch(/ECONNRESET/)
    })

    it('does not treat 304 as ok and leaves its body empty', async () => {
        vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, {status: 304})))
        const response = await createHttpClient({limiter: open()}).get('https://repo1.maven.org/x')
        expect(response.ok).toBe(false)
        expect(response.status).toBe(304)
        expect(response.text).toBe('')
    })

    it('times out', async () => {
        vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        )
        const client = createHttpClient({limiter: open(), timeoutMs: 10})
        await expect(client.get('https://registry.npmjs.org/slow')).rejects.toThrow(/timed out after 10 ms/)
    })

    it('runs every request through the limiter it was given', async () => {
        vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', {status: 200})))
        let ran = 0
        const client = createHttpClient({limiter: {run: task => (ran++, task())}})
        await client.get('https://x.test/a')
        await client.request('https://x.test/b', {method: 'HEAD'})
        expect(ran).toBe(2)
    })
})

describe('a 429 answer', () => {
    function rateLimitedOnce(retryAfter: string | null): string[] {
        const calls: string[] = []
        vi.stubGlobal('fetch', (url: string) => {
            calls.push(url)
            if (calls.length > 1) return Promise.resolve(new Response('{}', {status: 200}))
            const headers: Record<string, string> = retryAfter === null ? {} : {'retry-after': retryAfter}
            return Promise.resolve(new Response('slow down', {status: 429, headers}))
        })
        return calls
    }

    it('is returned as it is unless the caller asked for retries', async () => {
        const calls = rateLimitedOnce('1')
        const response = await createHttpClient({limiter: open()}).get('https://crates.io/api/v1/crates/serde')
        expect(response.status).toBe(429)
        expect(calls).toHaveLength(1)
    })

    it('is waited out once, honouring Retry-After, then asked again', async () => {
        vi.useFakeTimers()
        const calls = rateLimitedOnce('2')
        const events: RequestEvent[] = []
        const client = createHttpClient({limiter: open(), retryRateLimited: true, onRequest: e => events.push(e)})

        const pending = client.get('https://crates.io/api/v1/crates/serde')
        await vi.advanceTimersByTimeAsync(1_999)
        expect(calls).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        const response = await pending

        expect(response.status).toBe(200)
        expect(calls).toHaveLength(2)
        expect(events.map(e => e.status)).toEqual([429, 200])
    })

    it('is retried only once', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', () => Promise.resolve(new Response('no', {status: 429, headers: {'retry-after': '0'}})))
        const pending = createHttpClient({limiter: open(), retryRateLimited: true}).get('https://x.test/')
        await vi.runAllTimersAsync()
        expect((await pending).status).toBe(429)
    })
})

describe('a transient failure', () => {
    const fullDelay = TRANSIENT_RETRY_DELAY_MS + TRANSIENT_RETRY_JITTER_MS

    /** fetch that plays `outcomes` in order: a status, 'reset' (network error) or 'hang' (until aborted). */
    function fetchPlaying(...outcomes: (number | 'reset' | 'hang')[]): string[] {
        const calls: string[] = []
        vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
            const outcome = outcomes[calls.length] ?? 200
            calls.push(url)
            if (outcome === 'reset') return Promise.reject(new TypeError('fetch failed'))
            if (outcome === 'hang') {
                return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
            }
            return Promise.resolve(new Response('{}', {status: outcome}))
        })
        return calls
    }

    const retrying = () => createHttpClient({limiter: open(), retryTransient: true, timeoutMs: 10})

    it('is retried once after a network error, a timeout or a 503', async () => {
        vi.useFakeTimers()
        for (const failure of ['reset', 'hang', 503] as const) {
            const calls = fetchPlaying(failure, 200)
            const pending = retrying().get('https://proxy.golang.org/x/@v/list')
            await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS - 1)
            expect(calls).toHaveLength(1)
            await vi.advanceTimersByTimeAsync(fullDelay)
            expect((await pending).status).toBe(200)
            expect(calls).toHaveLength(2)
        }
    })

    it('fails when the retry fails too', async () => {
        vi.useFakeTimers()
        const calls = fetchPlaying('reset', 'reset', 200)
        const pending = retrying().get('https://x.test/')
        const outcome = expect(pending).rejects.toThrow(/failed: fetch failed/)
        await vi.advanceTimersByTimeAsync(fullDelay)
        await outcome
        expect(calls).toHaveLength(2)
    })

    it('hands back the second 5xx as the answer', async () => {
        vi.useFakeTimers()
        fetchPlaying(502, 504)
        const pending = retrying().get('https://x.test/')
        await vi.advanceTimersByTimeAsync(fullDelay)
        expect((await pending).status).toBe(504)
    })

    it('is not retried unless the caller asked for it', async () => {
        const calls = fetchPlaying('reset', 200)
        await expect(createHttpClient({limiter: open()}).get('https://x.test/')).rejects.toThrow(/fetch failed/)
        fetchPlaying(503, 200)
        expect((await createHttpClient({limiter: open()}).get('https://x.test/')).status).toBe(503)
        expect(calls).toHaveLength(1)
    })

    it('leaves other answers alone', async () => {
        const calls = fetchPlaying(404, 200)
        expect((await retrying().get('https://x.test/')).status).toBe(404)
        expect(calls).toHaveLength(1)
    })
})

describe('retryAfterMs', () => {
    const now = Date.parse('2026-10-03T10:00:00Z')

    it('reads delay-seconds and HTTP dates', () => {
        expect(retryAfterMs('3', now)).toBe(3_000)
        expect(retryAfterMs('Sat, 03 Oct 2026 10:00:10 GMT', now)).toBe(10_000)
    })

    it('falls back to a default for a missing or unreadable header, and never waits past the cap', () => {
        expect(retryAfterMs(null, now)).toBe(DEFAULT_RETRY_AFTER_MS)
        expect(retryAfterMs('soon', now)).toBe(DEFAULT_RETRY_AFTER_MS)
        expect(retryAfterMs('3600', now)).toBe(MAX_RETRY_AFTER_MS)
        expect(retryAfterMs('Sat, 03 Oct 2026 09:00:00 GMT', now)).toBe(0)
    })
})

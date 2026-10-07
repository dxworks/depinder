import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
    createRankedLimiter,
    createRegistryClient,
    DEFAULT_LIMIT,
    limiter,
    MAX_PASSES,
    RATE_LIMITS,
    type Rank,
    resetLimiters,
    USER_AGENT,
    type FetchRecord,
} from '../../../src/resolver/registries/http.js'

beforeEach(() => resetLimiters())
afterEach(() => vi.unstubAllGlobals())

describe('server limits', () => {
    it('gives crates.io one request per second and everyone else the default', () => {
        expect(RATE_LIMITS.cargo).toEqual({concurrency: 1, minIntervalMs: 1000})
        expect(limiter('cargo').spec).toEqual(RATE_LIMITS.cargo)
        expect(limiter('maven').spec.concurrency).toBe(4)
        expect(limiter('pypi').spec.concurrency).toBe(4)
        expect(limiter('gem').spec).toEqual(DEFAULT_LIMIT)
        expect(limiter('npm')).toBe(limiter('npm'))
    })
})

describe('limiter order', () => {
    /**
     * A one-slot limiter held by a first task while `ranks` queue up behind it in that order; then
     * the slot is let go. Returns the order the waiters ran in, by their index in `ranks`.
     */
    async function order(ranks: Rank[], whileWaiting?: () => void): Promise<number[]> {
        const limit = createRankedLimiter({concurrency: 1, minIntervalMs: 0})
        let release!: () => void
        const held = limit.run(() => new Promise<void>(resolve => (release = resolve)))
        const ran: number[] = []
        const waiting = ranks.map((rank, i) => limit.run(async () => void ran.push(i), rank))
        await new Promise(resolve => setTimeout(resolve, 0)) // the first task is running and holds `release`
        whileWaiting?.()
        release()
        await Promise.all([held, ...waiting])
        return ran
    }

    it('lets the best rank through first, and equal ranks in the order they came', async () => {
        const rank = (n: number): Rank => () => n
        expect(await order([rank(100), rank(20), rank(0), rank(20), rank(0)])).toEqual([2, 4, 1, 3, 0])
    })

    it('treats a request with no rank as background', async () => {
        const limit = createRankedLimiter({concurrency: 1, minIntervalMs: 0})
        let release!: () => void
        const held = limit.run(() => new Promise<void>(resolve => (release = resolve)))
        const ran: string[] = []
        const sweep = limit.run(async () => void ran.push('sweep'))
        const fetch = limit.run(async () => void ran.push('fetch'), () => 20)
        await new Promise(resolve => setTimeout(resolve, 0)) // the first task is running and holds `release`
        release()
        await Promise.all([held, sweep, fetch])
        expect(ran).toEqual(['fetch', 'sweep'])
    })

    it('reads a rank when it hands out the slot, so a waiter can become urgent while it waits', async () => {
        let urgent = false
        const ran = await order([() => 20, () => 20, () => (urgent ? 0 : 30)], () => {
            urgent = true
        })
        expect(ran).toEqual([2, 0, 1])
    })

    it('gives a background backlog one turn per MAX_PASSES urgent grants, not all at once', async () => {
        const limit = createRankedLimiter({concurrency: 1, minIntervalMs: 0})
        let release!: () => void
        const held = limit.run(() => new Promise<void>(resolve => (release = resolve)))
        const ran: string[] = []
        // A sweep's worth of checks queued ahead of the users.
        const sweep = Promise.all(Array.from({length: 5}, (_, i) => limit.run(async () => void ran.push(`s${i}`))))
        // A stream of urgent requests, each arriving while the one before runs.
        const urgent: Promise<void>[] = []
        const more = (n: number): Promise<void> =>
            limit.run(async () => {
                ran.push(`u${n}`)
                if (n < MAX_PASSES + 3) urgent.push(more(n + 1))
            }, () => 0)
        urgent.push(more(0))
        await new Promise(resolve => setTimeout(resolve, 0)) // the first task is running and holds `release`
        release()
        await held
        while (ran.length < MAX_PASSES + 4 + 5) await new Promise(resolve => setTimeout(resolve, 1))
        await Promise.all([sweep, ...urgent])
        // Eight urgent, one check, then the urgent stream again — the rest of the backlog waits on.
        expect(ran.slice(0, MAX_PASSES + 3)).toEqual([...Array.from({length: MAX_PASSES}, (_, i) => `u${i}`), 's0', `u${MAX_PASSES}`, `u${MAX_PASSES + 1}`])
    })
})

describe('createRegistryClient', () => {
    it('sends the server user agent and records the request with its host', async () => {
        const records: FetchRecord[] = []
        vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
            expect((init.headers as Record<string, string>)['user-agent']).toBe(USER_AGENT)
            return Promise.resolve(new Response('{"ok":true}', {status: 200}))
        })

        const client = createRegistryClient({type: 'npm', recorder: record => records.push(record)})
        const response = await client.get('https://registry.npmjs.org/express')

        expect(response.ok).toBe(true)
        expect(response.json<{ok: boolean}>()).toEqual({ok: true})
        expect(records).toEqual([
            expect.objectContaining({source: 'registry.npmjs.org', method: 'GET', status: 200, error: null}),
        ])
    })

    it('records a failed request and throws', async () => {
        const records: FetchRecord[] = []
        vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNRESET')))

        const client = createRegistryClient({type: 'npm', recorder: record => records.push(record)})

        await expect(client.get('https://registry.npmjs.org/express')).rejects.toThrow(/ECONNRESET/)
        expect(records[0]).toMatchObject({status: null})
        expect(records[0]!.error).toMatch(/ECONNRESET/)
    })
})

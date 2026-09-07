import {AdvisoryClient, backoffDelay, HttpResponse, nextLink} from '../src/vuln-sources/github/client'
import {TokenPool} from '../src/vuln-sources/github/tokens'

/**
 * The client is tested against a scripted HTTP layer rather than api.github.com: the behaviour
 * that matters (cursor pagination, backoff, token rotation, parking) is all in the response
 * handling, and none of it needs a real token to exercise.
 */

const noSleep = async (): Promise<void> => undefined

/**
 * A pool whose clock the test drives. Real time must not be involved: a parked token is parked
 * until its window resets, and with an instant `sleep` the pool would otherwise spin against
 * `Date.now()` until the deadline really passed.
 */
function testPool(tokens: string[], safetyMargin?: number): TokenPool {
    let time = 1_000_000
    return new TokenPool(tokens, {
        safetyMargin,
        now: () => time,
        sleep: async (ms: number) => {
            time += ms
        },
    })
}

function ok(body: unknown, headers: {[name: string]: string} = {}): HttpResponse {
    return {status: 200, headers: {'x-ratelimit-remaining': '4999', ...headers}, body: JSON.stringify(body)}
}

describe('nextLink', () => {
    it('reads the cursor URL out of a Link header', () => {
        const link = '<https://api.github.com/advisories?after=CURSOR>; rel="next", '
            + '<https://api.github.com/advisories?before=X>; rel="prev"'
        expect(nextLink(link)).toBe('https://api.github.com/advisories?after=CURSOR')
    })

    it('is undefined on the last page and on no header at all', () => {
        expect(nextLink('<https://api.github.com/advisories?before=X>; rel="prev"')).toBeUndefined()
        expect(nextLink(undefined)).toBeUndefined()
    })
})

describe('backoffDelay', () => {
    it('grows exponentially, is capped, and is jittered', () => {
        expect(backoffDelay(0, () => 0)).toBe(500)
        expect(backoffDelay(0, () => 1)).toBe(1000)
        expect(backoffDelay(3, () => 0)).toBe(4000)
        expect(backoffDelay(20, () => 1)).toBe(60_000)
    })
})

describe('AdvisoryClient', () => {
    it('follows the Link cursor to the last page', async () => {
        const pool = testPool(['a'])
        const seen: string[] = []
        const client = new AdvisoryClient({
            pool,
            sleep: noSleep,
            fetch: async url => {
                seen.push(url)
                if (seen.length === 1) {
                    return ok([{ghsa_id: 'GHSA-1'}], {link: '<https://api.github.com/advisories?after=P2>; rel="next"'})
                }
                if (seen.length === 2) {
                    return ok([{ghsa_id: 'GHSA-2'}], {link: '<https://api.github.com/advisories?after=P3>; rel="next"'})
                }
                return ok([{ghsa_id: 'GHSA-3'}])
            },
        })

        const advisories = []
        for await (const page of client.pages('rubygems')) advisories.push(...page.advisories)

        expect(advisories.map(it => it.ghsa_id)).toEqual(['GHSA-1', 'GHSA-2', 'GHSA-3'])
        expect(seen[0]).toContain('type=reviewed')
        expect(seen[0]).toContain('ecosystem=rubygems')
        expect(seen[0]).toContain('per_page=100')
        expect(seen.slice(1)).toEqual([
            'https://api.github.com/advisories?after=P2',
            'https://api.github.com/advisories?after=P3',
        ])
    })

    it('sends the token as a Bearer credential and the pinned API version', async () => {
        const pool = testPool(['secret-token'])
        let sent: {[name: string]: string} = {}
        const client = new AdvisoryClient({
            pool,
            sleep: noSleep,
            fetch: async (_url, headers) => {
                sent = headers
                return ok([])
            },
        })
        await client.getPage('https://api.github.com/advisories')
        expect(sent.authorization).toBe('Bearer secret-token')
        expect(sent['x-github-api-version']).toBe('2022-11-28')
    })

    it('retries 429 and 5xx, then succeeds', async () => {
        const pool = testPool(['a', 'b'])
        const statuses = [429, 503, 200]
        let call = 0
        const client = new AdvisoryClient({
            pool,
            sleep: noSleep,
            fetch: async () => {
                const status = statuses[call++]
                return status === 200 ? ok([{ghsa_id: 'GHSA-x'}]) : {status, headers: {}, body: 'nope'}
            },
        })
        const page = await client.getPage('https://api.github.com/advisories')
        expect(page.advisories).toHaveLength(1)
        expect(call).toBe(3)
    })

    it('gives up after maxAttempts and says why', async () => {
        const pool = testPool(['a'])
        const client = new AdvisoryClient({
            pool,
            sleep: noSleep,
            maxAttempts: 3,
            fetch: async () => ({status: 500, headers: {}, body: 'server error'}),
        })
        await expect(client.getPage('https://api.github.com/advisories'))
            .rejects.toThrow(/after 3 attempts.*HTTP 500/s)
    })

    it('does not retry a client error it cannot recover from', async () => {
        const pool = testPool(['a'])
        let calls = 0
        const client = new AdvisoryClient({
            pool,
            sleep: noSleep,
            fetch: async () => {
                calls++
                return {status: 404, headers: {}, body: 'not found'}
            },
        })
        await expect(client.getPage('https://api.github.com/advisories')).rejects.toThrow(/HTTP 404/)
        expect(calls).toBe(1)
    })

    it('parks the rate-limited token so the retry lands on another one', async () => {
        const pool = testPool(['a', 'b'], 0)
        const used: string[] = []
        const client = new AdvisoryClient({
            pool,
            sleep: noSleep,
            fetch: async (_url, headers) => {
                used.push(headers.authorization)
                return used.length === 1
                    ? {status: 403, headers: {'retry-after': '1'}, body: 'rate limited'}
                    : ok([])
            },
        })
        await client.getPage('https://api.github.com/advisories')
        expect(used).toEqual(['Bearer a', 'Bearer b'])
    })

    it('retries a network failure without consuming the pool', async () => {
        const pool = testPool(['a'])
        let calls = 0
        const client = new AdvisoryClient({
            pool,
            sleep: noSleep,
            fetch: async () => {
                calls++
                if (calls === 1) throw new Error('ECONNRESET')
                return ok([{ghsa_id: 'GHSA-y'}])
            },
        })
        const page = await client.getPage('https://api.github.com/advisories')
        expect(page.advisories).toHaveLength(1)
        expect(calls).toBe(2)
    })
})

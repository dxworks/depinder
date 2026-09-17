import {CHUNK_SIZE, PackageRecord, resetResolverClient, resolvePurls, resolverUnavailable} from '../src/resolver/client'
import {RESOLVER_CHUNK_CONCURRENCY, ResolverConfig} from '../src/resolver/config'

/**
 * The resolver client against a canned server. What is worth pinning is not that it can parse a
 * response — it is that every way the server can fail to answer ends with the run continuing:
 * a chunk too large is split, a `pending` purl is asked for again, a 401 is fatal to the client and
 * to nothing else, and a network error costs one retry and then silence.
 *
 * Chunks are posted several at a time, so the second thing worth pinning is that concurrency did
 * not cost any of the above: the window is bounded, an answer already in flight when the resolver
 * goes unavailable is still kept, and nothing is asked after that.
 */

const config: ResolverConfig = {
    url: 'https://resolver.example', token: 'secret', maxWaitMs: 60_000,
    chunkConcurrency: RESOLVER_CHUNK_CONCURRENCY,
}
// The re-ask loop sleeps between rounds; tests do not.
const fast = {reAskIntervalMs: 1}

const quiet = {info: jest.fn(), warn: jest.fn()}

const pkg = (name: string): PackageRecord => ({
    type: 'npm', namespace: null, name,
    description: null, homepage_url: null, repo_url: null,
    licenses: ['MIT'],
    latest: {version: '1.0.0', released_at: '2020-01-01T00:00:00Z'},
    latest_prerelease: null,
    versions: [['1.0.0', Math.floor(Date.parse('2020-01-01T00:00:00Z') / 1000), 0]],
    as_of: '2026-09-16T10:00:00Z', source: 'npm', fetched_at: '2026-09-16T10:00:00Z',
})

const resolvedBody = (purls: string[]) => ({
    results: purls.map(purl => ({
        purl,
        package_key: purl.split('@').slice(0, -1).join('@'),
        status: 'resolved',
        requested_version: {version: '1.0.0', released_at: '2020-01-01T00:00:00Z', licenses: ['MIT'], found: true},
    })),
    packages: Object.fromEntries(purls.map(purl => {
        const key = purl.split('@').slice(0, -1).join('@')
        return [key, pkg(key.slice('pkg:npm/'.length))]
    })),
    feeds: {npm: {mode: 'feed', lag_seconds: 12.4, cursor_time: '2026-09-16T10:00:00Z'}},
})

interface Call {
    url: string
    auth: string
    method: string
    purls: string[]
    waitMs?: number
}

type Answer = {status?: number, body?: any} | Error

/**
 * Installs a fake server and returns the requests it saw, in order. Nothing is asserted in here:
 * the client swallows every exception a request throws, so an assertion failure inside the mock
 * would be reported as a network error and retried rather than failing the test.
 */
function serve(handler: (call: Call, index: number) => Answer) {
    const calls: Call[] = []
    global.fetch = (async (url: string, init: any) => {
        const body = JSON.parse(init.body)
        const call: Call = {
            url: String(url),
            auth: init.headers.Authorization,
            method: init.method,
            purls: body.purls,
            waitMs: body.wait_ms,
        }
        const index = calls.length
        calls.push(call)
        const answer = handler(call, index)
        if (answer instanceof Error) throw answer
        const status = answer.status ?? 200
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => answer.body ?? {},
        } as any
    }) as any
    return calls
}

/**
 * The same fake server, but every request parks until the test lets it answer. Without this a
 * concurrency window is invisible: the immediate server above resolves each call before the next
 * chunk is taken, so "four at once" and "one at a time" produce identical call lists.
 */
function gatedServe(handler: (call: Call, index: number) => Answer = call => ({body: resolvedBody(call.purls)})) {
    const calls: Call[] = []
    const gates: Array<(() => void) | undefined> = []
    let inFlight = 0
    let peakInFlight = 0

    global.fetch = (async (url: string, init: any) => {
        const body = JSON.parse(init.body)
        const index = calls.length
        calls.push({
            url: String(url),
            auth: init.headers.Authorization,
            method: init.method,
            purls: body.purls,
            waitMs: body.wait_ms,
        })
        inFlight++
        peakInFlight = Math.max(peakInFlight, inFlight)
        await new Promise<void>(resolve => { gates[index] = resolve })
        inFlight--
        const answer = handler(calls[index], index)
        if (answer instanceof Error) throw answer
        const status = answer.status ?? 200
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => answer.body ?? {},
        } as any
    }) as any

    const release = (index: number) => {
        const gate = gates[index]
        if (!gate) throw new Error(`no request ${index} to release`)
        gates[index] = undefined
        gate()
    }
    return {
        calls,
        peakInFlight: () => peakInFlight,
        release,
        releaseAll: () => gates.forEach((gate, index) => gate && release(index)),
    }
}

/** One turn of the event loop, so whatever a released request unblocked can run. */
const tick = () => new Promise(resolve => setImmediate(resolve))

/**
 * Waits for the client to get somewhere, without pinning how many turns it takes to get there.
 * A real timer rather than `setImmediate`, because the re-ask loop sleeps between rounds and a
 * thousand microtask turns can pass before a 1 ms timer fires.
 */
async function until(what: string, condition: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1))
    if (!condition()) throw new Error(`timed out waiting for ${what}`)
}

const manyPurls = (chunks: number) =>
    Array.from({length: CHUNK_SIZE * chunks}, (_, i) => `pkg:npm/p${i}@1.0.0`)

describe('the resolver client', () => {
    const realFetch = global.fetch

    beforeEach(() => {
        resetResolverClient()
        quiet.info.mockReset()
        quiet.warn.mockReset()
    })
    afterEach(() => {
        global.fetch = realFetch
    })

    it('asks once, with the bearer token and the first-ask wait', async () => {
        const calls = serve(call => ({body: resolvedBody(call.purls)}))

        const answers = await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet, fast)

        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://resolver.example/resolve')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].auth).toBe('Bearer secret')
        expect(calls[0].waitMs).toBe(15_000)
        expect(answers.get('pkg:npm/left-pad@1.0.0')?.status).toBe('resolved')
        expect(answers.get('pkg:npm/left-pad@1.0.0')?.package?.name).toBe('left-pad')
        expect(answers.get('pkg:npm/left-pad@1.0.0')?.requestedVersion?.version).toBe('1.0.0')
    })

    it('reports the per-feed lag once, from the first answer', async () => {
        serve(call => ({body: resolvedBody(call.purls)}))
        await resolvePurls(config, ['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0'], quiet, fast)
        const freshness = quiet.info.mock.calls.map(it => String(it[0])).filter(it => it.startsWith('Resolver freshness'))
        expect(freshness).toEqual(['Resolver freshness: npm feed lag 12s'])
    })

    it('splits more than 2000 purls into chunks the server accepts', async () => {
        const purls = Array.from({length: CHUNK_SIZE + 500}, (_, i) => `pkg:npm/p${i}@1.0.0`)
        const calls = serve(call => ({body: resolvedBody(call.purls)}))

        const answers = await resolvePurls(config, purls, quiet, fast)

        expect(calls.map(it => it.purls.length)).toEqual([CHUNK_SIZE, 500])
        expect(answers.size).toBe(purls.length)
    })

    it('re-asks only the purls still pending, and takes the later answer', async () => {
        const calls = serve((call, index) => {
            if (index === 0) return {
                body: {
                    results: [
                        {purl: 'pkg:npm/known@1.0.0', package_key: 'pkg:npm/known', status: 'resolved', requested_version: null},
                        {purl: 'pkg:npm/new@1.0.0', package_key: 'pkg:npm/new', status: 'pending', requested_version: null},
                        {purl: 'pkg:npm/gone@1.0.0', package_key: 'pkg:npm/gone', status: 'not_found', requested_version: null},
                    ],
                    packages: {'pkg:npm/known': pkg('known')},
                },
            }
            return {body: resolvedBody(call.purls)}
        })

        const answers = await resolvePurls(
            config, ['pkg:npm/known@1.0.0', 'pkg:npm/new@1.0.0', 'pkg:npm/gone@1.0.0'], quiet, fast)

        // Only the pending one is asked about again — a not_found does not change within a run.
        expect(calls).toHaveLength(2)
        expect(calls[1].purls).toEqual(['pkg:npm/new@1.0.0'])
        expect(calls[1].waitMs).toBeUndefined()
        expect(answers.get('pkg:npm/new@1.0.0')?.status).toBe('resolved')
        expect(answers.get('pkg:npm/gone@1.0.0')?.status).toBe('not_found')
    })

    it('stops re-asking when the wait budget runs out, and returns what it has', async () => {
        const calls = serve(call => ({
            body: {
                results: call.purls.map(purl => ({purl, package_key: 'pkg:npm/slow', status: 'pending', requested_version: null})),
                packages: {},
            },
        }))

        const answers = await resolvePurls({...config, maxWaitMs: 30}, ['pkg:npm/slow@1.0.0'], quiet, {reAskIntervalMs: 10})

        expect(calls.length).toBeGreaterThan(1)
        expect(answers.get('pkg:npm/slow@1.0.0')?.status).toBe('pending')
    })

    it('treats a 401 as final: no retry, no throw, and no further calls this run', async () => {
        const calls = serve(() => ({status: 401, body: {error: 'unauthorized'}}))

        const answers = await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet, fast)

        expect(answers.size).toBe(0)
        expect(calls).toHaveLength(1)
        expect(resolverUnavailable()).toBe(true)
        expect(quiet.warn.mock.calls.map(it => String(it[0])).filter(it => it.includes('Resolver unavailable'))).toHaveLength(1)

        // The rest of the run does not pay the timeout again.
        expect((await resolvePurls(config, ['pkg:npm/other@1.0.0'], quiet, fast)).size).toBe(0)
        expect(calls).toHaveLength(1)
    })

    it('retries a network error exactly once, then gives up for the run', async () => {
        const calls = serve(() => new Error('ECONNREFUSED'))

        const answers = await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet, fast)

        expect(calls).toHaveLength(2)
        expect(answers.size).toBe(0)
        expect(resolverUnavailable()).toBe(true)
    })

    it('retries a 500 once and keeps the answer when the retry succeeds', async () => {
        const calls = serve((call, index) => index === 0
            ? {status: 503, body: {}}
            : {body: resolvedBody(call.purls)})

        const answers = await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet, fast)

        expect(calls).toHaveLength(2)
        expect(answers.get('pkg:npm/left-pad@1.0.0')?.status).toBe('resolved')
        expect(resolverUnavailable()).toBe(false)
    })

    it('abandons the remaining chunks once the server is unavailable', async () => {
        const calls = serve(() => ({status: 403, body: {}}))

        await resolvePurls(config, manyPurls(6), quiet, fast)

        // The first window's worth was already asked before the first 403 came back; the chunks
        // behind them are never asked, and only one line is logged about it.
        expect(calls).toHaveLength(RESOLVER_CHUNK_CONCURRENCY)
        expect(quiet.warn.mock.calls.map(it => String(it[0])).filter(it => it.includes('Resolver unavailable'))).toHaveLength(1)
    })

    it('keeps the window full, and starts the next chunk only as one lands', async () => {
        const server = gatedServe()
        const answers = resolvePurls(config, manyPurls(6), quiet, fast)

        await until('the first window of chunks', () => server.calls.length === RESOLVER_CHUNK_CONCURRENCY)
        await tick()
        // Bounded: the chunk after the window waits for a slot rather than piling onto the server,
        // whose api pool has one connection per chunk and one spare for a retry.
        expect(server.calls).toHaveLength(RESOLVER_CHUNK_CONCURRENCY)

        server.release(0)
        await until('the chunk after the window', () => server.calls.length === RESOLVER_CHUNK_CONCURRENCY + 1)
        expect(server.peakInFlight()).toBe(RESOLVER_CHUNK_CONCURRENCY)

        server.releaseAll()
        await until('the sixth chunk', () => server.calls.length === 6)
        server.releaseAll()

        const result = await answers
        expect(server.calls).toHaveLength(6)
        expect(result.size).toBe(CHUNK_SIZE * 6)
    })

    it('posts one chunk at a time when the configuration says so', async () => {
        const server = gatedServe()
        const answers = resolvePurls({...config, chunkConcurrency: 1}, manyPurls(3), quiet, fast)

        await until('the first chunk', () => server.calls.length === 1)
        await tick()
        expect(server.calls).toHaveLength(1)

        server.release(0)
        await until('the second chunk', () => server.calls.length === 2)
        server.releaseAll()
        await until('the third chunk', () => server.calls.length === 3)
        server.releaseAll()

        await answers
        expect(server.peakInFlight()).toBe(1)
    })

    it('keeps the answer of a chunk already in flight when another chunk turned the resolver off', async () => {
        // A 4xx is final for the run, but the chunks beside it have already been paid for: throwing
        // their answers away would send those libraries to the registrars for nothing.
        const server = gatedServe((call, index) => index === 1
            ? {status: 400, body: {}}
            : {body: resolvedBody(call.purls)})
        const answers = resolvePurls(config, manyPurls(6), quiet, fast)

        await until('the first window of chunks', () => server.calls.length === RESOLVER_CHUNK_CONCURRENCY)
        server.release(1)
        await until('the client to give up on the resolver', () => resolverUnavailable())
        server.releaseAll()

        const result = await answers

        expect(server.calls).toHaveLength(RESOLVER_CHUNK_CONCURRENCY)
        expect(result.size).toBe(CHUNK_SIZE * (RESOLVER_CHUNK_CONCURRENCY - 1))
        expect(resolverUnavailable()).toBe(true)
    })

    it('re-asks the still-pending purls through the same concurrent window', async () => {
        const server = gatedServe((call, index) => index < 2
            ? {
                body: {
                    results: call.purls.map(purl => ({
                        purl, package_key: purl, status: 'pending', requested_version: null,
                    })),
                    packages: {},
                },
            }
            : {body: resolvedBody(call.purls)})
        const answers = resolvePurls(config, manyPurls(2), quiet, fast)

        await until('both chunks of the first ask', () => server.calls.length === 2)
        server.releaseAll()
        // Both chunks of the re-ask are in flight before either of them is answered.
        await until('both chunks of the re-ask', () => server.calls.length === 4)
        server.releaseAll()

        const result = await answers
        expect(server.calls).toHaveLength(4)
        expect([...result.values()].every(it => it.status === 'resolved')).toBe(true)
    })

    it('treats a client-side timeout as transient: one retry, and the run carries on', async () => {
        // What `AbortSignal.timeout` throws when the slack runs out. It carries no HTTP status, so
        // it is retryable — and the retry's answer is kept, rather than the abort costing the run
        // the resolver. The slack is 60 s for exactly this reason: the abort is a last resort, and
        // abandoning a request the server is still working on is worse than waiting for it.
        const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'})
        const calls = serve((call, index) => index === 0 ? timeout : {body: resolvedBody(call.purls)})

        const answers = await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet, fast)

        expect(calls).toHaveLength(2)
        expect(answers.get('pkg:npm/left-pad@1.0.0')?.status).toBe('resolved')
        expect(resolverUnavailable()).toBe(false)
        expect(quiet.warn.mock.calls.map(it => String(it[0])).filter(it => it.includes('Resolver unavailable'))).toHaveLength(0)
        expect(quiet.warn.mock.calls.map(it => String(it[0])).filter(it => it.includes('retrying once'))).toHaveLength(1)
    })

    it('starts no re-ask round it has no budget left for', async () => {
        // A first ask that outruns `maxWaitMs` on its own — a server that had just restarted, and
        // so had a full wait and a cold payload cache for every chunk. The deadline is the run's
        // real bound, and it is re-read before each round rather than only at the top.
        const calls: string[][] = []
        global.fetch = (async (_url: string, init: any) => {
            const purls: string[] = JSON.parse(init.body).purls
            calls.push(purls)
            await new Promise(resolve => setTimeout(resolve, 40))
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    results: purls.map(purl => ({
                        purl, package_key: purl, status: 'pending', requested_version: null,
                    })),
                    packages: {},
                }),
            } as any
        }) as any

        const answers = await resolvePurls(
            {...config, maxWaitMs: 30}, ['pkg:npm/slow@1.0.0'], quiet, {reAskIntervalMs: 10})

        expect(calls).toHaveLength(1)
        expect(answers.get('pkg:npm/slow@1.0.0')?.status).toBe('pending')
        // Out of time is not out of order: the resolver stays available for the next run.
        expect(resolverUnavailable()).toBe(false)
    })

    it('asks nothing when given no purls', async () => {
        const calls = serve(call => ({body: resolvedBody(call.purls)}))
        expect((await resolvePurls(config, [], quiet, fast)).size).toBe(0)
        expect(calls).toHaveLength(0)
    })
})

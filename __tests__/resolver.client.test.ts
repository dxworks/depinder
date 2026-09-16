import {CHUNK_SIZE, PackageRecord, resetResolverClient, resolvePurls, resolverUnavailable} from '../src/resolver/client'
import {ResolverConfig} from '../src/resolver/config'

/**
 * The resolver client against a canned server. What is worth pinning is not that it can parse a
 * response — it is that every way the server can fail to answer ends with the run continuing:
 * a chunk too large is split, a `pending` purl is asked for again, a 401 is fatal to the client and
 * to nothing else, and a network error costs one retry and then silence.
 */

const config: ResolverConfig = {url: 'https://resolver.example', token: 'secret', maxWaitMs: 60_000}
// The re-ask loop sleeps between rounds; tests do not.
const fast = {reAskIntervalMs: 1}

const quiet = {info: jest.fn(), warn: jest.fn()}

const pkg = (name: string): PackageRecord => ({
    type: 'npm', namespace: null, name,
    description: null, homepage_url: null, repo_url: null,
    licenses: ['MIT'],
    latest: {version: '1.0.0', released_at: '2020-01-01T00:00:00Z'},
    latest_prerelease: null,
    versions: [{version: '1.0.0', released_at: '2020-01-01T00:00:00Z', licenses: ['MIT'], prerelease: false, yanked: false}],
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
        const purls = Array.from({length: CHUNK_SIZE + 10}, (_, i) => `pkg:npm/p${i}@1.0.0`)
        const calls = serve(() => ({status: 403, body: {}}))

        await resolvePurls(config, purls, quiet, fast)

        expect(calls).toHaveLength(1)
    })

    it('asks nothing when given no purls', async () => {
        const calls = serve(call => ({body: resolvedBody(call.purls)}))
        expect((await resolvePurls(config, [], quiet, fast)).size).toBe(0)
        expect(calls).toHaveLength(0)
    })
})

import {
    DEFAULT_VULN_MAX_WAIT_MS,
    fetchServerVulnerabilities,
    MAX_VULN_CHUNK_SIZE,
    parseServerTiming,
    staleBuildWarnings,
    usesVulnServer,
    vulnChunks,
    vulnServerConfig,
    VulnServerConfig,
} from '../src/vuln-sources/server'
import {ResolverConfig} from '../src/resolver/config'
import {log} from '../src/utils/logging'

/**
 * The vulnerability server client: every chunk at once, one deadline, no retries, and an answer
 * that is all or nothing. Anything short of every chunk answering in full is a failure the caller
 * replaces with the local scan, so these tests pin what counts as a failure as much as what a
 * success maps to.
 */

const quiet = {info: jest.fn(), warn: jest.fn()}
const resolver: ResolverConfig = {url: 'http://server.example', token: 'secret', maxWaitMs: 60_000, chunkConcurrency: Infinity}
const config: VulnServerConfig = {url: 'http://server.example', token: 'secret', maxWaitMs: 5_000, chunkSize: 5000}

const finding = (id: string) => ({
    severity: 'HIGH', description: id, permalink: `https://example/${id}`,
    identifiers: [{value: id, type: 'CVE'}], source: 'trivy,grype',
})
const build = (builtAt: string, stale = false) => ({built_at: builtAt, schema: '2', age_seconds: 3600, stale})

interface Call {url: string, init: any, purls: string[]}
type Answer = {status: number, body?: unknown, raw?: string, headers?: {[name: string]: string}} | Error

/** The vulnerable purls are those containing `bad`; everything else is clean. */
function answerFor(purls: string[]): Answer {
    const vulnerabilities: {[purl: string]: unknown[]} = {}
    for (const purl of purls) if (purl.includes('bad')) vulnerabilities[purl] = [finding(`CVE-${purl.length}`)]
    return {
        status: 200,
        body: {
            vulnerabilities,
            unsupported: purls.filter(it => !it.includes('@')).map(purl => ({purl, reason: 'no_version'})),
            databases: {trivy: build('2026-10-01T19:00:16Z'), grype: build('2026-10-01T06:33:48Z')},
            scanners: {trivy: '0.74.0', grype: '0.118.0'},
        },
        headers: {'server-timing': 'queue;dur=1, trivy;dur=50, grype;dur=800, total;dur=851'},
    }
}

function respond(answer: Exclude<Answer, Error>): Response {
    const body = answer.raw ?? JSON.stringify(answer.body ?? {error: 'nope'})
    return new Response(body, {status: answer.status, headers: {'content-type': 'application/json', ...answer.headers}})
}

/**
 * A fake server whose every request parks until released, so "all at once" is observable and a
 * chunk that never answers can be left hanging. `abortedCalls` sees the client give up on one.
 */
function gatedServe(handler: (call: Call, index: number) => Answer = call => answerFor(call.purls)) {
    const calls: Call[] = []
    const gates: (() => void)[] = []
    const aborted = new Set<number>()
    global.fetch = (async (url: string, init: any) => {
        const index = calls.length
        calls.push({url: String(url), init, purls: JSON.parse(init.body).purls})
        let released = false
        await new Promise<void>((resolve, reject) => {
            gates[index] = () => {
                released = true
                resolve()
            }
            init.signal?.addEventListener('abort', () => {
                if (released) return
                aborted.add(index)
                reject(init.signal.reason ?? new Error('aborted'))
            })
        })
        const answer = handler(calls[index], index)
        if (answer instanceof Error) throw answer
        return respond(answer)
    }) as any
    return {
        calls,
        aborted,
        release: (index: number) => gates[index]?.(),
        releaseAll: () => gates.forEach(gate => gate?.()),
    }
}

function serve(handler: (call: Call, index: number) => Answer = call => answerFor(call.purls)) {
    const calls: Call[] = []
    global.fetch = (async (url: string, init: any) => {
        const call = {url: String(url), init, purls: JSON.parse(init.body).purls}
        calls.push(call)
        const answer = handler(call, calls.length - 1)
        if (answer instanceof Error) throw answer
        return respond(answer)
    }) as any
    return calls
}

async function until(what: string, condition: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1))
    if (!condition()) throw new Error(`timed out waiting for ${what}`)
}

const purls = (n: number, prefix = 'p') => Array.from({length: n}, (_, i) => `pkg:npm/${prefix}${i}@1.0.0`)

describe('the vulnerability server configuration', () => {
    const saved = {wait: process.env.DEPINDER_VULN_MAX_WAIT_MS, chunk: process.env.DEPINDER_VULN_CHUNK_SIZE}
    let warn: jest.SpyInstance
    beforeEach(() => {
        delete process.env.DEPINDER_VULN_MAX_WAIT_MS
        delete process.env.DEPINDER_VULN_CHUNK_SIZE
        warn = jest.spyOn(log, 'warn').mockImplementation((() => log) as any)
    })
    afterEach(() => {
        warn.mockRestore()
        for (const [name, value] of [['DEPINDER_VULN_MAX_WAIT_MS', saved.wait], ['DEPINDER_VULN_CHUNK_SIZE', saved.chunk]] as const) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    })

    it('is the resolver\'s address and token, with its own wait and chunk size', () => {
        expect(vulnServerConfig(resolver)).toEqual({
            url: 'http://server.example', token: 'secret', maxWaitMs: DEFAULT_VULN_MAX_WAIT_MS, chunkSize: MAX_VULN_CHUNK_SIZE,
        })
    })

    it('does not exist without a resolver, nor with --no-vuln-server', () => {
        expect(vulnServerConfig(undefined)).toBeUndefined()
        expect(vulnServerConfig(resolver, {vulnServer: false})).toBeUndefined()
        expect(vulnServerConfig(resolver, {vulnServer: true})).toBeDefined()
    })

    it('reads the wait and the chunk size from the environment, capping the chunk at the server\'s limit', () => {
        process.env.DEPINDER_VULN_MAX_WAIT_MS = '1500'
        process.env.DEPINDER_VULN_CHUNK_SIZE = '9000'
        expect(vulnServerConfig(resolver)).toMatchObject({maxWaitMs: 1500, chunkSize: 5000})
        process.env.DEPINDER_VULN_CHUNK_SIZE = '2000'
        expect(vulnServerConfig(resolver)?.chunkSize).toBe(2000)
        process.env.DEPINDER_VULN_CHUNK_SIZE = 'lots'
        process.env.DEPINDER_VULN_MAX_WAIT_MS = '-1'
        expect(vulnServerConfig(resolver)).toMatchObject({maxWaitMs: DEFAULT_VULN_MAX_WAIT_MS, chunkSize: 5000})
        expect(warn).toHaveBeenCalledTimes(2)
    })

    it('stands in for the local scan only when both trivy and grype are selected', () => {
        expect(usesVulnServer({trivy: true, grype: true})).toBe(true)
        expect(usesVulnServer({trivy: true, grype: false})).toBe(false)
        expect(usesVulnServer({trivy: false, grype: true})).toBe(false)
    })
})

describe('vulnChunks', () => {
    it('dedupes, keeps first-seen order and cuts at the size', () => {
        expect(vulnChunks(['a', 'b', 'a', 'c', 'd', 'b', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
        expect(vulnChunks([], 5000)).toEqual([])
    })
})

describe('parseServerTiming', () => {
    it('reads every metric with a duration', () => {
        expect(parseServerTiming('queue;dur=0, trivy;dur=57, grype;dur=863.5, total;dur=871, note;desc="x"'))
            .toEqual({queue: 0, trivy: 57, grype: 863.5, total: 871})
        expect(parseServerTiming(null)).toEqual({})
    })
})

describe('the vulnerability server client', () => {
    const realFetch = global.fetch
    beforeEach(() => {
        quiet.info.mockReset()
        quiet.warn.mockReset()
    })
    afterEach(() => {
        global.fetch = realFetch
    })

    it('posts every chunk at once, with the token and br, and puts the answers together', async () => {
        const asked = [...purls(5000, 'bad'), ...purls(5000), ...purls(2), 'pkg:npm/bad0@1.0.0', 'pkg:npm/lodash']
        const server = gatedServe()

        const result = fetchServerVulnerabilities(config, asked, quiet)
        // All three are in flight before any of them has answered.
        await until('three posts', () => server.calls.length === 3)
        server.releaseAll()
        const outcome = await result

        expect(server.calls.map(it => it.purls.length)).toEqual([5000, 5000, 1])
        expect(new Set(server.calls.flatMap(it => it.purls)).size).toBe(10_001)
        for (const call of server.calls) {
            expect(call.url).toBe('http://server.example/vulnerabilities')
            expect(call.init.method).toBe('POST')
            expect(call.init.headers).toEqual({
                'Authorization': 'Bearer secret', 'Content-Type': 'application/json', 'Accept-Encoding': 'br, gzip',
            })
        }
        expect(outcome.ok).toBe(true)
        if (!outcome.ok) return
        const {answer} = outcome
        expect(answer.purls).toBe(10_001)
        expect(answer.requests).toBe(3)
        expect(answer.vulnerabilities.size).toBe(5000)
        expect(answer.vulnerabilities.get('pkg:npm/bad0@1.0.0')).toEqual([finding('CVE-18')])
        expect(answer.vulnerabilities.has('pkg:npm/p0@1.0.0')).toBe(false)
        expect(answer.unsupported).toEqual(new Map([['pkg:npm/lodash', 'no_version']]))
        expect(answer.databases.trivy).toEqual([build('2026-10-01T19:00:16Z')])
        expect(answer.scanners).toEqual({trivy: ['0.74.0'], grype: ['0.118.0']})
        expect(answer.serverTiming).toEqual({queue: 3, trivy: 150, grype: 2400, total: 2553})
    })

    it('ignores what an answer says about a purl it was not sent', async () => {
        serve(() => ({status: 200, body: {
            vulnerabilities: {'pkg:npm/bad@1.0.0': [finding('CVE-1')], 'pkg:npm/other@1.0.0': [finding('CVE-2')]},
            unsupported: [{purl: 'pkg:npm/elsewhere', reason: 'no_version'}],
            databases: {}, scanners: {},
        }}))

        const outcome = await fetchServerVulnerabilities(config, ['pkg:npm/bad@1.0.0'], quiet)

        expect(outcome.ok && [...outcome.answer.vulnerabilities.keys()]).toEqual(['pkg:npm/bad@1.0.0'])
        expect(outcome.ok && outcome.answer.unsupported.size).toBe(0)
    })

    it('asks nothing for no purls', async () => {
        const calls = serve()
        const outcome = await fetchServerVulnerabilities(config, [], quiet)
        expect(calls).toHaveLength(0)
        expect(outcome.ok).toBe(true)
    })

    it('fails the whole ask when one chunk fails, aborts the others, and never retries', async () => {
        const server = gatedServe((call, index) => index === 1 ? {status: 503, body: {error: 'busy'}, headers: {'retry-after': '1'}} : answerFor(call.purls))

        const result = fetchServerVulnerabilities(config, purls(15_000), quiet)
        await until('three posts', () => server.calls.length === 3)
        server.release(1)
        const outcome = await result

        expect(outcome).toEqual({ok: false, reason: 'HTTP 503 (busy)'})
        expect(server.aborted).toEqual(new Set([0, 2]))
        // Each chunk posted exactly once: no retry, not even on a 503 with Retry-After.
        expect(server.calls).toHaveLength(3)
    })

    it.each([
        ['a 500 scan failure', {status: 500, body: {error: 'scan failed', scanner: 'grype', reason: 'boom'}}, 'HTTP 500 (scan failed: boom)'],
        ['databases not ready', {status: 503, body: {error: 'databases not ready', reason: 'grype: downloading'}}, 'HTTP 503 (databases not ready: grype: downloading)'],
        ['a wrong token', {status: 401, raw: 'Unauthorized'}, 'HTTP 401'],
        ['too many purls', {status: 413, body: {error: 'too many purls', max: 5000}}, 'HTTP 413 (too many purls)'],
        ['a body that is not JSON', {status: 200, raw: '<html>oops'}, expect.stringContaining('unreadable answer')],
        ['JSON that is not the answer', {status: 200, body: {hello: 'world'}}, 'answer has no vulnerabilities object'],
        ['findings that are not a list', {status: 200, body: {vulnerabilities: {'pkg:npm/a@1': {}}}}, expect.stringContaining('not a list')],
        ['a network error', new TypeError('fetch failed'), 'fetch failed'],
    ] as [string, Answer, unknown][])('fails on %s', async (_name, answer, reason) => {
        const calls = serve(() => answer)

        const outcome = await fetchServerVulnerabilities(config, ['pkg:npm/a@1.0.0'], quiet)

        expect(outcome).toEqual({ok: false, reason})
        expect(calls).toHaveLength(1)
    })

    it('fails when the answers are not all in by the deadline, abandoning the chunk still out', async () => {
        const server = gatedServe()

        const result = fetchServerVulnerabilities({...config, maxWaitMs: 50, chunkSize: 2}, purls(4), quiet)
        await until('two posts', () => server.calls.length === 2)
        server.release(0)
        const outcome = await result

        expect(outcome).toEqual({ok: false, reason: 'no complete answer within 50 ms'})
        expect(server.aborted).toEqual(new Set([1]))
        expect(server.calls).toHaveLength(2)
    })
})

describe('staleBuildWarnings', () => {
    it('names every stale build, and nothing when all are current', () => {
        const answer = {
            vulnerabilities: new Map(), unsupported: new Map(), purls: 0, requests: 1, serverTiming: {},
            scanners: {trivy: [], grype: []},
            databases: {trivy: [build('2026-10-01T19:00:16Z')], grype: [{...build('2026-09-20T06:33:48Z', true), age_seconds: 12 * 86400}]},
        }
        const warnings = staleBuildWarnings(answer)
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('grype database (built 2026-09-20T06:33:48Z) is 12 days old')
        expect(staleBuildWarnings({...answer, databases: {trivy: answer.databases.trivy, grype: []}})).toEqual([])
    })
})

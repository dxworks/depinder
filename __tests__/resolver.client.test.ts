import {
    CHUNK_SIZE,
    MAX_DEADLINE_MS,
    maxAgeFor,
    packageKeyOf,
    packChunks,
    PackageRecord,
    resetResolverClient,
    ResolvedEntry,
    resolvePurls,
    resolverUnavailable,
} from '../src/resolver/client'
import {RESOLVER_CHUNK_CONCURRENCY, ResolverConfig} from '../src/resolver/config'

/**
 * The resolver client against a canned server that answers in NDJSON, one package per line and a
 * trailer last. What is worth pinning is not that it can parse a line — it is that every way the
 * stream can arrive or fail to arrive ends with the run continuing: a line split across two reads
 * is still one line, a stream cut short keeps what it delivered and asks again only for the rest,
 * a 401 is fatal to the client and to nothing else, and a network error costs one retry and then
 * silence.
 *
 * Chunks are posted several at a time, so the second thing worth pinning is that concurrency did
 * not cost any of the above: the window is bounded, an answer already in flight when the resolver
 * goes unavailable is still kept, and nothing is asked after that.
 */

const config: ResolverConfig = {
    url: 'https://resolver.example', token: 'secret', maxWaitMs: 60_000,
    chunkConcurrency: RESOLVER_CHUNK_CONCURRENCY,
}

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

const FEEDS = {npm: {mode: 'feed', lag_seconds: 12.4, cursor_time: '2026-09-16T10:00:00Z'}}
const trailer = {done: true, feeds: FEEDS}

/** One item line per package, with every purl of it — the shape the server sends. */
function items(purls: string[], status = 'resolved'): object[] {
    const byKey = new Map<string, string[]>()
    for (const purl of purls) {
        const key = packageKeyOf(purl)
        byKey.set(key, [...byKey.get(key) ?? [], purl])
    }
    return [...byKey].map(([key, group]) => ({
        key,
        purls: group,
        status,
        ...status === 'resolved' || status === 'refreshing' ? {package: pkg(key.slice('pkg:npm/'.length))} : {},
    }))
}

const ndjson = (lines: object[]) => lines.map(it => JSON.stringify(it) + '\n').join('')

interface Call {
    url: string
    auth: string
    acceptEncoding: string
    method: string
    purls: string[]
    body: any
}

/**
 * What the fake server does with one request: a status with no body worth reading, a body given as
 * the raw pieces each read should return, or a stream it drives itself.
 */
type Answer =
    | {status: number}
    | {parts: (string | Error)[]}
    | {stream: ReadableStream<Uint8Array>}
    | Error

/** A whole, clean answer: every item line, then the trailer. */
const answerAll = (purls: string[], status = 'resolved'): Answer => ({parts: [ndjson([...items(purls, status), trailer])]})

const encoder = new TextEncoder()

/** A body that hands out `parts` one read at a time; an `Error` part breaks the stream there. */
function bodyOf(parts: (string | Error)[]): ReadableStream<Uint8Array> {
    let next = 0
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (next >= parts.length) return controller.close()
            const part = parts[next++]
            if (part instanceof Error) controller.error(part)
            else controller.enqueue(encoder.encode(part))
        },
    })
}

function respond(answer: Exclude<Answer, Error>): Response {
    if ('status' in answer) return new Response('{"error":"nope"}', {status: answer.status})
    const body = 'stream' in answer ? answer.stream : bodyOf(answer.parts)
    return new Response(body, {status: 200, headers: {'content-type': 'application/x-ndjson'}})
}

function record(url: string, init: any): Call {
    const body = JSON.parse(init.body)
    return {
        url: String(url), auth: init.headers.Authorization, acceptEncoding: init.headers['Accept-Encoding'],
        method: init.method, purls: body.purls, body,
    }
}

/**
 * Installs a fake server and returns the requests it saw, in order. Nothing is asserted in here:
 * the client swallows every exception a request throws, so an assertion failure inside the mock
 * would be reported as a network error and retried rather than failing the test.
 */
function serve(handler: (call: Call, index: number) => Answer) {
    const calls: Call[] = []
    global.fetch = (async (url: string, init: any) => {
        const call = record(url, init)
        const index = calls.length
        calls.push(call)
        const answer = handler(call, index)
        if (answer instanceof Error) throw answer
        return respond(answer)
    }) as any
    return calls
}

/**
 * The same fake server, but every request parks until the test lets it answer. Without this a
 * concurrency window is invisible: the immediate server above resolves each call before the next
 * chunk is taken, so "four at once" and "one at a time" produce identical call lists.
 */
function gatedServe(handler: (call: Call, index: number) => Answer = call => answerAll(call.purls)) {
    const calls: Call[] = []
    const gates: Array<(() => void) | undefined> = []
    let inFlight = 0
    let peakInFlight = 0

    global.fetch = (async (url: string, init: any) => {
        const index = calls.length
        calls.push(record(url, init))
        inFlight++
        peakInFlight = Math.max(peakInFlight, inFlight)
        await new Promise<void>(resolve => { gates[index] = resolve })
        inFlight--
        const answer = handler(calls[index], index)
        if (answer instanceof Error) throw answer
        return respond(answer)
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

/** Waits for the client to get somewhere, without pinning how many turns it takes to get there. */
async function until(what: string, condition: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1))
    if (!condition()) throw new Error(`timed out waiting for ${what}`)
}

const manyPurls = (chunks: number) =>
    Array.from({length: CHUNK_SIZE * chunks}, (_, i) => `pkg:npm/p${i}@1.0.0`)

const warnings = (pattern: string) => quiet.warn.mock.calls.map(it => String(it[0])).filter(it => it.includes(pattern))

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

    it('asks once, with the bearer token and the deadline, and reads the stream', async () => {
        const calls = serve(call => answerAll(call.purls))

        const answers = await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet)

        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://resolver.example/resolve')
        expect(calls[0].method).toBe('POST')
        expect(calls[0].auth).toBe('Bearer secret')
        // Asked for explicitly: undici decodes br, but on its own only offers gzip and deflate.
        expect(calls[0].acceptEncoding).toBe('br, gzip')
        expect(calls[0].body.wait_ms).toBeUndefined()
        expect(calls[0].body.deadline_ms).toBeGreaterThan(59_000)
        expect(calls[0].body.deadline_ms).toBeLessThanOrEqual(MAX_DEADLINE_MS)
        expect(answers.get('pkg:npm/left-pad@1.0.0')?.status).toBe('resolved')
        expect(answers.get('pkg:npm/left-pad@1.0.0')?.package?.name).toBe('left-pad')
        expect(warnings('')).toHaveLength(0)
    })

    it('caps deadline_ms at the server\'s 60 s, and sends what is left of a smaller budget', async () => {
        const calls = serve(call => answerAll(call.purls))

        await resolvePurls({...config, maxWaitMs: 10 * 60_000}, ['pkg:npm/a@1.0.0'], quiet)
        await resolvePurls({...config, maxWaitMs: 5000}, ['pkg:npm/b@1.0.0'], quiet)

        expect(calls[0].body.deadline_ms).toBe(MAX_DEADLINE_MS)
        expect(calls[1].body.deadline_ms).toBeGreaterThan(4000)
        expect(calls[1].body.deadline_ms).toBeLessThanOrEqual(5000)
    })

    it('sends deadline_ms 0 rather than nothing once the budget is spent', async () => {
        // A late chunk still gets every answer the server already has.
        const calls = serve(call => answerAll(call.purls))
        const answers = await resolvePurls({...config, maxWaitMs: 0}, ['pkg:npm/a@1.0.0'], quiet)
        expect(calls[0].body.deadline_ms).toBe(0)
        expect(answers.get('pkg:npm/a@1.0.0')?.status).toBe('resolved')
    })

    it('reads a line split across two reads, a character split too, and skips blank lines', async () => {
        const first = JSON.stringify({key: 'pkg:npm/café', purls: ['pkg:npm/café@1.0.0'], status: 'not_found'})
        const second = JSON.stringify({key: 'pkg:npm/left-pad', purls: ['pkg:npm/left-pad@1.0.0'], status: 'resolved', package: pkg('left-pad')})
        // The byte-level split lands inside the two-byte é, which only a streaming decoder survives.
        const bytes = encoder.encode(first + '\n\n' + second + '\n' + JSON.stringify(trailer) + '\n')
        const cut = encoder.encode(first.slice(0, first.indexOf('é'))).length + 1
        const middle = cut + 40
        global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes.slice(0, cut))
                controller.enqueue(bytes.slice(cut, middle))
                controller.enqueue(bytes.slice(middle))
                controller.close()
            },
        }), {status: 200})) as any

        const answers = await resolvePurls(config, ['pkg:npm/café@1.0.0', 'pkg:npm/left-pad@1.0.0'], quiet)

        expect(answers.get('pkg:npm/café@1.0.0')?.status).toBe('not_found')
        expect(answers.get('pkg:npm/left-pad@1.0.0')).toMatchObject({status: 'resolved', package: {name: 'left-pad'}})
        expect(resolverUnavailable()).toBe(false)
    })

    it('splits the purls of one item line into one answer each, all with the package', async () => {
        serve(call => answerAll(call.purls))
        const answers = await resolvePurls(config, ['pkg:npm/lodash@4.17.21', 'pkg:npm/lodash@4.17.20'], quiet)
        expect(answers.get('pkg:npm/lodash@4.17.21')?.package?.name).toBe('lodash')
        expect(answers.get('pkg:npm/lodash@4.17.20')?.package?.name).toBe('lodash')
    })

    it('hands each answer to onItem before the stream ends', async () => {
        let finish: () => void = () => undefined
        global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(ndjson(items(['pkg:npm/fast@1.0.0']))))
                // The rest — the slow package and the trailer — only when the test says so.
                finish = () => {
                    controller.enqueue(encoder.encode(ndjson([...items(['pkg:npm/slow@1.0.0']), trailer])))
                    controller.close()
                }
            },
        }), {status: 200})) as any
        const seen: [string, ResolvedEntry][] = []
        let settled = false

        const answers = resolvePurls(config, ['pkg:npm/fast@1.0.0', 'pkg:npm/slow@1.0.0'], quiet,
            (purl, entry) => seen.push([purl, entry]))
        answers.then(() => { settled = true })

        await until('the first line', () => seen.length === 1)
        expect(seen[0][0]).toBe('pkg:npm/fast@1.0.0')
        expect(seen[0][1].status).toBe('resolved')
        expect(settled).toBe(false)

        finish()
        const result = await answers
        expect(seen.map(it => it[0])).toEqual(['pkg:npm/fast@1.0.0', 'pkg:npm/slow@1.0.0'])
        expect(result.size).toBe(2)
    })

    it('reports the per-feed lag once, from the trailer', async () => {
        serve(call => answerAll(call.purls))
        await resolvePurls(config, ['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0'], quiet)
        const freshness = quiet.info.mock.calls.map(it => String(it[0])).filter(it => it.startsWith('Resolver freshness'))
        expect(freshness).toEqual(['Resolver freshness: npm feed lag 12s'])
    })

    it('splits more than 2000 purls into chunks the server accepts', async () => {
        const purls = Array.from({length: CHUNK_SIZE + 500}, (_, i) => `pkg:npm/p${i}@1.0.0`)
        const calls = serve(call => answerAll(call.purls))

        const answers = await resolvePurls(config, purls, quiet)

        expect(calls.map(it => it.purls.length)).toEqual([CHUNK_SIZE, 500])
        expect(answers.size).toBe(purls.length)
    })

    it('never puts two versions of one package in two chunks', async () => {
        // 1999 single packages, then a package with three versions that would straddle the line.
        const purls = [
            ...Array.from({length: CHUNK_SIZE - 1}, (_, i) => `pkg:npm/p${i}@1.0.0`),
            'pkg:npm/%40scope/split@1.0.0', 'pkg:npm/%40scope/split@2.0.0', 'pkg:npm/%40scope/split@3.0.0',
        ]
        const calls = serve(call => answerAll(call.purls))

        await resolvePurls(config, purls, quiet)

        expect(calls.map(it => it.purls.length)).toEqual([CHUNK_SIZE - 1, 3])
        expect(calls[1].purls).toEqual(['pkg:npm/%40scope/split@1.0.0', 'pkg:npm/%40scope/split@2.0.0', 'pkg:npm/%40scope/split@3.0.0'])
    })

    it('groups purls by package, whatever the scope, qualifiers or subpath', () => {
        expect(packageKeyOf('pkg:npm/%40types/node@20.1.0')).toBe('pkg:npm/%40types/node')
        expect(packageKeyOf('pkg:npm/@types/node@20.1.0')).toBe('pkg:npm/@types/node')
        expect(packageKeyOf('pkg:npm/@types/node')).toBe('pkg:npm/@types/node')
        expect(packageKeyOf('pkg:maven/org.a/b@1.0?type=jar#sub/path')).toBe('pkg:maven/org.a/b')
        expect(packageKeyOf('pkg:maven/org.a/b?type=jar')).toBe('pkg:maven/org.a/b')
        expect(packageKeyOf('pkg:golang/example.com/a@b/mod@v1.0.0')).toBe('pkg:golang/example.com/a@b/mod')

        // A package larger than a chunk is not split either: it gets a chunk of its own.
        const big = Array.from({length: 5}, (_, i) => `pkg:npm/big@${i}.0.0`)
        expect(packChunks(['pkg:npm/a@1', ...big, 'pkg:npm/b@1', 'pkg:npm/a@2'], 3))
            .toEqual([['pkg:npm/a@1', 'pkg:npm/a@2'], big, ['pkg:npm/b@1']])
    })

    it('takes pending and refreshing as final: no second ask', async () => {
        const calls = serve(() => ({
            parts: [ndjson([
                {key: 'pkg:npm/known', purls: ['pkg:npm/known@1.0.0'], status: 'resolved', package: pkg('known')},
                {key: 'pkg:npm/new', purls: ['pkg:npm/new@1.0.0'], status: 'pending'},
                {key: 'pkg:npm/old', purls: ['pkg:npm/old@1.0.0'], status: 'refreshing', package: pkg('old')},
                {key: 'pkg:npm/gone', purls: ['pkg:npm/gone@1.0.0'], status: 'not_found'},
                {key: null, purls: ['nonsense'], status: 'invalid', reason: 'not a purl'},
                trailer,
            ])],
        }))

        const answers = await resolvePurls(config,
            ['pkg:npm/known@1.0.0', 'pkg:npm/new@1.0.0', 'pkg:npm/old@1.0.0', 'pkg:npm/gone@1.0.0', 'nonsense'], quiet)

        expect(calls).toHaveLength(1)
        expect(answers.get('pkg:npm/new@1.0.0')?.status).toBe('pending')
        expect(answers.get('pkg:npm/old@1.0.0')).toMatchObject({status: 'refreshing', package: {name: 'old'}})
        expect(answers.get('pkg:npm/gone@1.0.0')).toEqual({status: 'not_found', package: undefined, reason: undefined})
        expect(answers.get('nonsense')).toMatchObject({status: 'invalid', reason: 'not a purl'})
        expect(quiet.info).toHaveBeenCalledWith(expect.stringMatching(
            /5 purl\(s\): 1 resolved, 1 refreshing \(last known facts\), 1 pending, 1 not found, 1 invalid$/))
    })

    it('keeps what a cut-off stream delivered, and asks again only for the rest', async () => {
        const purls = ['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0', 'pkg:npm/c@1.0.0']
        const calls = serve((call, index) => index === 0
            // Two packages, then the connection drops before the third and the trailer.
            ? {parts: [ndjson(items(['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0'])), new Error('socket hang up')]}
            : answerAll(call.purls))
        const seen: string[] = []

        const answers = await resolvePurls(config, purls, quiet, purl => seen.push(purl))

        expect(calls).toHaveLength(2)
        expect(calls[1].purls).toEqual(['pkg:npm/c@1.0.0'])
        expect(calls[1].body.deadline_ms).toBeGreaterThan(0)
        expect([...answers.keys()].sort()).toEqual(purls)
        // Every purl is handed over exactly once, across both posts.
        expect(seen.sort()).toEqual(purls)
        expect(resolverUnavailable()).toBe(false)
        expect(warnings('asking again for the 1 purl(s)')).toHaveLength(1)
    })

    it('treats a body that ends without its trailer as cut off', async () => {
        const calls = serve((call, index) => index === 0
            ? {parts: [ndjson(items(['pkg:npm/a@1.0.0']))]}
            : answerAll(call.purls))

        const answers = await resolvePurls(config, ['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0'], quiet)

        expect(calls.map(it => it.purls)).toEqual([['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0'], ['pkg:npm/b@1.0.0']])
        expect(answers.size).toBe(2)
    })

    it('asks again for a purl a complete stream left out', async () => {
        const calls = serve((call, index) => index === 0
            ? {parts: [ndjson([...items(['pkg:npm/a@1.0.0']), trailer])]}
            : answerAll(call.purls))

        const answers = await resolvePurls(config, ['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0'], quiet)

        expect(calls[1].purls).toEqual(['pkg:npm/b@1.0.0'])
        expect(answers.get('pkg:npm/b@1.0.0')?.status).toBe('resolved')
    })

    it('gives up for the run when the retry is cut off too, keeping both halves', async () => {
        const calls = serve((_call, index) => index === 0
            ? {parts: [ndjson(items(['pkg:npm/a@1.0.0'])), new Error('reset')]}
            : {parts: [ndjson(items(['pkg:npm/b@1.0.0'])), new Error('reset')]})

        const answers = await resolvePurls(config, ['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0', 'pkg:npm/c@1.0.0'], quiet)

        expect(calls).toHaveLength(2)
        expect([...answers.keys()].sort()).toEqual(['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0'])
        expect(resolverUnavailable()).toBe(true)
        expect(quiet.info).toHaveBeenCalledWith(expect.stringMatching(/1 unanswered$/))
    })

    it('treats a malformed line as a broken stream, keeping the lines before it', async () => {
        const calls = serve((call, index) => index === 0
            ? {parts: [ndjson(items(['pkg:npm/a@1.0.0'])) + '{"key": tru\n' + ndjson(items(['pkg:npm/b@1.0.0']))]}
            : answerAll(call.purls))

        const answers = await resolvePurls(config, ['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0'], quiet)

        expect(calls[1].purls).toEqual(['pkg:npm/b@1.0.0'])
        expect(answers.size).toBe(2)
    })

    it('sends max_age as the seconds since the run\'s cutoff, worked out at the moment it is sent', async () => {
        const calls = serve(call => answerAll(call.purls))
        const freshAfterMs = Date.now() - 86_400_000

        await resolvePurls({...config, freshAfterMs}, ['pkg:npm/left-pad@1.0.0'], quiet)

        expect(calls[0].body.max_age).toBeGreaterThanOrEqual(86_400)
        expect(calls[0].body.max_age).toBeLessThan(86_410)
    })

    it('leaves max_age to the server when the run names no cutoff', async () => {
        const calls = serve(call => answerAll(call.purls))
        await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet)
        expect(calls[0].body.max_age).toBeUndefined()
    })

    it('floors max_age, and never sends a negative one', () => {
        expect(maxAgeFor(10_000, 10_999)).toBe(0)
        expect(maxAgeFor(10_000, 11_000)).toBe(1)
        expect(maxAgeFor(10_000, 5_000)).toBe(0)
    })

    it('treats a 401 as final: no retry, no throw, and no further calls this run', async () => {
        const calls = serve(() => ({status: 401}))

        const answers = await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet)

        expect(answers.size).toBe(0)
        expect(calls).toHaveLength(1)
        expect(resolverUnavailable()).toBe(true)
        expect(warnings('Resolver unavailable')).toHaveLength(1)

        // The rest of the run does not pay the timeout again.
        expect((await resolvePurls(config, ['pkg:npm/other@1.0.0'], quiet)).size).toBe(0)
        expect(calls).toHaveLength(1)
    })

    it('treats a 400 the same way, so an old or new body the server rejects fails loudly once', async () => {
        const calls = serve(() => ({status: 400}))
        await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet)
        expect(calls).toHaveLength(1)
        expect(resolverUnavailable()).toBe(true)
        expect(warnings('HTTP 400')).toHaveLength(1)
    })

    it('retries a network error exactly once, then gives up for the run', async () => {
        const calls = serve(() => new Error('ECONNREFUSED'))

        const answers = await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet)

        expect(calls).toHaveLength(2)
        expect(answers.size).toBe(0)
        expect(resolverUnavailable()).toBe(true)
    })

    it('retries a 500 once, with the whole chunk, and keeps the answer when the retry succeeds', async () => {
        const purls = ['pkg:npm/left-pad@1.0.0', 'pkg:npm/right-pad@1.0.0']
        const calls = serve((call, index) => index === 0 ? {status: 503} : answerAll(call.purls))

        const answers = await resolvePurls(config, purls, quiet)

        expect(calls).toHaveLength(2)
        expect(calls[1].purls).toEqual(purls)
        expect(answers.get('pkg:npm/left-pad@1.0.0')?.status).toBe('resolved')
        expect(resolverUnavailable()).toBe(false)
    })

    it('abandons the remaining chunks once the server is unavailable', async () => {
        const calls = serve(() => ({status: 403}))

        await resolvePurls(config, manyPurls(6), quiet)

        // The first window's worth was already asked before the first 403 came back; the chunks
        // behind them are never asked, and only one line is logged about it.
        expect(calls).toHaveLength(RESOLVER_CHUNK_CONCURRENCY)
        expect(warnings('Resolver unavailable')).toHaveLength(1)
    })

    it('keeps the window full, and starts the next chunk only as one lands', async () => {
        const server = gatedServe()
        const answers = resolvePurls(config, manyPurls(6), quiet)

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
        const answers = resolvePurls({...config, chunkConcurrency: 1}, manyPurls(3), quiet)

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
        const server = gatedServe((call, index) => index === 1 ? {status: 400} : answerAll(call.purls))
        const answers = resolvePurls(config, manyPurls(6), quiet)

        await until('the first window of chunks', () => server.calls.length === RESOLVER_CHUNK_CONCURRENCY)
        server.release(1)
        await until('the client to give up on the resolver', () => resolverUnavailable())
        server.releaseAll()

        const result = await answers

        expect(server.calls).toHaveLength(RESOLVER_CHUNK_CONCURRENCY)
        expect(result.size).toBe(CHUNK_SIZE * (RESOLVER_CHUNK_CONCURRENCY - 1))
        expect(resolverUnavailable()).toBe(true)
    })

    it('treats a client-side timeout as transient: one retry, and the run carries on', async () => {
        // What `AbortSignal.timeout` throws when the slack runs out. It carries no HTTP status, so
        // it is retryable — and the retry's answer is kept, rather than the abort costing the run
        // the resolver.
        const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'})
        const calls = serve((call, index) => index === 0 ? timeout : answerAll(call.purls))

        const answers = await resolvePurls(config, ['pkg:npm/left-pad@1.0.0'], quiet)

        expect(calls).toHaveLength(2)
        expect(answers.get('pkg:npm/left-pad@1.0.0')?.status).toBe('resolved')
        expect(resolverUnavailable()).toBe(false)
        expect(warnings('Resolver unavailable')).toHaveLength(0)
        expect(warnings('retrying once')).toHaveLength(1)
    })

    it('asks nothing when given no purls', async () => {
        const calls = serve(call => answerAll(call.purls))
        expect((await resolvePurls(config, [], quiet)).size).toBe(0)
        expect(calls).toHaveLength(0)
    })
})

import {describe, expect, it} from 'vitest'
import {POLL_INTERVAL_MS} from '../../../src/resolver/api/resolve/types.js'
import {createServer} from '../../../src/resolver/api/server.js'
import type {ResolveStore} from '../../../src/resolver/api/store.js'
import {nullLogger, type Logger} from '../../../src/shared/log.js'
import type {PackageVersionsRow, QueueStats, RegistryFeedRow, ResolvePackageRow} from '../../../src/resolver/db/rows.js'
import {auth, config, db, feedRow, knownRow, ndjson, store} from './server.helpers.js'

describe('a failure the caller cannot see', () => {
    /** A logger that keeps what it was given, so a test can read the one record of a 500. */
    function capturingLogger(): {log: Logger; errors: {msg: string; fields?: Record<string, unknown>}[]} {
        const errors: {msg: string; fields?: Record<string, unknown>}[] = []
        const log: Logger = {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: (msg, fields) => void errors.push({msg, fields}),
            child: () => log,
        }
        return {log, errors}
    }

    const serverThatThrows = async (thrown: unknown) => {
        const {log, errors} = capturingLogger()
        const failing: ResolveStore = {...store, getPackages: async () => Promise.reject(thrown)}
        const failingApp = await createServer({db, config, log, store: failing})
        await failingApp.ready()
        return {app: failingApp, errors}
    }

    it('logs the pool checkout that timed out, and tells the caller nothing else', async () => {
        // What the api used to get when the worker held every client of the pool they shared.
        const {app: failingApp, errors} = await serverThatThrows(new Error('timeout exceeded when trying to connect'))
        try {
            const response = await failingApp.inject({
                method: 'POST',
                url: '/resolve',
                headers: auth,
                payload: {purls: ['pkg:npm/express'], deadline_ms: 0},
            })

            expect(response.statusCode).toBe(500)
            expect(response.json()).toEqual({error: 'internal error'})
            expect(errors).toHaveLength(1)
            expect(errors[0]!.msg).toBe('request failed')
            expect(errors[0]!.fields).toMatchObject({
                path: '/resolve',
                error: 'timeout exceeded when trying to connect',
            })
        } finally {
            await failingApp.close()
        }
    })

    it('carries a SQLSTATE through, so a deadlock victim is recognisable in the log', async () => {
        const {app: failingApp, errors} = await serverThatThrows(
            Object.assign(new Error('deadlock detected'), {code: '40P01'}),
        )
        try {
            await failingApp.inject({
                method: 'POST',
                url: '/resolve',
                headers: auth,
                payload: {purls: ['pkg:npm/express'], deadline_ms: 0},
            })
            expect(errors[0]!.fields).toMatchObject({error: 'deadlock detected', code: '40P01'})
        } finally {
            await failingApp.close()
        }
    })

    it('ends a stream that fails after its 200 without the trailer, and logs why', async () => {
        // The status has gone, so the only way left to say "this is not the whole answer" is to
        // stop short of the trailer. The lines already sent stand.
        const {log, errors} = capturingLogger()
        const failing: ResolveStore = {
            ...store,
            async getPackages(keys) {
                return keys.map(key => knownRow(key))
            },
            getVersions: async () => Promise.reject(new Error('connection terminated unexpectedly')),
        }
        const failingApp = await createServer({db, config, log, store: failing})
        try {
            const response = await failingApp.inject({
                method: 'POST',
                url: '/resolve',
                headers: auth,
                payload: {purls: ['not-a-purl', 'pkg:npm/express'], deadline_ms: 0},
            })

            expect(response.statusCode).toBe(200)
            const lines = ndjson(response.payload)
            expect(lines).toEqual([{key: null, purls: ['not-a-purl'], status: 'invalid', reason: expect.any(String)}])
            expect(errors).toEqual([
                {
                    msg: 'resolve stream failed',
                    fields: expect.objectContaining({path: '/resolve', error: 'connection terminated unexpectedly'}),
                },
            ])
        } finally {
            await failingApp.close()
        }
    })
})

/** A server listening on a real port, for what `app.inject` cannot express: a socket, and time. */
async function listening(log: Logger, using: ResolveStore): Promise<{url: string; close: () => Promise<void>}> {
    const server = await createServer({db, config, log, store: using})
    await server.listen({port: 0, host: '127.0.0.1'})
    const address = server.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {url: `http://127.0.0.1:${port}/resolve`, close: () => server.close()}
}

/** Keeps every line, so a test can assert both what was said and what was not. */
function recordingLogger(): {log: Logger; lines: {level: string; msg: string}[]} {
    const lines: {level: string; msg: string}[] = []
    const log: Logger = {
        debug: msg => void lines.push({level: 'debug', msg}),
        info: msg => void lines.push({level: 'info', msg}),
        warn: msg => void lines.push({level: 'warn', msg}),
        error: msg => void lines.push({level: 'error', msg}),
        child: () => log,
    }
    return {log, lines}
}

/**
 * A store that knows `pkg:npm/express` and nothing else, so anything else is pending and the
 * request waits for it — and counts the reads that come after the first.
 */
function waitingStore(): {store: ResolveStore; versionCalls: number; feedCalls: number} {
    const counts = {versionCalls: 0, feedCalls: 0}
    return {
        get versionCalls() {
            return counts.versionCalls
        },
        get feedCalls() {
            return counts.feedCalls
        },
        store: {
            async getPackages(keys): Promise<ResolvePackageRow[]> {
                return keys.filter(key => key === 'pkg:npm/express').map(knownRow)
            },
            async getVersions(keys): Promise<PackageVersionsRow[]> {
                counts.versionCalls++
                return keys.map(key => ({package_key: key, versions: [['1.0.0', 1_600_000_000, 0]]}))
            },
            async createPending(): Promise<void> {
                return undefined
            },
            async queueRefresh(): Promise<void> {
                return undefined
            },
            async markWanted(): Promise<void> {
                return undefined
            },
            async getFeeds(): Promise<RegistryFeedRow[]> {
                counts.feedCalls++
                return [feedRow]
            },
            async getQueue(): Promise<QueueStats> {
                return {groups: [], errors: 0}
            },
        },
    }
}

async function until(what: string, condition: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10))
    if (!condition()) throw new Error(`timed out waiting for ${what}`)
}

describe('a stream over a real socket', () => {
    it('delivers what is known long before the deadline, compressed, and the rest at it', async () => {
        const waiting = waitingStore()
        const server = await listening(nullLogger, waiting.store)
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
            const sentAt = Date.now()
            // Node's fetch asks for `gzip, deflate` on its own; brotli it decodes, but only gets
            // when asked for it. Either way it decodes as the bytes arrive.
            const response = await fetch(server.url, {
                method: 'POST',
                headers: {...auth, 'content-type': 'application/json', 'accept-encoding': 'br, gzip'},
                body: JSON.stringify({purls: ['pkg:npm/express@1.0.0', 'pkg:npm/brand-new'], deadline_ms: 1_000}),
            })
            expect(response.status).toBe(200)
            expect(response.headers.get('content-encoding')).toBe('br')

            reader = response.body!.getReader()
            const decoder = new TextDecoder()
            let text = ''
            while (!text.includes('\n')) {
                const {value, done} = await reader.read()
                if (done) break
                text += decoder.decode(value, {stream: true})
            }
            // The known package, readable while the server is still holding the unknown one.
            expect(Date.now() - sentAt).toBeLessThan(800)
            expect(JSON.parse(text.split('\n')[0]!)).toMatchObject({key: 'pkg:npm/express', status: 'resolved'})

            for (;;) {
                const {value, done} = await reader.read()
                if (done) break
                text += decoder.decode(value, {stream: true})
            }
            expect(Date.now() - sentAt).toBeGreaterThanOrEqual(1_000)
            expect(ndjson(text).slice(1)).toEqual([
                {key: 'pkg:npm/brand-new', purls: ['pkg:npm/brand-new'], status: 'pending'},
                {done: true, feeds: {npm: {mode: 'feed', lag_seconds: 30, cursor_time: '2026-09-16T09:59:00.000Z'}}},
            ])
        } finally {
            // A failed expectation must not leave a body half read: the server would wait for it.
            await reader?.cancel().catch(() => undefined)
            await server.close()
        }
    })
})

/**
 * The caller hanging up, over a real socket.
 *
 * `app.inject` cannot express this: it has no connection to close, and the event that matters is
 * one node raises on the response stream. So this one listens. What it pins is the wiring — that
 * `reply.raw`'s `close` is the event a Fastify 5 abort actually arrives as (`request.raw`'s fires
 * when the BODY is read, long before, and `aborted` never fires at all), and that the handler is
 * stopped by it rather than running on to read for nobody.
 */
describe('a caller that hangs up', () => {
    it('stops working for it, and keeps answering everyone else', async () => {
        const {log, lines} = recordingLogger()
        const waiting = waitingStore()
        const server = await listening(log, waiting.store)

        try {
            const controller = new AbortController()
            // Ten seconds of deadline the caller will not stay for.
            const response = await fetch(server.url, {
                method: 'POST',
                headers: {...auth, 'content-type': 'application/json'},
                body: JSON.stringify({purls: ['pkg:npm/brand-new'], deadline_ms: 10_000}),
                signal: controller.signal,
            })
            // The 200 arrives at once, before any line: the request was taken.
            expect(response.status).toBe(200)
            const body = response.text().then(() => 'read', (e: Error) => e.name)

            // Long enough for the request to be in the wait, far short of the ten seconds.
            await new Promise(resolve => setTimeout(resolve, 100))
            const abortedAt = Date.now()
            controller.abort()
            expect(await body).toBe('AbortError')

            // It gave up on its own rather than waiting the request out: the line is logged from
            // the handler, and it arrives seconds before the deadline would have.
            await until('the handler to notice', () => lines.some(it => it.msg === 'resolve abandoned, caller gone'))
            // Sooner than the poll interval, which is what "breaks out of the wait" means: the
            // abort ends the sleep rather than being noticed on the far side of it.
            expect(Date.now() - abortedAt).toBeLessThan(POLL_INTERVAL_MS)
            expect(waiting.versionCalls).toBe(0)
            expect(waiting.feedCalls).toBe(0)
            // A client walking away is not a server error, so nothing is logged as one.
            expect(lines.filter(it => it.level === 'error')).toEqual([])

            // And the next caller is served immediately.
            const next = await fetch(server.url, {
                method: 'POST',
                headers: {...auth, 'content-type': 'application/json'},
                body: JSON.stringify({purls: ['not-a-purl'], deadline_ms: 0}),
            })
            expect(next.status).toBe(200)
            expect(ndjson(await next.text())[0]).toMatchObject({status: 'invalid'})
        } finally {
            await server.close()
        }
    })
})

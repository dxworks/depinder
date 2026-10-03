import {brotliDecompressSync, gunzipSync} from 'node:zlib'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import type {FastifyInstance} from 'fastify'
import {COMPRESS_THRESHOLD_BYTES} from '../../../src/shared/http-server.js'
import {createServer} from '../../../src/resolver/api/server.js'
import {nullLogger} from '../../../src/shared/log.js'
import {auth, config, db, ndjson, store, TOKEN} from './server.helpers.js'

let app: FastifyInstance

beforeAll(async () => {
    app = await createServer({db, config, log: nullLogger, store})
    await app.ready()
})

afterAll(async () => {
    await app.close()
})

describe('auth', () => {
    it('lets the health check through unauthenticated', async () => {
        const response = await app.inject({method: 'GET', url: '/health'})
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({status: 'ok', db: 'ok'})
    })

    it('rejects a request with no token', async () => {
        const response = await app.inject({method: 'POST', url: '/resolve', payload: {purls: []}})
        expect(response.statusCode).toBe(401)
    })

    it('rejects a wrong token and a malformed header', async () => {
        for (const authorization of [`Bearer ${'x'.repeat(TOKEN.length)}`, `Bearer ${TOKEN}extra`, TOKEN, 'Basic abc']) {
            const response = await app.inject({
                method: 'GET',
                url: '/feeds',
                headers: {authorization},
            })
            expect(response.statusCode).toBe(401)
        }
    })

    it('accepts the configured token', async () => {
        const response = await app.inject({method: 'GET', url: '/feeds', headers: auth})
        expect(response.statusCode).toBe(200)
    })
})

describe('routes', () => {
    it('POST /resolve answers as an NDJSON stream: one line per package, then the trailer', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/resolve',
            headers: auth,
            payload: {purls: ['not-a-purl', 'pkg:npm/brand-new'], deadline_ms: 0},
        })

        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toBe('application/x-ndjson')
        expect(response.headers['content-encoding']).toBeUndefined()
        const lines = ndjson(response.payload)
        expect(lines[0]).toMatchObject({key: null, purls: ['not-a-purl'], status: 'invalid'})
        expect(lines[1]).toEqual({key: 'pkg:npm/brand-new', purls: ['pkg:npm/brand-new'], status: 'pending'})
        expect(lines[2]).toMatchObject({done: true, feeds: {npm: {mode: 'feed', lag_seconds: 30}}})
        expect(lines).toHaveLength(3)
    })

    it('POST /resolve rejects a body it cannot use', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/resolve',
            headers: auth,
            payload: {purls: 'pkg:npm/express'},
        })
        expect(response.statusCode).toBe(400)
        expect(response.json().error).toMatch(/purls/)
    })

    it('POST /resolve tells an old client that sends wait_ms what to send instead', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/resolve',
            headers: auth,
            payload: {purls: ['pkg:npm/express'], wait_ms: 10_000},
        })
        expect(response.statusCode).toBe(400)
        expect(response.json().error).toMatch(/deadline_ms/)
    })

    it('GET /queue sums the queue per ecosystem and names the priorities', async () => {
        const unauthorised = await app.inject({method: 'GET', url: '/queue'})
        expect(unauthorised.statusCode).toBe(401)

        const response = await app.inject({method: 'GET', url: '/queue', headers: auth})
        expect(response.json()).toEqual({
            listener: 'off',
            errors: 4,
            total: {queued: 35, urgent: 13, in_flight: 5, due: 29, retrying: 2, oldest_due_s: 700},
            types: {
                cargo: {queued: 30, urgent: 10, in_flight: 2, due: 28, retrying: 0, oldest_due_s: 95, by_priority: {'demand/feed': 30}},
                npm: {queued: 5, urgent: 3, in_flight: 3, due: 1, retrying: 2, oldest_due_s: 700, by_priority: {'demand/feed': 3, retry: 2}},
            },
        })
    })

    it('GET /feeds reports each registry with its lag', async () => {
        const response = await app.inject({method: 'GET', url: '/feeds', headers: auth})
        expect(response.json()).toEqual({
            feeds: {
                npm: {
                    mode: 'feed',
                    lag_seconds: 30,
                    cursor: '31000004',
                    cursor_time: '2026-09-16T09:59:00.000Z',
                    last_run_at: '2026-09-16T09:59:30.000Z',
                    last_ok_at: '2026-09-16T09:59:30.000Z',
                    upstream_head_time: null,
                    last_error: null,
                },
            },
        })
    })
})

describe('compression', () => {
    // Every purl here is rejected, which is answer enough: 200 lines, and the store this server was
    // built with holds no packages.
    const payload = {purls: new Array(200).fill('not-a-purl'), deadline_ms: 0}
    const resolve = (headers: Record<string, string>) =>
        app.inject({method: 'POST', url: '/resolve', headers: {...auth, ...headers}, payload})

    it('leaves the stream alone for a client that asked for nothing', async () => {
        const response = await resolve({})

        expect(response.headers['content-encoding']).toBeUndefined()
        expect(response.headers.vary).toMatch(/accept-encoding/i)
        expect(ndjson(response.payload)).toHaveLength(201)
    })

    it('gzips for a client that reads gzip, and hands back the same lines', async () => {
        const plain = await resolve({})
        const response = await resolve({'accept-encoding': 'gzip, deflate'})

        expect(response.headers['content-encoding']).toBe('gzip')
        expect(response.headers.vary).toMatch(/accept-encoding/i)
        expect(response.rawPayload.length).toBeLessThan(plain.rawPayload.length / 2)
        expect(ndjson(gunzipSync(response.rawPayload).toString())).toEqual(ndjson(plain.payload))
    })

    it('prefers brotli when the client reads it', async () => {
        const plain = await resolve({})
        const response = await resolve({'accept-encoding': 'gzip, deflate, br'})

        expect(response.headers['content-encoding']).toBe('br')
        expect(ndjson(brotliDecompressSync(response.rawPayload).toString())).toEqual(ndjson(plain.payload))
    })

    it('compresses a stream however small it is', async () => {
        // A stream's size is not known when its headers go, so the threshold cannot apply to it.
        const response = await app.inject({
            method: 'POST',
            url: '/resolve',
            headers: {...auth, 'accept-encoding': 'br'},
            payload: {purls: [], deadline_ms: 0},
        })

        expect(response.headers['content-encoding']).toBe('br')
        expect(ndjson(brotliDecompressSync(response.rawPayload).toString())).toEqual([
            {done: true, feeds: {npm: {mode: 'feed', lag_seconds: 30, cursor_time: '2026-09-16T09:59:00.000Z'}}},
        ])
    })

    it('does not bother with a /feeds answer under the threshold', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/feeds',
            headers: {...auth, 'accept-encoding': 'gzip, br'},
        })

        expect(response.rawPayload.length).toBeLessThan(COMPRESS_THRESHOLD_BYTES)
        expect(response.headers['content-encoding']).toBeUndefined()
    })
})

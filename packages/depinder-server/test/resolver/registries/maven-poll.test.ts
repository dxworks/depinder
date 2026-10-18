import {parsePurl} from '@depinder/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {resetLimiters} from '../../../src/resolver/registries/http.js'
import {mavenPoll} from '../../../src/resolver/registries/maven-poll.js'
import type {PollTarget} from '../../../src/resolver/registries/types.js'
import {coreFixture, feedContext, pollMode} from './feed.helpers.js'

const metadataXml = coreFixture('maven-guava-metadata.xml')
const feed = pollMode(mavenPoll)

const BASE = 'https://repo1.maven.org/maven2/com/google/guava/guava'
const GUAVA = 'pkg:maven/com.google.guava/guava'

interface Call {
    url: string
    init?: RequestInit
}

let calls: Call[]

function stubFetch(handler: (url: string) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({url, init})
        return Promise.resolve(handler(url))
    })
}

function body(text: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(status === 304 || status === 204 ? null : text, {status, headers})
}

function headersOf(call: Call | undefined): Record<string, string> {
    return (call?.init?.headers ?? {}) as Record<string, string>
}

const context = () => feedContext('maven')

/** When the package being polled was last fetched in full. */
const FETCHED_AT = new Date('2026-09-01T00:00:00Z')

function target(overrides: Partial<PollTarget> = {}): PollTarget {
    const key = parsePurl(GUAVA)
    return {packageKey: GUAVA, key, etag: null, lastModified: null, fetchedAt: FETCHED_AT, ...overrides}
}

beforeEach(() => {
    calls = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('maven poll feed', () => {
    it('is a poll-mode feed on a six-hour interval', () => {
        expect(feed.mode).toBe('poll')
        expect(feed.intervalMs).toBe(6 * 60 * 60 * 1000)
    })

    it('vouches for the fetch on a first check whose Last-Modified predates it', async () => {
        stubFetch(() =>
            body(metadataXml, 200, {etag: '"abc"', 'last-modified': 'Tue, 01 Aug 2023 21:21:56 GMT'}),
        )

        const result = await feed.check(target(), context())

        expect(calls[0]?.url).toBe(`${BASE}/maven-metadata.xml`)
        expect(headersOf(calls[0])['if-none-match']).toBeUndefined()
        // The metadata last changed long before the fetch, so the fetch saw this state: remember
        // how to ask next time, and let the package's as_of move up.
        expect(result).toEqual({
            changed: false,
            confirmed: true,
            etag: '"abc"',
            lastModified: 'Tue, 01 Aug 2023 21:21:56 GMT',
        })
    })

    it('requeues on a first check whose Last-Modified is newer than the fetch', async () => {
        stubFetch(() =>
            body(metadataXml, 200, {etag: '"abc"', 'last-modified': 'Tue, 01 Sep 2026 06:00:00 GMT'}),
        )

        const result = await feed.check(target(), context())

        // Published after we fetched: the validators are not stored, so the check after the
        // refetch is a first check again and compares against the new fetched_at.
        expect(result).toEqual({changed: true, confirmed: false})
    })

    it('sends both validators and vouches for the package on a 304', async () => {
        stubFetch(() => body('', 304))

        const result = await feed.check(
            target({etag: '"abc"', lastModified: 'Tue, 01 Aug 2023 21:21:56 GMT'}),
            context(),
        )

        expect(headersOf(calls[0])['if-none-match']).toBe('"abc"')
        expect(headersOf(calls[0])['if-modified-since']).toBe('Tue, 01 Aug 2023 21:21:56 GMT')
        // Nothing to store: omitting the fields keeps what the worker already has.
        expect(result).toEqual({changed: false, confirmed: true})
    })

    it('reports a change on a 200 and clears the validators instead of storing new ones', async () => {
        stubFetch(() =>
            body(metadataXml, 200, {etag: '"def"', 'last-modified': 'Fri, 01 Dec 2023 18:02:00 GMT'}),
        )

        const result = await feed.check(target({etag: '"abc"'}), context())

        // Stored now, they would outlive a refetch that fails, and the next 304 would vouch for
        // data that never saw the change.
        expect(result).toEqual({changed: true, confirmed: false, etag: null, lastModified: null})
    })

    it('neither stores validators for nor vouches for a row never fully fetched', async () => {
        stubFetch(() =>
            body(metadataXml, 200, {etag: '"abc"', 'last-modified': 'Tue, 01 Aug 2023 21:21:56 GMT'}),
        )

        const result = await feed.check(target({fetchedAt: null}), context())

        expect(result).toEqual({changed: false, confirmed: false, etag: null, lastModified: null})
    })

    it('leaves the package alone when the metadata 404s', async () => {
        stubFetch(() => body('gone', 404))
        expect(await feed.check(target({etag: '"abc"'}), context())).toEqual({
            changed: false,
            confirmed: false,
        })
    })

    it('throws on a 5xx so the sweep logs it', async () => {
        stubFetch(() => body('boom', 500))
        await expect(feed.check(target(), context())).rejects.toThrow(/500/)
    })
})

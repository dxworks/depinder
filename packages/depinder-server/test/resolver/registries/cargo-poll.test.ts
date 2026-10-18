import {parsePurl} from '@depinder/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cargoPoll, sparseIndexPath} from '../../../src/resolver/registries/cargo-poll.js'
import {resetLimiters} from '../../../src/resolver/registries/http.js'
import type {PollTarget} from '../../../src/resolver/registries/types.js'
import {feedContext, pollMode} from './feed.helpers.js'

const SERDE = 'pkg:cargo/serde'
const feed = pollMode(cargoPoll)

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

const context = () => feedContext('cargo')

/** When the crate being polled was last fetched in full. */
const FETCHED_AT = new Date('2026-09-01T00:00:00Z')

function target(overrides: Partial<PollTarget> = {}): PollTarget {
    return {
        packageKey: SERDE,
        key: parsePurl(SERDE),
        etag: null,
        lastModified: null,
        fetchedAt: FETCHED_AT,
        ...overrides,
    }
}

function headersOf(call: Call | undefined): Record<string, string> {
    return (call?.init?.headers ?? {}) as Record<string, string>
}

beforeEach(() => {
    calls = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('cargo sparse index paths', () => {
    const cases: [string, string][] = [
        ['a', '1/a'],
        ['id', '2/id'],
        ['log', '3/l/log'],
        ['serde', 'se/rd/serde'],
        ['rand', 'ra/nd/rand'],
        ['tokio-util', 'to/ki/tokio-util'],
        ['Inflector', 'in/fl/inflector'],
    ]

    it.each(cases)('%s -> %s', (name, path) => {
        expect(sparseIndexPath(name)).toBe(path)
    })
})

describe('cargo poll feed', () => {
    it('is a poll-mode feed on a six-hour interval', () => {
        expect(feed.mode).toBe('poll')
        expect(feed.intervalMs).toBe(6 * 60 * 60 * 1000)
    })

    it('vouches for the fetch on a first check whose Last-Modified predates it', async () => {
        stubFetch(() => body('{"name":"serde"}\n', 200, {etag: '"abc"', 'last-modified': 'Sat, 18 Jul 2026 23:05:14 GMT'}))

        const result = await feed.check(target(), context())

        expect(calls[0]?.url).toBe('https://index.crates.io/se/rd/serde')
        expect(headersOf(calls[0])['if-none-match']).toBeUndefined()
        expect(result).toEqual({
            changed: false,
            confirmed: true,
            etag: '"abc"',
            lastModified: 'Sat, 18 Jul 2026 23:05:14 GMT',
        })
    })

    it('requeues on a first check whose Last-Modified is newer than the fetch', async () => {
        stubFetch(() => body('{"name":"serde"}\n', 200, {etag: '"abc"', 'last-modified': 'Tue, 01 Sep 2026 06:00:00 GMT'}))

        expect(await feed.check(target(), context())).toEqual({changed: true, confirmed: false})
    })

    it('stores the validators but vouches for nothing when a first check has no Last-Modified', async () => {
        stubFetch(() => body('{"name":"serde"}\n', 200, {etag: '"abc"'}))

        expect(await feed.check(target(), context())).toEqual({
            changed: false,
            confirmed: false,
            etag: '"abc"',
            lastModified: null,
        })
    })

    it('sends If-None-Match and vouches for the package on a 304', async () => {
        stubFetch(() => body('', 304))

        const result = await feed.check(target({etag: '"abc"'}), context())

        expect(headersOf(calls[0])['if-none-match']).toBe('"abc"')
        expect(result).toEqual({changed: false, confirmed: true})
    })

    it('reports a change on a 200 and clears the validators', async () => {
        stubFetch(() => body('{"name":"serde"}\n', 200, {etag: '"def"'}))

        const result = await feed.check(target({etag: '"abc"'}), context())

        expect(result).toEqual({changed: true, confirmed: false, etag: null, lastModified: null})
    })

    it('does not vouch for a row never fully fetched on a 304', async () => {
        stubFetch(() => body('', 304))

        const result = await feed.check(target({etag: '"abc"', fetchedAt: null}), context())

        expect(result).toEqual({changed: false, confirmed: false})
    })

    it('leaves the package alone when the index does not have the crate', async () => {
        stubFetch(() => body('not found', 404))
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

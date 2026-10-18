import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {gemFeed, parseCompactIndex} from '../../../src/resolver/registries/gem-feed.js'
import {resetLimiters} from '../../../src/resolver/registries/http.js'
import {feedContext, feedFixture, feedMode, warningsLogger} from './feed.helpers.js'

const compactIndex = feedFixture('gem-compact-index.txt')
const feed = feedMode(gemFeed)

const INDEX_URL = 'https://rubygems.org/versions'

interface Call {
    url: string
    method: string
    headers: Record<string, string>
}

let calls: Call[]
let warnings: {msg: string; fields?: Record<string, unknown>}[]

function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL, init: RequestInit = {}) => {
        const url = String(input)
        calls.push({
            url,
            method: String(init.method ?? 'GET'),
            headers: (init.headers ?? {}) as Record<string, string>,
        })
        return Promise.resolve(handler(url, init))
    })
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(body, {status, headers: {'content-type': 'text/plain', ...headers}})
}

const context = () => feedContext('gem', warningsLogger(warnings))

beforeEach(() => {
    calls = []
    warnings = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('gem compact index parsing', () => {
    it('reads whole lines only and leaves a partial trailing line for the next poll', () => {
        const {consumedBytes, names} = parseCompactIndex(compactIndex)
        expect(names).toEqual(['rack-proxy', 'devise_masquerade', 'spec_ai'])
        expect(consumedBytes).toBe(Buffer.byteLength(compactIndex.slice(0, compactIndex.lastIndexOf('\n') + 1)))
        expect(consumedBytes).toBeLessThan(Buffer.byteLength(compactIndex))
    })

    it('consumes nothing when the slice has no line ending yet', () => {
        expect(parseCompactIndex('half-written-gem 0.0')).toEqual({consumedBytes: 0, names: []})
    })

    it('skips the compact index header', () => {
        const {names} = parseCompactIndex('created_at: 2026-09-01T00:00:04Z\n---\nrack 3.1.0 abc\n')
        expect(names).toEqual(['rack'])
    })
})

const WHOLE_LINES = Buffer.byteLength(compactIndex.slice(0, compactIndex.lastIndexOf('\n') + 1))

/** HEAD reports `size`; the ranged GET is whatever the test wants. */
function compactIndexOfSize(size: number, ranged: () => Response): (url: string, init: RequestInit) => Response {
    return (_url, init) => (String(init.method) === 'HEAD' ? text('', 200, {'content-length': String(size)}) : ranged())
}

describe('gem feed', () => {
    it('starts from the size of the compact index', async () => {
        stubFetch(() => text('', 200, {'content-length': '23388275'}))
        const cursor = await feed.initialCursor(context())

        expect(cursor).toBe('23388275')
        expect(calls[0]).toMatchObject({url: INDEX_URL, method: 'HEAD'})
    })

    it('falls back to a one-byte range request when HEAD reports no length', async () => {
        stubFetch((_url, init) =>
            String(init.method) === 'HEAD' ? text('', 200) : text('c', 206, {'content-range': 'bytes 0-0/23388275'}),
        )
        expect(await feed.initialCursor(context())).toBe('23388275')
        expect(calls[1]?.headers.range).toBe('bytes=0-0')
    })

    it('asks for the bytes appended since the cursor and advances by whole lines', async () => {
        const total = 1000 + Buffer.byteLength(compactIndex)
        stubFetch(compactIndexOfSize(total, () => text(compactIndex, 206)))
        const result = await feed.poll('1000', context())

        // A closed range: the open-ended form is what makes Fastly answer 200 with the whole file.
        expect(calls[1]?.headers.range).toBe(`bytes=1000-${total - 1}`)
        expect(result.events.map(e => e.packageKey)).toEqual([
            'pkg:gem/rack-proxy',
            'pkg:gem/devise_masquerade',
            'pkg:gem/spec_ai',
        ])
        expect(result.events.every(e => e.at === null)).toBe(true)
        expect(result.cursor).toBe(String(1000 + WHOLE_LINES))
        // Compact index lines carry no timestamp: freshness is "when we last looked".
        expect(result.cursorTime).toBeInstanceOf(Date)
        expect(result.headTime).toBeNull()
    })

    it('makes no range request at all when the cursor is already at the head', async () => {
        stubFetch(() => text('', 200, {'content-length': '23388275'}))
        const result = await feed.poll('23388275', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe('23388275')
        expect(result.cursorTime).toBeInstanceOf(Date)
        // The whole point: a quiet tick must not pull 23 MB. Only the HEAD went out.
        expect(calls).toHaveLength(1)
        expect(calls[0]?.method).toBe('HEAD')
    })

    it('still treats a 416 as "nothing new" for caches that send one', async () => {
        stubFetch(compactIndexOfSize(23388275, () => text('', 416, {'content-range': 'bytes */23388275'})))
        const result = await feed.poll('23388000', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe('23388000')
    })

    it('re-anchors when the index is shorter than the cursor', async () => {
        stubFetch(() => text('', 200, {'content-length': '1024'}))
        const result = await feed.poll('23388275', context())

        expect(result.cursor).toBe('1024')
        expect(result.events).toEqual([])
        expect(warnings[0]?.msg).toMatch(/shorter than the cursor/)
    })

    it('re-anchors at the head without events when the range is ignored', async () => {
        stubFetch(compactIndexOfSize(23388275, () => text(compactIndex, 200)))
        const result = await feed.poll('1000', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe(String(Buffer.byteLength(compactIndex)))
        expect(warnings[0]?.msg).toMatch(/rebuilt/)
    })

    it('throws when the compact index is unavailable', async () => {
        stubFetch(compactIndexOfSize(5000, () => text('nope', 503)))
        await expect(feed.poll('1', context())).rejects.toThrow(/503/)
    })

    it('throws when the size cannot be determined at all', async () => {
        stubFetch(() => text('nope', 503))
        await expect(feed.poll('1', context())).rejects.toThrow(/did not report the size/)
    })
})

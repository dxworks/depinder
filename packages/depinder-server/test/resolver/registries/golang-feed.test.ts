import {parsePurl} from '@depinder/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {golangFeed} from '../../../src/resolver/registries/golang-feed.js'
import {resetLimiters} from '../../../src/resolver/registries/http.js'
import {feedContext, feedFixture, feedMode} from './feed.helpers.js'

const indexDoc = feedFixture('golang-index.txt')
const feed = feedMode(golangFeed)

let calls: string[]

function stubFetch(handler: (url: string) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL) => {
        const url = String(input)
        calls.push(url)
        return Promise.resolve(handler(url))
    })
}

function text(body: string, status = 200): Response {
    return new Response(body, {status, headers: {'content-type': 'text/plain'}})
}

const context = () => feedContext('golang')

beforeEach(() => {
    calls = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('golang feed', () => {
    it('starts at the current time', async () => {
        const cursor = await feed.initialCursor(context())
        expect(cursor).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
        expect(Date.parse(cursor)).toBeLessThanOrEqual(Date.now())
    })

    it('parses the module index, deduplicates paths and advances to the last timestamp', async () => {
        stubFetch(() => text(indexDoc))
        const result = await feed.poll('2026-09-16T09:00:00Z', context())

        expect(calls[0]).toBe('https://index.golang.org/index?since=2026-09-16T09%3A00%3A00Z&limit=2000')
        expect(result.events.map(e => e.packageKey)).toEqual([
            'pkg:golang/github.com/gin-gonic/gin',
            'pkg:golang/github.com/Opentrons/OPENTRONS', // module paths are case-sensitive
            'pkg:golang/github.com/aliilapro/mtprotoproxy',
        ])
        // gin published twice in the batch; the newer timestamp is the one kept.
        expect(result.events[0]!.at?.toISOString()).toBe('2026-09-16T09:00:02.159Z')
        expect(result.cursor).toBe('2026-09-16T09:00:03.500000Z')
        expect(result.cursorTime?.toISOString()).toBe('2026-09-16T09:00:03.500Z')
        expect(result.headTime).toBeNull()
    })

    it('round-trips a feed path to the key /resolve would store', async () => {
        stubFetch(() => text(indexDoc))
        const result = await feed.poll('2026-09-16T09:00:00Z', context())
        expect(result.events[0]!.packageKey).toBe(parsePurl('pkg:golang/github.com/gin-gonic/gin').packageKey)
        expect(result.events[0]!.packageKey).toBe(parsePurl('pkg:golang/github.com/gin-gonic/gin@v1.10.0').packageKey)
    })

    it('keeps the cursor when the batch is empty', async () => {
        stubFetch(() => text(''))
        const result = await feed.poll('2026-09-16T09:00:00Z', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe('2026-09-16T09:00:00Z')
        expect(result.cursorTime).toBeNull()
    })

    it('throws when the index is unavailable', async () => {
        stubFetch(() => text('nope', 503))
        await expect(feed.poll('2026-09-16T09:00:00Z', context())).rejects.toThrow(/503/)
    })
})

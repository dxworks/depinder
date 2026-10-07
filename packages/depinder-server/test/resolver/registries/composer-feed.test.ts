import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {composerFeed} from '../../../src/resolver/registries/composer-feed.js'
import {resetLimiters} from '../../../src/resolver/registries/http.js'
import {feedContext, feedFixture, feedMode, warningsLogger} from './feed.helpers.js'

const changes = JSON.parse(feedFixture('composer-changes.json')) as unknown
const changesResync = JSON.parse(feedFixture('composer-changes-resync.json')) as unknown
const feed = feedMode(composerFeed)

let calls: {url: string}[]
let warnings: {msg: string; fields?: Record<string, unknown>}[]

function stubFetch(handler: (url: string) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL) => {
        const url = String(input)
        calls.push({url})
        return Promise.resolve(handler(url))
    })
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

const context = () => feedContext('composer', warningsLogger(warnings))

beforeEach(() => {
    calls = []
    warnings = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('composer feed', () => {
    it('asks for the last minute and keeps the timestamp packagist answers with', async () => {
        stubFetch(() => json(changes))

        const cursor = await feed.initialCursor(context())

        expect(cursor).toBe('17895544800011')
        const since = Number(/since=(\d+)$/.exec(calls[0]!.url)?.[1])
        // The cursor unit is unix seconds x 10 000, and the head is a minute back.
        const expected = (Math.floor(Date.now() / 1000) - 60) * 10_000
        expect(since).toBeGreaterThan(expected - 100_000)
        expect(since).toBeLessThanOrEqual(expected + 100_000)
    })

    it('strips ~dev, drops what is not a package name and advances to the reported timestamp', async () => {
        stubFetch(() => json(changes))

        const result = await feed.poll('17895544220000', context())

        expect(calls[0]?.url).toBe('https://packagist.org/metadata/changes.json?since=17895544220000')
        expect(result.events).toEqual([
            {packageKey: 'pkg:composer/atk4/audit', at: new Date(1789554422 * 1000)},
            // The package and its branches are one package: one event, the newer time.
            {packageKey: 'pkg:composer/monolog/monolog', at: new Date(1789554440 * 1000)},
            {packageKey: 'pkg:composer/raxon/boot', at: new Date(1789554432 * 1000)},
        ])
        expect(result.cursor).toBe('17895544800011')
        expect(result.cursorTime).toEqual(new Date(1789554450 * 1000))
        expect(result.headTime).toEqual(new Date(1789554480 * 1000))
    })

    it('refuses to crawl packagist when it asks for a resync', async () => {
        stubFetch(() => json(changesResync))

        const result = await feed.poll('17895544220000', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe('17895544800011')
        expect(warnings.map(w => w.msg)).toContain('packagist asked for a full resync; skipping this batch')
    })

    it('restarts from the head when the cursor is older than the window packagist keeps', async () => {
        stubFetch(() => json({error: 'Invalid or missing "since" query parameter', timestamp: 17895544800011}, 400))

        const result = await feed.poll('1', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe('17895544800011')
        expect(result.cursorTime).toBeNull()
        expect(warnings.map(w => w.msg)).toContain('packagist rejected the feed cursor, restarting from its head')
    })

    it('throws when packagist is down', async () => {
        stubFetch(() => json({}, 503))
        await expect(feed.poll('17895544220000', context())).rejects.toThrow(/503/)
    })
})

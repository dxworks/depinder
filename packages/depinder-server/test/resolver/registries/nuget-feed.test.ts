import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {resetLimiters} from '../../../src/resolver/registries/http.js'
import {nugetFeed} from '../../../src/resolver/registries/nuget-feed.js'
import {feedContext, feedFixture, feedMode} from './feed.helpers.js'

const catalogIndex = JSON.parse(feedFixture('nuget-catalog-index.json')) as unknown
const catalogPage = JSON.parse(feedFixture('nuget-catalog-page.json')) as unknown
const feed = feedMode(nugetFeed)

const CATALOG_URL = 'https://api.nuget.org/v3/catalog0/index.json'

let calls: {url: string}[]

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

const context = () => feedContext('nuget')

beforeEach(() => {
    calls = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('nuget feed', () => {
    it('starts from the catalog head commit', async () => {
        stubFetch(() => json(catalogIndex))

        const cursor = await feed.initialCursor(context())

        expect(cursor).toBe('2026-09-16T10:26:20.8736413Z')
        expect(calls[0]?.url).toBe(CATALOG_URL)
    })

    it('reads the pages committed after the cursor and emits one event per id', async () => {
        stubFetch(url => {
            if (url === CATALOG_URL) return json(catalogIndex)
            if (url.endsWith('page23120.json')) return json(catalogPage)
            return json({items: []})
        })

        const result = await feed.poll('2026-09-16T09:00:00.0000000Z', context())

        // page23119 committed before the cursor is not read; the other two are, oldest first.
        expect(calls.map(c => c.url)).toEqual([
            CATALOG_URL,
            'https://api.nuget.org/v3/catalog0/page23120.json',
            'https://api.nuget.org/v3/catalog0/page23121.json',
        ])
        // `Newtonsoft.Json` and `newtonsoft.json` are one package; `OldThing` sits exactly on the
        // cursor and was already consumed.
        expect(result.events).toEqual([
            {packageKey: 'pkg:nuget/newtonsoft.json', at: new Date('2026-09-16T09:46:18.726Z')},
            {packageKey: 'pkg:nuget/serilog', at: new Date('2026-09-16T09:46:18.726Z')},
        ])
        expect(result.cursor).toBe('2026-09-16T09:46:18.7265363Z')
        expect(result.cursorTime).toEqual(new Date('2026-09-16T09:46:18.726Z'))
        expect(result.headTime).toEqual(new Date('2026-09-16T10:26:20.873Z'))
    })

    it('leaves the cursor alone when no page is newer than it', async () => {
        stubFetch(() => json(catalogIndex))
        const result = await feed.poll('2026-09-16T10:26:20.8736413Z', context())

        expect(calls).toHaveLength(1)
        expect(result.events).toEqual([])
        expect(result.cursor).toBe('2026-09-16T10:26:20.8736413Z')
        expect(result.cursorTime).toBeNull()
        // An empty batch still reports how fresh upstream is.
        expect(result.headTime).toEqual(new Date('2026-09-16T10:26:20.873Z'))
    })

    it('caps a backlog at twenty pages per poll and resumes from where it stopped', async () => {
        const items = Array.from({length: 25}, (_, i) => ({
            '@id': `https://api.nuget.org/v3/catalog0/page${i}.json`,
            commitTimeStamp: `2026-09-10T00:${String(i).padStart(2, '0')}:00.0000000Z`,
        }))
        stubFetch(url => {
            if (url === CATALOG_URL) return json({commitTimeStamp: '2026-09-10T00:24:00.0000000Z', items})
            const page = Number(/page(\d+)\.json/.exec(url)?.[1] ?? -1)
            return json({items: [{commitTimeStamp: items[page]!.commitTimeStamp, 'nuget:id': `Pkg.${page}`}]})
        })

        const result = await feed.poll('2026-09-10T00:00:00.0000000Z', context())

        // 24 pages are due (page0 sits on the cursor); 20 of them are read this tick and the
        // cursor stops there, so the next tick picks the remaining four up.
        expect(calls).toHaveLength(21)
        expect(result.events).toHaveLength(20)
        expect(result.events[0]!.packageKey).toBe('pkg:nuget/pkg.1')
        expect(result.cursor).toBe('2026-09-10T00:20:00.0000000Z')
        expect(result.headTime).toEqual(new Date('2026-09-10T00:24:00.000Z'))
    })

    it('throws when the catalog is unavailable', async () => {
        stubFetch(() => json({}, 503))
        await expect(feed.poll('2026-09-16T09:00:00.0000000Z', context())).rejects.toThrow(/503/)
    })
})

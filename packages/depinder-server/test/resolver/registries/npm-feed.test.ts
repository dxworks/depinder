import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {resetLimiters} from '../../../src/resolver/registries/http.js'
import {npmFeed} from '../../../src/resolver/registries/npm-feed.js'
import {feedContext, feedFixture, feedMode} from './feed.helpers.js'

const changes = JSON.parse(feedFixture('npm-changes.json')) as unknown
const feed = feedMode(npmFeed)

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

const context = () => feedContext('npm')

beforeEach(() => {
    calls = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('npm feed', () => {
    it('starts from the head sequence', async () => {
        stubFetch(() => json({results: [], last_seq: 31000000}))

        const cursor = await feed.initialCursor(context())

        expect(cursor).toBe('31000000')
        expect(calls[0]?.url).toBe('https://replicate.npmjs.com/_changes?since=0&limit=1&descending=true')
    })

    it('turns change rows into package keys and advances the cursor', async () => {
        stubFetch(() => json(changes))

        const result = await feed.poll('31000000', context())

        expect(calls[0]?.url).toBe('https://replicate.npmjs.com/_changes?since=31000000&limit=1000')
        expect(result.events.map(e => e.packageKey)).toEqual([
            'pkg:npm/express',
            'pkg:npm/@babel/core',
            'pkg:npm/left-pad', // canonicalised
        ])
        expect(result.events.every(e => e.at === null)).toBe(true)
        expect(result.cursor).toBe('31000004')
        // npm change rows carry no timestamp, so freshness is "when we last read the feed".
        expect(result.cursorTime).toBeInstanceOf(Date)
        expect(result.headTime).toBeNull()
    })

    it('throws when the feed is unavailable', async () => {
        stubFetch(() => json({error: 'nope'}, 503))
        await expect(feed.poll('1', context())).rejects.toThrow(/503/)
    })
})

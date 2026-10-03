import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createHttpClient, resetLimiters, type FetchRecord} from '../../../src/resolver/registries/http.js'
import {nullLogger} from '../../../src/shared/log.js'
import {parsePurl} from '../../../src/shared/purl.js'
import {npmRegistry, packageFromPackument} from '../../../src/resolver/registries/npm.js'
import type {FetchContext} from '../../../src/resolver/registries/types.js'

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8'))

const express = fixture('npm-express') as Record<string, unknown>
const changes = fixture('npm-changes')

interface Call {
    url: string
    init?: RequestInit
}

let calls: Call[]
let records: FetchRecord[]

function stubFetch(handler: (url: string) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({url, init})
        return Promise.resolve(handler(url))
    })
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

function context(): FetchContext {
    return {
        http: createHttpClient({type: 'npm', recorder: record => records.push(record)}),
        log: nullLogger,
        options: {mavenPerVersionLicenses: false},
    }
}

beforeEach(() => {
    calls = []
    records = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('npm fetchPackage', () => {
    it('reads the packument and normalises it', async () => {
        stubFetch(() => json(express))
        const result = await npmRegistry.fetchPackage(parsePurl('pkg:npm/express'), context())

        expect(calls[0]?.url).toBe('https://registry.npmjs.org/express')
        expect(result).not.toBeNull()
        expect(result!.description).toBe('Fast, unopinionated, minimalist web framework')
        expect(result!.homepageUrl).toBe('http://expressjs.com/')
        expect(result!.repoUrl).toBe('https://github.com/expressjs/express')
        expect(result!.licenses).toEqual(['MIT'])
        expect(result!.registryLatest).toBe('4.18.2')
        expect(result!.sources).toEqual(['registry.npmjs.org'])
        expect(result!.versions).toHaveLength(5)
    })

    it('understands all three license spellings and falls back to the package license', async () => {
        stubFetch(() => json(express))
        const result = await npmRegistry.fetchPackage(parsePurl('pkg:npm/express'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('0.14.0')!.licenses).toEqual(['MIT']) // legacy licenses[{type}]
        expect(byVersion.get('4.17.1')!.licenses).toEqual(['MIT']) // license: {type}
        expect(byVersion.get('4.18.2')!.licenses).toEqual(['MIT']) // license: "MIT"
        expect(byVersion.get('4.19.0')!.licenses).toEqual(['MIT']) // nothing of its own
    })

    it('dates versions from `time` and flags pre-releases', async () => {
        stubFetch(() => json(express))
        const result = await npmRegistry.fetchPackage(parsePurl('pkg:npm/express'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('4.18.2')!.releasedAt?.toISOString()).toBe('2022-10-08T20:46:50.089Z')
        expect(byVersion.get('5.0.0-alpha.8')!.prerelease).toBe(true)
        expect(byVersion.get('4.18.2')!.prerelease).toBe(false)
        // `deprecated` is a warning, not a withdrawal.
        expect(byVersion.get('5.0.0-alpha.8')!.yanked).toBe(false)
    })

    it('url-encodes the slash of a scoped name', async () => {
        stubFetch(() => json({name: '@babel/core', versions: {}, time: {}}))
        await npmRegistry.fetchPackage(parsePurl('pkg:npm/@babel/core'), context())
        expect(calls[0]?.url).toBe('https://registry.npmjs.org/@babel%2Fcore')
    })

    it('sends the identifying user agent', async () => {
        stubFetch(() => json(express))
        await npmRegistry.fetchPackage(parsePurl('pkg:npm/express'), context())
        const headers = calls[0]?.init?.headers as Record<string, string>
        expect(headers['user-agent']).toMatch(/^depinder-server-side\//)
    })

    it('returns null on 404', async () => {
        stubFetch(() => json({error: 'Not found'}, 404))
        expect(await npmRegistry.fetchPackage(parsePurl('pkg:npm/no-such-package-here'), context())).toBeNull()
    })

    it('throws on 500 so the queue retries', async () => {
        stubFetch(() => json({error: 'boom'}, 500))
        await expect(npmRegistry.fetchPackage(parsePurl('pkg:npm/express'), context())).rejects.toThrow(/500/)
    })

    it('records every request for fetch_log', async () => {
        stubFetch(() => json(express))
        await npmRegistry.fetchPackage(parsePurl('pkg:npm/express'), context())
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({source: 'registry.npmjs.org', status: 200, error: null})
        expect(records[0]!.finishedAt.getTime()).toBeGreaterThanOrEqual(records[0]!.startedAt.getTime())
    })

    it('falls back to a version license when the package declares none', () => {
        const doc = {...express}
        delete doc.license
        const result = packageFromPackument(doc)
        expect(result.licenses).toEqual(['MIT'])
    })
})

describe('npm feed', () => {
    it('starts from the head sequence', async () => {
        if (npmRegistry.feed.mode !== 'feed') throw new Error('npm should be a feed-mode registry')
        stubFetch(() => json({results: [], last_seq: 31000000}))

        const cursor = await npmRegistry.feed.initialCursor(context())

        expect(cursor).toBe('31000000')
        expect(calls[0]?.url).toBe('https://replicate.npmjs.com/_changes?since=0&limit=1&descending=true')
    })

    it('turns change rows into package keys and advances the cursor', async () => {
        if (npmRegistry.feed.mode !== 'feed') throw new Error('npm should be a feed-mode registry')
        stubFetch(() => json(changes))

        const result = await npmRegistry.feed.poll('31000000', context())

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
        if (npmRegistry.feed.mode !== 'feed') throw new Error('npm should be a feed-mode registry')
        stubFetch(() => json({error: 'nope'}, 503))
        await expect(npmRegistry.feed.poll('1', context())).rejects.toThrow(/503/)
    })
})

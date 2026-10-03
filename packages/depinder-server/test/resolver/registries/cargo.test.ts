import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createHttpClient, resetLimiters, type FetchRecord} from '../../../src/resolver/registries/http.js'
import {computeLatest} from '../../../src/resolver/registries/latest.js'
import {nullLogger} from '../../../src/shared/log.js'
import {parsePurl} from '../../../src/shared/purl.js'
import {cargoRegistry, packageFromCrate, sparseIndexPath} from '../../../src/resolver/registries/cargo.js'
import type {FetchContext, PollTarget} from '../../../src/resolver/registries/types.js'

const serde = JSON.parse(readFileSync(new URL('../../fixtures/cargo-serde.json', import.meta.url), 'utf8'))

const SERDE = 'pkg:cargo/serde'

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

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}})
}

function body(text: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(status === 304 || status === 204 ? null : text, {status, headers})
}

function context(): FetchContext {
    return {
        http: createHttpClient({type: 'cargo', recorder: record => records.push(record)}),
        log: nullLogger,
        options: {mavenPerVersionLicenses: false},
    }
}

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
    records = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('cargo fetchPackage', () => {
    it('reads the crate in one request and normalises it', async () => {
        stubFetch(() => json(serde))
        const result = await cargoRegistry.fetchPackage(parsePurl(SERDE), context())

        expect(calls.map(c => c.url)).toEqual(['https://crates.io/api/v1/crates/serde'])
        expect(result).not.toBeNull()
        expect(result!.description).toBe('A generic serialization/deserialization framework')
        expect(result!.homepageUrl).toBe('https://serde.rs')
        expect(result!.repoUrl).toBe('https://github.com/serde-rs/serde')
        expect(result!.licenses).toEqual(['MIT OR Apache-2.0'])
        expect(result!.registryLatest).toBe('1.0.229')
        expect(result!.sources).toEqual(['crates.io'])
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({source: 'crates.io', status: 200, error: null})
    })

    it('lists versions oldest first, dated from created_at', async () => {
        stubFetch(() => json(serde))
        const result = await cargoRegistry.fetchPackage(parsePurl(SERDE), context())

        // crates.io answers newest first; `latest.ts` documents its tie-break on an oldest-first list.
        expect(result!.versions.map(v => v.version)).toEqual([
            '0.8.23',
            '0.9.0-rc1',
            '1.0.95',
            '1.0.172-alpha.0',
            '1.0.229',
        ])
        expect(result!.versions[4]!.releasedAt?.toISOString()).toBe('2026-07-18T23:05:13.266Z')
    })

    it('carries yanked and pre-release flags through', async () => {
        stubFetch(() => json(serde))
        const result = await cargoRegistry.fetchPackage(parsePurl(SERDE), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('1.0.95')!.yanked).toBe(true)
        expect(byVersion.get('1.0.229')!.yanked).toBe(false)
        expect(byVersion.get('0.9.0-rc1')!.prerelease).toBe(true)
        expect(byVersion.get('1.0.172-alpha.0')!.prerelease).toBe(true)
        expect(byVersion.get('1.0.229')!.prerelease).toBe(false)
        expect(byVersion.get('0.8.23')!.prerelease).toBe(false)
    })

    it('keeps an SPDX expression whole, in both crates.io spellings', async () => {
        stubFetch(() => json(serde))
        const result = await cargoRegistry.fetchPackage(parsePurl(SERDE), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('1.0.229')!.licenses).toEqual(['MIT OR Apache-2.0'])
        // The pre-2018 spelling of the same thing. Splitting either would claim the crate is under
        // both licenses at once, which an `OR` says it is not.
        expect(byVersion.get('0.8.23')!.licenses).toEqual(['MIT/Apache-2.0'])
    })

    it('leaves a version with no license empty', () => {
        const result = packageFromCrate({
            crate: {max_stable_version: '1.0.0'},
            versions: [{num: '1.0.0', created_at: '2024-01-01T00:00:00Z', license: null, yanked: false}],
        })
        expect(result.versions[0]!.licenses).toEqual([])
        expect(result.licenses).toEqual([])
    })

    it('takes the crate licenses from the designated version, then from the newest usable one', () => {
        const versions = [
            {num: '1.0.0', created_at: '2024-01-01T00:00:00Z', license: 'MIT', yanked: false},
            {num: '2.0.0', created_at: '2024-06-01T00:00:00Z', license: 'Apache-2.0', yanked: true},
        ]
        expect(packageFromCrate({crate: {max_stable_version: '1.0.0'}, versions}).licenses).toEqual(['MIT'])
        // No designation and the newest is yanked: the newest version anybody can still install.
        expect(packageFromCrate({crate: {}, versions}).licenses).toEqual(['MIT'])
    })

    it('falls back to newest_version when there is no stable release', () => {
        const result = packageFromCrate({
            crate: {newest_version: '0.1.0-beta.1'},
            versions: [{num: '0.1.0-beta.1', created_at: '2024-01-01T00:00:00Z', license: 'MIT', yanked: false}],
        })
        expect(result.registryLatest).toBe('0.1.0-beta.1')
    })

    it('uses the repository as the homepage when the crate declares none', () => {
        const result = packageFromCrate({crate: {repository: 'https://github.com/x/y.git'}, versions: []})
        expect(result.homepageUrl).toBe('https://github.com/x/y')
        expect(result.repoUrl).toBe('https://github.com/x/y')
    })

    it('hands latest.ts a list it designates correctly', async () => {
        stubFetch(() => json(serde))
        const result = await cargoRegistry.fetchPackage(parsePurl(SERDE), context())
        const latest = computeLatest('cargo', result!.versions, result!.registryLatest)

        expect(latest.latest).toBe('1.0.229')
        expect(latest.latestPrerelease).toBeUndefined()
    })

    it('url-encodes an awkward crate name', async () => {
        stubFetch(() => json({crate: {}, versions: []}))
        await cargoRegistry.fetchPackage(parsePurl('pkg:cargo/foo%20bar'), context())
        expect(calls[0]?.url).toBe('https://crates.io/api/v1/crates/foo%20bar')
    })

    it('returns null on 404', async () => {
        stubFetch(() => json({errors: [{detail: 'Not Found'}]}, 404))
        expect(await cargoRegistry.fetchPackage(parsePurl('pkg:cargo/no-such-crate-here'), context())).toBeNull()
    })

    it('throws on a 5xx so the queue retries', async () => {
        stubFetch(() => json({errors: []}, 502))
        await expect(cargoRegistry.fetchPackage(parsePurl(SERDE), context())).rejects.toThrow(/502/)
    })

    it('sends the identifying user agent crates.io asks for', async () => {
        stubFetch(() => json(serde))
        await cargoRegistry.fetchPackage(parsePurl(SERDE), context())
        expect(headersOf(calls[0])['user-agent']).toMatch(/^depinder-server-side\//)
    })
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
        expect(cargoRegistry.feed.mode).toBe('poll')
        expect(cargoRegistry.feed.intervalMs).toBe(6 * 60 * 60 * 1000)
    })

    it('vouches for the fetch on a first check whose Last-Modified predates it', async () => {
        if (cargoRegistry.feed.mode !== 'poll') throw new Error('cargo should be a poll-mode registry')
        stubFetch(() => body('{"name":"serde"}\n', 200, {etag: '"abc"', 'last-modified': 'Sat, 18 Jul 2026 23:05:14 GMT'}))

        const result = await cargoRegistry.feed.check(target(), context())

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
        if (cargoRegistry.feed.mode !== 'poll') throw new Error('cargo should be a poll-mode registry')
        stubFetch(() => body('{"name":"serde"}\n', 200, {etag: '"abc"', 'last-modified': 'Tue, 01 Sep 2026 06:00:00 GMT'}))

        expect(await cargoRegistry.feed.check(target(), context())).toEqual({changed: true, confirmed: false})
    })

    it('stores the validators but vouches for nothing when a first check has no Last-Modified', async () => {
        if (cargoRegistry.feed.mode !== 'poll') throw new Error('cargo should be a poll-mode registry')
        stubFetch(() => body('{"name":"serde"}\n', 200, {etag: '"abc"'}))

        expect(await cargoRegistry.feed.check(target(), context())).toEqual({
            changed: false,
            confirmed: false,
            etag: '"abc"',
            lastModified: null,
        })
    })

    it('sends If-None-Match and vouches for the package on a 304', async () => {
        if (cargoRegistry.feed.mode !== 'poll') throw new Error('cargo should be a poll-mode registry')
        stubFetch(() => body('', 304))

        const result = await cargoRegistry.feed.check(target({etag: '"abc"'}), context())

        expect(headersOf(calls[0])['if-none-match']).toBe('"abc"')
        expect(result).toEqual({changed: false, confirmed: true})
    })

    it('reports a change on a 200 and clears the validators', async () => {
        if (cargoRegistry.feed.mode !== 'poll') throw new Error('cargo should be a poll-mode registry')
        stubFetch(() => body('{"name":"serde"}\n', 200, {etag: '"def"'}))

        const result = await cargoRegistry.feed.check(target({etag: '"abc"'}), context())

        expect(result).toEqual({changed: true, confirmed: false, etag: null, lastModified: null})
    })

    it('does not vouch for a row never fully fetched on a 304', async () => {
        if (cargoRegistry.feed.mode !== 'poll') throw new Error('cargo should be a poll-mode registry')
        stubFetch(() => body('', 304))

        const result = await cargoRegistry.feed.check(target({etag: '"abc"', fetchedAt: null}), context())

        expect(result).toEqual({changed: false, confirmed: false})
    })

    it('leaves the package alone when the index does not have the crate', async () => {
        if (cargoRegistry.feed.mode !== 'poll') throw new Error('cargo should be a poll-mode registry')
        stubFetch(() => body('not found', 404))
        expect(await cargoRegistry.feed.check(target({etag: '"abc"'}), context())).toEqual({
            changed: false,
            confirmed: false,
        })
    })

    it('throws on a 5xx so the sweep logs it', async () => {
        if (cargoRegistry.feed.mode !== 'poll') throw new Error('cargo should be a poll-mode registry')
        stubFetch(() => body('boom', 500))
        await expect(cargoRegistry.feed.check(target(), context())).rejects.toThrow(/500/)
    })
})

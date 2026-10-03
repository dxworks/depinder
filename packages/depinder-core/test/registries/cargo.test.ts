import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DEFAULT_USER_AGENT} from '../../src/http/client.js'
import {parsePurl} from '../../src/purl.js'
import {cargoFetcher, packageFromCrate} from '../../src/registries/cargo.js'
import {computeLatest} from '../../src/registries/latest.js'
import {fixtureJson, testContext, type SeenRequest} from './registry.helpers.js'

const serde = fixtureJson('cargo-serde')

const SERDE = 'pkg:cargo/serde'

interface Call {
    url: string
    init?: RequestInit
}

let calls: Call[]
let records: SeenRequest[]

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

function headersOf(call: Call | undefined): Record<string, string> {
    return (call?.init?.headers ?? {}) as Record<string, string>
}

const context = () => testContext(records)

beforeEach(() => {
    calls = []
    records = []
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('cargo fetchPackage', () => {
    it('reads the crate in one request and normalises it', async () => {
        stubFetch(() => json(serde))
        const result = await cargoFetcher.fetchPackage(parsePurl(SERDE), context())

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
        const result = await cargoFetcher.fetchPackage(parsePurl(SERDE), context())

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
        const result = await cargoFetcher.fetchPackage(parsePurl(SERDE), context())
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
        const result = await cargoFetcher.fetchPackage(parsePurl(SERDE), context())
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
        const result = await cargoFetcher.fetchPackage(parsePurl(SERDE), context())
        const latest = computeLatest('cargo', result!.versions, result!.registryLatest)

        expect(latest.latest).toBe('1.0.229')
        expect(latest.latestPrerelease).toBeUndefined()
    })

    it('url-encodes an awkward crate name', async () => {
        stubFetch(() => json({crate: {}, versions: []}))
        await cargoFetcher.fetchPackage(parsePurl('pkg:cargo/foo%20bar'), context())
        expect(calls[0]?.url).toBe('https://crates.io/api/v1/crates/foo%20bar')
    })

    it('returns null on 404', async () => {
        stubFetch(() => json({errors: [{detail: 'Not Found'}]}, 404))
        expect(await cargoFetcher.fetchPackage(parsePurl('pkg:cargo/no-such-crate-here'), context())).toBeNull()
    })

    it('throws on a 5xx so the queue retries', async () => {
        stubFetch(() => json({errors: []}, 502))
        await expect(cargoFetcher.fetchPackage(parsePurl(SERDE), context())).rejects.toThrow(/502/)
    })

    it('sends the identifying user agent crates.io asks for', async () => {
        stubFetch(() => json(serde))
        await cargoFetcher.fetchPackage(parsePurl(SERDE), context())
        expect(headersOf(calls[0])['user-agent']).toBe(DEFAULT_USER_AGENT)
    })
})

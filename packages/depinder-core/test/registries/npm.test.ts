import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {parsePurl} from '../../src/purl.js'
import {npmFetcher, packageFromPackument} from '../../src/registries/npm.js'
import {fixtureJson, testContext, type SeenRequest} from './registry.helpers.js'

const express = fixtureJson('npm-express')

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

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

const context = () => testContext(records)

beforeEach(() => {
    calls = []
    records = []
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('npm fetchPackage', () => {
    it('reads the packument and normalises it', async () => {
        stubFetch(() => json(express))
        const result = await npmFetcher.fetchPackage(parsePurl('pkg:npm/express'), context())

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
        const result = await npmFetcher.fetchPackage(parsePurl('pkg:npm/express'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('0.14.0')!.licenses).toEqual(['MIT']) // legacy licenses[{type}]
        expect(byVersion.get('4.17.1')!.licenses).toEqual(['MIT']) // license: {type}
        expect(byVersion.get('4.18.2')!.licenses).toEqual(['MIT']) // license: "MIT"
        expect(byVersion.get('4.19.0')!.licenses).toEqual(['MIT']) // nothing of its own
    })

    it('dates versions from `time` and flags pre-releases', async () => {
        stubFetch(() => json(express))
        const result = await npmFetcher.fetchPackage(parsePurl('pkg:npm/express'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('4.18.2')!.releasedAt?.toISOString()).toBe('2022-10-08T20:46:50.089Z')
        expect(byVersion.get('5.0.0-alpha.8')!.prerelease).toBe(true)
        expect(byVersion.get('4.18.2')!.prerelease).toBe(false)
        // `deprecated` is a warning, not a withdrawal.
        expect(byVersion.get('5.0.0-alpha.8')!.yanked).toBe(false)
    })

    it('url-encodes the slash of a scoped name', async () => {
        stubFetch(() => json({name: '@babel/core', versions: {}, time: {}}))
        await npmFetcher.fetchPackage(parsePurl('pkg:npm/@babel/core'), context())
        expect(calls[0]?.url).toBe('https://registry.npmjs.org/@babel%2Fcore')
    })

    it('sends the identifying user agent', async () => {
        stubFetch(() => json(express))
        await npmFetcher.fetchPackage(parsePurl('pkg:npm/express'), context())
        const headers = calls[0]?.init?.headers as Record<string, string>
        expect(headers['user-agent']).toMatch(/^depinder /)
    })

    it('returns null on 404', async () => {
        stubFetch(() => json({error: 'Not found'}, 404))
        expect(await npmFetcher.fetchPackage(parsePurl('pkg:npm/no-such-package-here'), context())).toBeNull()
    })

    it('throws on 500 so the queue retries', async () => {
        stubFetch(() => json({error: 'boom'}, 500))
        await expect(npmFetcher.fetchPackage(parsePurl('pkg:npm/express'), context())).rejects.toThrow(/500/)
    })

    it('reports every request it makes', async () => {
        stubFetch(() => json(express))
        await npmFetcher.fetchPackage(parsePurl('pkg:npm/express'), context())
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

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {parsePurl} from '../../src/purl.js'
import {gemFetcher} from '../../src/registries/gem.js'
import {fixtureJson, testContext, type SeenRequest} from './registry.helpers.js'

const versionsDoc = fixtureJson<Record<string, unknown>[]>('gem-versions')
const gemDoc = fixtureJson('gem-gem')

const VERSIONS_URL = 'https://rubygems.org/api/v1/versions/rack-proxy.json'
const GEM_URL = 'https://rubygems.org/api/v1/gems/rack-proxy.json'

let calls: {url: string}[]
let records: SeenRequest[]

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

/** The happy-path two-request answer: version list, then gem document. */
function rubygems(url: string): Response {
    if (url === VERSIONS_URL) return json(versionsDoc)
    if (url === GEM_URL) return json(gemDoc)
    throw new Error(`unexpected url ${url}`)
}

const context = () => testContext(records)

beforeEach(() => {
    calls = []
    records = []
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('gem fetchPackage', () => {
    it('reads both documents and normalises them', async () => {
        stubFetch(rubygems)
        const result = await gemFetcher.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())

        expect(calls.map(c => c.url)).toEqual([VERSIONS_URL, GEM_URL])
        expect(result).not.toBeNull()
        expect(result!.description).toBe('A request/response rewriting HTTP proxy. A Rack app.')
        expect(result!.homepageUrl).toBe('https://github.com/ncr/rack-proxy')
        // `source_code_uri` is null at the top level, so the one under `metadata` is used, and
        // `git+…/rack-proxy.git` is normalised to a browsable URL.
        expect(result!.repoUrl).toBe('https://github.com/ncr/rack-proxy')
        expect(result!.licenses).toEqual(['MIT'])
        expect(result!.registryLatest).toBe('1.4.0')
        expect(result!.sources).toEqual(['rubygems.org'])
    })

    it('maps versions, dates, licenses and the registry pre-release flag', async () => {
        stubFetch(rubygems)
        const result = await gemFetcher.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('1.4.0')!.releasedAt?.toISOString()).toBe('2024-03-04T09:11:00.000Z')
        expect(byVersion.get('1.3.0')!.licenses).toEqual(['MIT', 'Apache-2.0'])
        // `licenses: null` is how rubygems spells "the gemspec declared none".
        expect(byVersion.get('1.2.0')!.licenses).toEqual([])
        // `2.0.0.beta1` is not semver; rubygems' own flag is what catches it.
        expect(byVersion.get('2.0.0.beta1')!.prerelease).toBe(true)
        expect(byVersion.get('1.4.0')!.prerelease).toBe(false)
        // A yanked version is absent from versions.json; there is nothing here to mark.
        expect(result!.versions.every(v => v.yanked === false)).toBe(true)
    })

    it('emits each version number once, preferring the ruby platform build', async () => {
        stubFetch(rubygems)
        const result = await gemFetcher.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())

        expect(result!.versions.map(v => v.version)).toEqual(['2.0.0.beta1', '1.4.0', '1.3.0', '1.2.0'])
        // 1.4.0 ships for ruby, x86_64-linux and java: the ruby build's timestamp wins.
        expect(result!.versions.filter(v => v.version === '1.4.0')).toHaveLength(1)
        // 1.3.0 has no ruby build at all, so the first platform entry stands in for it.
        const v13 = result!.versions.find(v => v.version === '1.3.0')!
        expect(v13.releasedAt?.toISOString()).toBe('2023-11-20T08:00:00.000Z')
    })

    it('falls back to the current version licenses when the gem declares none', async () => {
        stubFetch(url => (url === VERSIONS_URL ? json(versionsDoc) : json({...gemDoc, licenses: null})))
        const result = await gemFetcher.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())
        expect(result!.licenses).toEqual(['MIT'])
    })

    it('continues without the gem document when only that one 404s', async () => {
        stubFetch(url => (url === VERSIONS_URL ? json(versionsDoc) : json({error: 'not found'}, 404)))
        const result = await gemFetcher.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())

        expect(result).not.toBeNull()
        expect(result!.versions).toHaveLength(4)
        expect(result!.registryLatest).toBeUndefined()
        expect(result!.licenses).toEqual([])
    })

    it('returns null when the gem does not exist', async () => {
        stubFetch(() => json({error: 'This rubygem could not be found.'}, 404))
        expect(await gemFetcher.fetchPackage(parsePurl('pkg:gem/no-such-gem-xyzzy'), context())).toBeNull()
        expect(calls).toHaveLength(1) // no point asking for the gem document
    })

    it('throws on 500 so the queue retries', async () => {
        stubFetch(() => json({error: 'boom'}, 500))
        await expect(gemFetcher.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())).rejects.toThrow(/500/)
    })

    it('reports every request it makes', async () => {
        stubFetch(rubygems)
        await gemFetcher.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())
        expect(records).toHaveLength(2)
        expect(records[0]).toMatchObject({source: 'rubygems.org', status: 200, error: null})
    })
})

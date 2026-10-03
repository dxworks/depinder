import {afterEach, describe, expect, it, vi} from 'vitest'
import {canFetch, fetchPackage} from '../src/fetch-package.js'
import {SUPPORTED_TYPES, parsePurl} from '../src/purl.js'
import {fixtureJson, testContext} from './registries/registry.helpers.js'

afterEach(() => vi.unstubAllGlobals())

function answer(body: unknown, status = 200): void {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(body), {status})))
}

describe('fetchPackage', () => {
    it('hands back the fetched facts with the latest rule applied', async () => {
        answer(fixtureJson('npm-express'))
        const pkg = await fetchPackage(parsePurl('pkg:npm/express'), testContext([]))

        expect(pkg!.registryLatest).toBe('4.18.2')
        expect(pkg!.latest).toBe('4.18.2')
        expect(pkg!.latestPrerelease).toBe('4.19.0')
        expect(pkg!.versions).toHaveLength(5)
    })

    it('applies the rule even where the registry names no latest', async () => {
        answer({packages: {'acme/lib': [{version: 'v2.0.0'}, {version: 'v10.0.0'}, {version: 'dev-main'}]}})
        const pkg = await fetchPackage(parsePurl('pkg:composer/acme/lib'), testContext([]))

        expect(pkg!.registryLatest).toBeUndefined()
        expect(pkg!.latest).toBe('v10.0.0')
    })

    it('passes a "no such package" through as null', async () => {
        answer({error: 'Not found'}, 404)
        expect(await fetchPackage(parsePurl('pkg:npm/no-such-package'), testContext([]))).toBeNull()
    })

    it('refuses a purl type it has no fetcher for', async () => {
        expect(canFetch('swift')).toBe(false)
        await expect(fetchPackage(parsePurl('pkg:swift/github.com/a/b'), testContext([]))).rejects.toThrow(
            'no registry implemented for type "swift"',
        )
    })

    it('has a fetcher for every supported purl type', () => {
        expect(SUPPORTED_TYPES.filter(type => !canFetch(type))).toEqual([])
    })
})

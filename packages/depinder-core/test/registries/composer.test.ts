import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {parsePurl} from '../../src/purl.js'
import {composerFetcher, expandMinified, packageFromMetadata} from '../../src/registries/composer.js'
import {computeLatest} from '../../src/registries/latest.js'
import {fixtureJson, testContext, type SeenRequest} from './registry.helpers.js'

const fixture = (name: string) => fixtureJson(name)

const monolog = fixture('composer-monolog')
const monologDev = fixture('composer-monolog-dev')

const MAIN_URL = 'https://repo.packagist.org/p2/monolog/monolog.json'
const DEV_URL = 'https://repo.packagist.org/p2/monolog/monolog~dev.json'

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

const context = () => testContext(records)

/** The two metadata files of a package that has both tagged releases and branches. */
function metadata(url: string): Response {
    if (url === MAIN_URL) return json(monolog)
    if (url === DEV_URL) return json(monologDev)
    return json({error: 'unexpected url ' + url}, 500)
}

beforeEach(() => {
    calls = []
    records = []
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('composer fetchPackage', () => {
    it('reads the p2 metadata of the releases and of the branches', async () => {
        stubFetch(metadata)
        const result = await composerFetcher.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())

        expect(calls.map(c => c.url)).toEqual([MAIN_URL, DEV_URL])
        expect(result).not.toBeNull()
        // Oldest first, branches after the tagged releases.
        expect(result!.versions.map(v => v.version)).toEqual([
            '1.0.0-RC1',
            '2.0.0',
            '3.11.0',
            '3.12.0',
            '2.x-dev',
            'dev-main',
        ])
        expect(result!.sources).toEqual(['repo.packagist.org'])
    })

    it('expands the minified metadata, carrying keys forward and honouring __unset', async () => {
        stubFetch(metadata)
        const result = await composerFetcher.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        // 3.11.0 lists no license of its own; it inherits 3.12.0's.
        expect(byVersion.get('3.11.0')!.licenses).toEqual(['MIT'])
        expect(byVersion.get('3.12.0')!.licenses).toEqual(['MIT'])
        expect(byVersion.get('2.0.0')!.licenses).toEqual(['MIT', 'LGPL-2.1-only'])
        // `"license": "__unset"` removes the inherited value rather than setting it to that string.
        expect(byVersion.get('1.0.0-RC1')!.licenses).toEqual([])
        // Branch metadata is expanded on its own, from the first entry of the ~dev file.
        expect(byVersion.get('2.x-dev')!.licenses).toEqual(['MIT'])
    })

    it('maps times and marks every branch a pre-release', async () => {
        stubFetch(metadata)
        const result = await composerFetcher.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('3.12.0')!.releasedAt?.toISOString()).toBe('2026-09-09T08:34:20.000Z')
        expect(byVersion.get('3.12.0')!.prerelease).toBe(false)
        expect(byVersion.get('1.0.0-RC1')!.prerelease).toBe(true)
        expect(byVersion.get('dev-main')!.prerelease).toBe(true)
        expect(byVersion.get('2.x-dev')!.prerelease).toBe(true)
        // Packagist deletes versions rather than yanking them.
        expect(result!.versions.every(v => !v.yanked)).toBe(true)
    })

    it('takes the library facts from the newest tagged release and designates no latest', async () => {
        stubFetch(metadata)
        const result = await composerFetcher.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())

        expect(result!.licenses).toEqual(['MIT'])
        expect(result!.description).toBe(
            'Sends your logs to files, sockets, inboxes, databases and various web services',
        )
        expect(result!.homepageUrl).toBe('https://github.com/Seldaek/monolog')
        expect(result!.repoUrl).toBe('https://github.com/Seldaek/monolog')
        expect(result!.registryLatest).toBeUndefined()
    })

    it('expands by carrying keys forward, which is why it only runs on minified files', () => {
        const raw = [{version: '2.0.0', license: ['MIT']}, {version: '1.0.0'}]
        expect(expandMinified(raw)).toEqual([
            {version: '2.0.0', license: ['MIT']},
            {version: '1.0.0', license: ['MIT']},
        ])
    })

    it('does not expand a file that never said it was minified', async () => {
        const plain = {packages: {'monolog/monolog': [{version: '2.0.0', license: ['MIT']}, {version: '1.0.0'}]}}
        stubFetch(url => (url === MAIN_URL ? json(plain) : json({}, 404)))
        const result = await composerFetcher.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())

        // Carrying keys forward here would hand 1.0.0 a license it never declared.
        expect(result!.versions.map(v => [v.version, v.licenses])).toEqual([
            ['1.0.0', []],
            ['2.0.0', ['MIT']],
        ])
    })

    it('has no dev versions when there is no ~dev file, which is not a missing package', async () => {
        stubFetch(url => (url === MAIN_URL ? json(monolog) : json({status: 'error'}, 404)))
        const result = await composerFetcher.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())

        expect(result).not.toBeNull()
        expect(result!.versions.map(v => v.version)).toEqual(['1.0.0-RC1', '2.0.0', '3.11.0', '3.12.0'])
    })

    it('returns null on 404 and does not go looking for branches', async () => {
        stubFetch(() => json({status: 'error'}, 404))
        expect(await composerFetcher.fetchPackage(parsePurl('pkg:composer/nope/nope'), context())).toBeNull()
        expect(calls).toHaveLength(1)
    })

    it('throws on 500 so the queue retries', async () => {
        stubFetch(() => json({}, 500))
        await expect(
            composerFetcher.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context()),
        ).rejects.toThrow(/500/)
    })

    it('reports every request it makes', async () => {
        stubFetch(metadata)
        await composerFetcher.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())
        expect(records).toHaveLength(2)
        expect(records[0]).toMatchObject({source: 'repo.packagist.org', status: 200, error: null})
    })
})

/**
 * Captured from Packagist on 2026-10-02 (expanded, trimmed to the fields the mapping reads).
 *  - laravel/framework, the tags published since 2026-08-01: v13, v12, v11, v10 and v9 are all
 *    still patched, and v11.57.0 shipped half an hour after v13.34.0.
 *  - amirami/localizator: every tag is an `-alpha`, and the `0.x-dev` branch was pushed after the
 *    newest one.
 */
describe('composer latest', () => {
    const laravel = fixture('composer-laravel-recent')
    const localizator = fixture('composer-localizator')
    const localizatorDev = fixture('composer-localizator-dev')

    it('is the highest tagged release, not the newest patch of an older major', () => {
        const result = packageFromMetadata('laravel/framework', laravel, null)
        const byVersion = new Map(result.versions.map(v => [v.version, v]))

        expect(byVersion.get('v11.57.0')!.releasedAt!.getTime()).toBeGreaterThan(
            byVersion.get('v13.34.0')!.releasedAt!.getTime(),
        )
        expect(computeLatest('composer', result.versions).latest).toBe('v13.34.0')
    })

    it('is never a branch, even when every tag is a pre-release', () => {
        const result = packageFromMetadata('amirami/localizator', localizator, localizatorDev)

        expect(result.versions.map(v => v.version)).toContain('0.x-dev')
        expect(computeLatest('composer', result.versions)).toEqual({
            latest: 'v0.14.0-alpha',
            latestPrerelease: undefined,
        })
    })
})

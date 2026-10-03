import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createHttpClient, resetLimiters, type FetchRecord} from '../../../src/resolver/registries/http.js'
import {computeLatest} from '../../../src/resolver/registries/latest.js'
import {nullLogger} from '../../../src/shared/log.js'
import {parsePurl} from '../../../src/shared/purl.js'
import {nugetRegistry, packageFromLeaves} from '../../../src/resolver/registries/nuget.js'
import type {FetchContext} from '../../../src/resolver/registries/types.js'

const fixture = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>

const registrationIndex = fixture('nuget-registration-index')
const registrationPage = fixture('nuget-registration-page')
const catalogIndex = fixture('nuget-catalog-index')
const catalogPage = fixture('nuget-catalog-page')
/** The catalog leaves of newtonsoft.json's two unlisted versions, captured 2026-10-02. */
const leafBeta1 = fixture('nuget-catalog-leaf-12.0.1-beta1')
const leafBeta2 = fixture('nuget-catalog-leaf-12.0.1-beta2')
/**
 * Registration blobs captured 2026-10-02, trimmed to the fields the mapping reads.
 * Microsoft.Extensions.Options: 9.0.20 was published after 10.0.12 (servicing of the older major).
 * xunit.assert: no version since 2.3.x declares a projectUrl.
 */
const optionsRegistration = fixture('nuget-ms-extensions-options-registration')
const xunitAssertRegistration = fixture('nuget-xunit-assert-registration')

const INDEX_URL = 'https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/index.json'
const PAGE_URL = 'https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/page/12.0.1/13.0.5-beta1.json'
const CATALOG_URL = 'https://api.nuget.org/v3/catalog0/index.json'
const LEAF_BETA1_URL = 'https://api.nuget.org/v3/catalog0/data/2022.12.08.16.43.03/newtonsoft.json.12.0.1-beta1.json'
const LEAF_BETA2_URL = 'https://api.nuget.org/v3/catalog0/data/2022.12.08.16.43.03/newtonsoft.json.12.0.1-beta2.json'

interface Call {
    url: string
    init?: RequestInit
}

let calls: Call[]
let records: FetchRecord[]

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
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
        http: createHttpClient({type: 'nuget', recorder: record => records.push(record)}),
        log: nullLogger,
        options: {mavenPerVersionLicenses: false},
    }
}

function feed() {
    if (nugetRegistry.feed.mode !== 'feed') throw new Error('nuget should be a feed-mode registry')
    return nugetRegistry.feed
}

/**
 * The registration blobs of a package that inlines one page and links the other, plus the catalog
 * leaves of its two unlisted versions.
 */
function registration(url: string): Response {
    if (url === INDEX_URL) return json(registrationIndex)
    if (url === PAGE_URL) return json(registrationPage)
    if (url === LEAF_BETA1_URL) return json(leafBeta1)
    if (url === LEAF_BETA2_URL) return json(leafBeta2)
    return json({error: 'unexpected url ' + url}, 500)
}

/** Every catalog entry of a recorded registration index, as `fetchPackage` would collect them. */
function leavesOf(index: Record<string, unknown>): Parameters<typeof packageFromLeaves>[0] {
    const pages = index.items as {items: Parameters<typeof packageFromLeaves>[0]}[]
    return pages.flatMap(page => page.items)
}

beforeEach(() => {
    calls = []
    records = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('nuget fetchPackage', () => {
    it('reads the registration index, the pages it did not inline and the unlisted leaves', async () => {
        stubFetch(registration)
        const result = await nugetRegistry.fetchPackage(parsePurl('pkg:nuget/Newtonsoft.Json'), context())

        // The id is lowercased by `purl.ts`; the blob paths only exist in lowercase. The catalog
        // leaves are read for the unlisted versions only, highest first.
        expect(calls.map(c => c.url)).toEqual([INDEX_URL, PAGE_URL, LEAF_BETA2_URL, LEAF_BETA1_URL])
        expect(result).not.toBeNull()
        expect(result!.versions.map(v => v.version)).toEqual([
            '3.5.8',
            '12.0.1-beta1',
            '12.0.1-beta2',
            '12.0.1',
            '13.0.4',
            '13.0.5-beta1',
        ])
        expect(result!.sources).toEqual(['api.nuget.org'])
    })

    it('maps dates, licenses and the unlisted flag', async () => {
        stubFetch(registration)
        const result = await nugetRegistry.fetchPackage(parsePurl('pkg:nuget/newtonsoft.json'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('3.5.8')!.releasedAt?.toISOString()).toBe('2011-01-08T22:12:57.713Z')
        expect(byVersion.get('12.0.1')!.licenses).toEqual(['MIT'])
        // No `licenseExpression` before 2018: the url is a worse answer than an SPDX id, and a
        // better one than nothing. It is not concatenated onto anything.
        expect(byVersion.get('3.5.8')!.licenses).toEqual(['http://james.newtonking.com/projects/json-net.aspx'])
        expect(byVersion.get('13.0.5-beta1')!.prerelease).toBe(true)
        expect(byVersion.get('13.0.4')!.prerelease).toBe(false)
    })

    it('treats unlisted as yanked and dates it from its catalog leaf, not the 1900 sentinel', async () => {
        stubFetch(registration)
        const result = await nugetRegistry.fetchPackage(parsePurl('pkg:nuget/newtonsoft.json'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('12.0.1-beta1')!.yanked).toBe(true)
        expect(byVersion.get('12.0.1-beta1')!.releasedAt?.toISOString()).toBe('2018-10-30T00:37:50.850Z')
        expect(byVersion.get('12.0.1-beta2')!.yanked).toBe(true)
        expect(byVersion.get('12.0.1-beta2')!.releasedAt?.toISOString()).toBe('2018-11-25T08:27:34.427Z')
        expect(byVersion.get('12.0.1')!.yanked).toBe(false)
        expect(byVersion.get('12.0.1')!.releasedAt?.toISOString()).toBe('2019-02-14T05:19:02.110Z')
    })

    it('leaves an unlisted version undated when its catalog leaf will not load', async () => {
        stubFetch(url => (url === LEAF_BETA1_URL ? json({}, 503) : registration(url)))
        const result = await nugetRegistry.fetchPackage(parsePurl('pkg:nuget/newtonsoft.json'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('12.0.1-beta1')!.releasedAt).toBeNull()
        expect(byVersion.get('12.0.1-beta2')!.releasedAt).not.toBeNull()
    })

    it('reads no catalog leaf when every version is listed', async () => {
        stubFetch(url => (url.endsWith('/index.json') ? json(xunitAssertRegistration) : json({}, 500)))
        const result = await nugetRegistry.fetchPackage(parsePurl('pkg:nuget/xunit.assert'), context())

        // The recorded index has its pages inlined, so the index is the only request.
        expect(calls).toHaveLength(1)
        expect(result!.versions.filter(v => v.yanked)).toEqual([])
    })

    it('makes the highest stable version latest, not a later servicing release of an older major', () => {
        const result = packageFromLeaves(leavesOf(optionsRegistration))
        const byVersion = new Map(result.versions.map(v => [v.version, v]))

        // The trap: 9.0.20 was published 13 minutes after 10.0.12.
        expect(byVersion.get('9.0.20')!.releasedAt!.getTime()).toBeGreaterThan(
            byVersion.get('10.0.12')!.releasedAt!.getTime(),
        )
        // nuget.org's search (prerelease=false) says 10.0.12 too.
        expect(computeLatest('nuget', result.versions)).toEqual({
            latest: '10.0.12',
            latestPrerelease: '11.0.0-rc.1.26425.128',
        })
    })

    it('takes the homepage from the newest version that declares one', () => {
        const result = packageFromLeaves(leavesOf(xunitAssertRegistration))
        const versions = result.versions.map(v => v.version)

        expect(versions.at(-1)).toBe('2.9.3')
        expect(result.homepageUrl).toBe('https://github.com/xunit/xunit')
    })

    it('prefers any listed version\'s homepage over an unlisted one', () => {
        // Azure.Identity: an old unlisted 1.2.0 declares a URL that is no longer the project's.
        const leaf = (version: string, listed: boolean, projectUrl?: string) =>
            ({catalogEntry: {version, listed, projectUrl, published: '2026-01-01T00:00:00Z'}}) as Parameters<typeof packageFromLeaves>[0][number]
        const listedFirst = packageFromLeaves([
            leaf('1.2.0', false, 'https://old.example/unlisted'),
            leaf('1.20.0', true, 'https://example/listed'),
            leaf('1.21.0', true),
        ])
        expect(listedFirst.homepageUrl).toBe('https://example/listed')

        const onlyUnlisted = packageFromLeaves([leaf('1.2.0', false, 'https://old.example/unlisted'), leaf('1.21.0', true)])
        expect(onlyUnlisted.homepageUrl).toBe('https://old.example/unlisted')
    })

    it('takes the library facts from the newest listed version and designates no latest', async () => {
        stubFetch(registration)
        const result = await nugetRegistry.fetchPackage(parsePurl('pkg:nuget/newtonsoft.json'), context())

        expect(result!.licenses).toEqual(['MIT'])
        expect(result!.description).toBe('Json.NET is a popular high-performance JSON framework for .NET')
        expect(result!.homepageUrl).toBe('https://www.newtonsoft.com/json')
        expect(result!.repoUrl).toBe('https://github.com/JamesNK/Newtonsoft.Json')
        // This API has no "latest": `computeLatest` decides from the dates.
        expect(result!.registryLatest).toBeUndefined()
    })

    it('never has more than four page requests in flight', async () => {
        const pages = Array.from({length: 12}, (_, i) => ({
            '@id': `https://api.nuget.org/v3/registration5-gz-semver2/big/page/${i}.json`,
        }))
        let inFlight = 0
        let peak = 0
        stubFetch(async url => {
            if (url.endsWith('/index.json')) return json({items: pages})
            inFlight++
            peak = Math.max(peak, inFlight)
            await new Promise(resolve => setTimeout(resolve, 1))
            inFlight--
            return json({items: []})
        })

        await nugetRegistry.fetchPackage(parsePurl('pkg:nuget/big'), context())

        expect(calls).toHaveLength(13)
        expect(peak).toBeLessThanOrEqual(4)
    })

    it('returns null on 404', async () => {
        stubFetch(() => json({}, 404))
        expect(await nugetRegistry.fetchPackage(parsePurl('pkg:nuget/no.such.package'), context())).toBeNull()
    })

    it('throws on 500 so the queue retries', async () => {
        stubFetch(() => json({}, 500))
        await expect(nugetRegistry.fetchPackage(parsePurl('pkg:nuget/newtonsoft.json'), context())).rejects.toThrow(
            /500/,
        )
    })

    it('throws when a linked page is unavailable', async () => {
        stubFetch(url => (url === INDEX_URL ? json(registrationIndex) : json({}, 503)))
        await expect(nugetRegistry.fetchPackage(parsePurl('pkg:nuget/newtonsoft.json'), context())).rejects.toThrow(
            /503/,
        )
    })

    it('records every request for fetch_log', async () => {
        stubFetch(registration)
        await nugetRegistry.fetchPackage(parsePurl('pkg:nuget/newtonsoft.json'), context())
        expect(records).toHaveLength(4)
        expect(records[0]).toMatchObject({source: 'api.nuget.org', status: 200, error: null})
    })
})

describe('nuget feed', () => {
    it('starts from the catalog head commit', async () => {
        stubFetch(() => json(catalogIndex))

        const cursor = await feed().initialCursor(context())

        expect(cursor).toBe('2026-09-16T10:26:20.8736413Z')
        expect(calls[0]?.url).toBe(CATALOG_URL)
    })

    it('reads the pages committed after the cursor and emits one event per id', async () => {
        stubFetch(url => {
            if (url === CATALOG_URL) return json(catalogIndex)
            if (url.endsWith('page23120.json')) return json(catalogPage)
            return json({items: []})
        })

        const result = await feed().poll('2026-09-16T09:00:00.0000000Z', context())

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
        const result = await feed().poll('2026-09-16T10:26:20.8736413Z', context())

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

        const result = await feed().poll('2026-09-10T00:00:00.0000000Z', context())

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
        await expect(feed().poll('2026-09-16T09:00:00.0000000Z', context())).rejects.toThrow(/503/)
    })
})

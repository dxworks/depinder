import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {parsePurl} from '../../src/purl.js'
import {fetchLicenses} from '../../src/registries/deps-dev.js'
import {
    escapeModulePath,
    golangFetcher,
    isPseudoVersion,
    LICENSE_RECHECK_AFTER_MS,
    LICENSE_RECHECK_WINDOW_MS,
    licenseRecheckAt,
    MAX_LICENSE_VERSIONS,
} from '../../src/registries/golang.js'
import {fixtureJson, fixtureText, testContext, type SeenRequest} from './registry.helpers.js'

const listDoc = fixtureText('golang-list.txt')
const latestDoc = fixtureJson('golang-latest')
const depsDevDoc = fixtureJson('depsdev-gin')

const GIN = 'https://proxy.golang.org/github.com/gin-gonic/gin'
const DEPS_DEV = 'https://api.deps.dev/v3/systems/go/packages/github.com%2Fgin-gonic%2Fgin/versions'

/** Commit times as `@v/<v>.info` reports them. `v1.10.1` comes from `@latest` instead. */
const TIMES: Record<string, string> = {
    'v1.7.7': '2022-08-11T02:22:01Z',
    'v1.9.0-rc.1': '2022-12-20T09:00:00Z',
    'v1.9.1': '2023-01-05T13:11:28Z',
    'v1.10.0': '2024-05-07T03:23:42Z',
}

let calls: string[]
let records: SeenRequest[]

function stubFetch(handler: (url: string) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL) => {
        const url = String(input)
        calls.push(url)
        return Promise.resolve(handler(url))
    })
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

function text(body: string, status = 200): Response {
    return new Response(body, {status, headers: {'content-type': 'text/plain'}})
}

/** proxy.golang.org + api.deps.dev as they answer for gin. */
function gin(url: string): Response {
    if (url === `${GIN}/@v/list`) return text(listDoc)
    if (url === `${GIN}/@latest`) return json(latestDoc)

    const info = /\/@v\/(.+)\.info$/.exec(url)
    if (info) {
        const time = TIMES[info[1]!]
        return time ? json({Version: info[1], Time: time}) : text('not found', 404)
    }

    if (url === `${DEPS_DEV}/v1.7.7`) return text('{"code":"NOT_FOUND"}', 404)
    if (url === `${DEPS_DEV}/v1.9.0-rc.1`) return json({versionKey: {}, licenses: []})
    if (url.startsWith(DEPS_DEV)) return json(depsDevDoc)

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

describe('golang module path escaping', () => {
    it('escapes uppercase letters the way the proxy wants them', () => {
        expect(escapeModulePath('github.com/Azure/azure-sdk')).toBe('github.com/!azure/azure-sdk')
        expect(escapeModulePath('github.com/gin-gonic/gin')).toBe('github.com/gin-gonic/gin')
        expect(escapeModulePath('v1.0.0-RC1')).toBe('v1.0.0-!r!c1')
    })

    it('builds the escaped proxy url but keeps the package key cased', async () => {
        stubFetch(() => text('', 404))
        const key = parsePurl('pkg:golang/github.com/Azure/azure-sdk')

        expect(await golangFetcher.fetchPackage(key, context())).toBeNull()
        expect(calls[0]).toBe('https://proxy.golang.org/github.com/!azure/azure-sdk/@v/list')
        expect(key.packageKey).toBe('pkg:golang/github.com/Azure/azure-sdk')
    })
})

describe('golang pre-release detection', () => {
    it('counts pseudo-versions as pre-releases', () => {
        expect(isPseudoVersion('v0.0.0-20230101120000-abcdef123456')).toBe(true)
        expect(isPseudoVersion('v1.2.3-0.20230101120000-abcdef123456')).toBe(true)
        expect(isPseudoVersion('v1.2.3-pre.0.20230101120000-abcdef123456')).toBe(true)
        expect(isPseudoVersion('v1.2.3')).toBe(false)
        expect(isPseudoVersion('v1.2.3-beta.1')).toBe(false)
    })
})

describe('golang fetchPackage', () => {
    it('returns null when the proxy has never heard of the module', async () => {
        stubFetch(() => text('not found: module ... : no matching versions', 404))
        expect(await golangFetcher.fetchPackage(parsePurl('pkg:golang/example.com/nope'), context())).toBeNull()
    })

    it('returns null on 410 Gone', async () => {
        stubFetch(() => text('gone', 410))
        expect(await golangFetcher.fetchPackage(parsePurl('pkg:golang/example.com/nope'), context())).toBeNull()
    })

    it('throws on 500 so the queue retries', async () => {
        stubFetch(() => text('boom', 500))
        await expect(
            golangFetcher.fetchPackage(parsePurl('pkg:golang/github.com/gin-gonic/gin'), context()),
        ).rejects.toThrow(/500/)
    })

    it('maps versions, commit times, licenses and the proxy latest', async () => {
        stubFetch(gin)
        const result = await golangFetcher.fetchPackage(parsePurl('pkg:golang/github.com/gin-gonic/gin'), context())

        expect(result).not.toBeNull()
        expect(result!.registryLatest).toBe('v1.10.1')
        expect(result!.repoUrl).toBe('https://github.com/gin-gonic/gin')
        expect(result!.homepageUrl).toBe('https://github.com/gin-gonic/gin')
        expect(result!.licenses).toEqual(['MIT'])
        expect(result!.sources).toEqual(['proxy.golang.org', 'api.deps.dev'])

        const byVersion = new Map(result!.versions.map(v => [v.version, v]))
        // `@latest` names a version the list does not carry, so it is appended.
        expect([...byVersion.keys()]).toEqual(['v1.9.1', 'v1.10.0', 'v1.7.7', 'v1.9.0-rc.1', 'v1.10.1'])
        expect(byVersion.get('v1.10.0')!.releasedAt?.toISOString()).toBe('2024-05-07T03:23:42.000Z')
        // The time of the version `@latest` names comes from `@latest` itself, not a second request.
        expect(byVersion.get('v1.10.1')!.releasedAt?.toISOString()).toBe('2024-05-08T03:41:33.000Z')
        expect(calls).not.toContain(`${GIN}/@v/v1.10.1.info`)

        expect(byVersion.get('v1.10.0')!.licenses).toEqual(['MIT'])
        expect(byVersion.get('v1.9.0-rc.1')!.prerelease).toBe(true)
        expect(byVersion.get('v1.10.0')!.prerelease).toBe(false)
        // The proxy is immutable: nothing it has served is ever withdrawn.
        expect(result!.versions.every(v => v.yanked === false)).toBe(true)
    })

    it('leaves a version dateless when its .info is missing rather than dropping it', async () => {
        stubFetch(url => (url === `${GIN}/@v/v1.7.7.info` ? text('not found', 404) : gin(url)))
        const result = await golangFetcher.fetchPackage(parsePurl('pkg:golang/github.com/gin-gonic/gin'), context())
        expect(result!.versions.find(v => v.version === 'v1.7.7')?.releasedAt).toBeNull()
    })

    it('treats a deps.dev 404 as "no license on record", not an error', async () => {
        stubFetch(gin)
        const result = await golangFetcher.fetchPackage(parsePurl('pkg:golang/github.com/gin-gonic/gin'), context())
        expect(result!.versions.find(v => v.version === 'v1.7.7')?.licenses).toEqual([])
        // v1.7.7 is years old: deps.dev not knowing it is its answer, and nothing is re-checked.
        expect(result!.recheckAt).toBeUndefined()
    })

    describe('a version deps.dev has not scanned yet', () => {
        afterEach(() => vi.useRealTimers())

        /** gin, with deps.dev not knowing v1.10.1 — the version `@latest` names, out on 2024-05-08. */
        const unscanned = (url: string): Response =>
            url === `${DEPS_DEV}/v1.10.1` ? text('{"code":"NOT_FOUND"}', 404) : gin(url)

        it('asks for the package to be fetched again in six hours while the version is new', async () => {
            vi.useFakeTimers({toFake: ['Date']})
            vi.setSystemTime(new Date('2024-05-09T00:00:00Z'))
            stubFetch(unscanned)

            const result = await golangFetcher.fetchPackage(parsePurl('pkg:golang/github.com/gin-gonic/gin'), context())

            expect(result!.versions.find(v => v.version === 'v1.10.1')?.licenses).toEqual([])
            expect(result!.recheckAt?.getTime()).toBe(Date.parse('2024-05-09T00:00:00Z') + LICENSE_RECHECK_AFTER_MS)
            // The library licence never depended on it: it falls back to the newest version with one.
            expect(result!.licenses).toEqual(['MIT'])
        })

        it('takes the 404 as the answer once the version is older than a week', async () => {
            vi.useFakeTimers({toFake: ['Date']})
            vi.setSystemTime(new Date(Date.parse('2024-05-08T03:41:33Z') + LICENSE_RECHECK_WINDOW_MS + 1))
            stubFetch(unscanned)

            const result = await golangFetcher.fetchPackage(parsePurl('pkg:golang/github.com/gin-gonic/gin'), context())

            expect(result!.recheckAt).toBeUndefined()
        })
    })

    it('asks for no re-check when deps.dev knows every version it was asked about', async () => {
        const now = Date.parse('2024-05-09T00:00:00Z')
        const versions = [{version: 'v1.0.0', releasedAt: new Date(now - 3_600_000)}, {version: 'v0.9.0', releasedAt: null}]
        // Scanned with no licence found ([]) is an answer; never asked (absent) is not a 404.
        expect(licenseRecheckAt(versions, new Map([['v1.0.0', []]]), now)).toBeUndefined()
        expect(licenseRecheckAt(versions, new Map(), now)).toBeUndefined()
        // An undated version is never young enough to wait for.
        expect(licenseRecheckAt(versions, new Map([['v0.9.0', null]]), now)).toBeUndefined()
        expect(licenseRecheckAt(versions, new Map([['v1.0.0', null]]), now)?.getTime()).toBe(now + LICENSE_RECHECK_AFTER_MS)
    })

    it('works when the proxy has no @latest', async () => {
        stubFetch(url => (url === `${GIN}/@latest` ? text('not found', 404) : gin(url)))
        const result = await golangFetcher.fetchPackage(parsePurl('pkg:golang/github.com/gin-gonic/gin'), context())

        expect(result!.registryLatest).toBeUndefined()
        expect(result!.repoUrl).toBeUndefined()
        expect(result!.versions.map(v => v.version)).toEqual(['v1.9.1', 'v1.10.0', 'v1.7.7', 'v1.9.0-rc.1'])
        // No version-level designation, so the library license falls back to the newest one that has any.
        expect(result!.licenses).toEqual(['MIT'])
    })

    it('asks deps.dev only about the newest versions', async () => {
        const many = Array.from({length: MAX_LICENSE_VERSIONS + 10}, (_, i) => `v1.0.${i}`)
        stubFetch(url => {
            if (url.endsWith('/@v/list')) return text(many.join('\n') + '\n')
            if (url.endsWith('/@latest')) return text('not found', 404)
            const info = /\/@v\/v1\.0\.(\d+)\.info$/.exec(url)
            // Ascending patch number, ascending date: v1.0.0 is the oldest.
            if (info) return json({Time: new Date(Date.UTC(2020, 0, 1 + Number(info[1]))).toISOString()})
            return json({licenses: ['MIT']})
        })

        const result = await golangFetcher.fetchPackage(parsePurl('pkg:golang/github.com/gin-gonic/gin'), context())

        const licenseCalls = calls.filter(url => url.startsWith('https://api.deps.dev/'))
        expect(licenseCalls).toHaveLength(MAX_LICENSE_VERSIONS)
        const byVersion = new Map(result!.versions.map(v => [v.version, v.licenses]))
        expect(byVersion.get(`v1.0.${MAX_LICENSE_VERSIONS + 9}`)).toEqual(['MIT'])
        expect(byVersion.get('v1.0.0')).toEqual([]) // too old to be worth a request
    })

    it('reports every request it makes', async () => {
        stubFetch(gin)
        await golangFetcher.fetchPackage(parsePurl('pkg:golang/github.com/gin-gonic/gin'), context())
        expect(records.some(r => r.source === 'proxy.golang.org')).toBe(true)
        expect(records.some(r => r.source === 'api.deps.dev')).toBe(true)
    })
})

describe('deps-dev fetchLicenses', () => {
    it('url-encodes the module path and reads licenses[]', async () => {
        stubFetch(() => json(depsDevDoc))
        expect(await fetchLicenses('github.com/gin-gonic/gin', 'v1.10.0', context())).toEqual(['MIT'])
        expect(calls[0]).toBe(`${DEPS_DEV}/v1.10.0`)
    })

    it('returns null for a version deps.dev has not indexed, apart from [] for one with no licence', async () => {
        stubFetch(() => json({code: 'NOT_FOUND'}, 404))
        expect(await fetchLicenses('github.com/gin-gonic/gin', 'v9.9.9', context())).toBeNull()
    })

    it('throws on 500 rather than storing "no license" as a fact', async () => {
        stubFetch(() => json({}, 500))
        await expect(fetchLicenses('github.com/gin-gonic/gin', 'v1.10.0', context())).rejects.toThrow(/500/)
    })
})

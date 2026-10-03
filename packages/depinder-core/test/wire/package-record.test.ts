import {afterEach, describe, expect, it, vi} from 'vitest'
import {fetchPackage} from '../../src/fetch-package.js'
import {parsePurl} from '../../src/purl.js'
import type {FetchedVersion, ResolvedPackage} from '../../src/registries/types.js'
import {toPackageRecord, versionPointer, type PackageRecord} from '../../src/wire/package-record.js'
import {fixtureJson, testContext} from '../registries/registry.helpers.js'

const FETCHED_AT = new Date('2026-10-03T10:00:00.123Z')
const AT = '2026-10-03T10:00:00.123Z'

afterEach(() => vi.unstubAllGlobals())

/** Fetches `purl` through core from recorded answers and converts it, as the CLI's fallback will. */
async function recordOf(purl: string, answer: (url: string) => unknown): Promise<PackageRecord> {
    vi.stubGlobal('fetch', (url: string) => Promise.resolve(new Response(JSON.stringify(answer(String(url))))))
    const key = parsePurl(purl)
    const pkg = await fetchPackage(key, testContext([]))
    return toPackageRecord(key, pkg!, FETCHED_AT)
}

describe('toPackageRecord on recorded registry answers', () => {
    it('npm express: the whole record, versions by release date, latest dated from its version', async () => {
        expect(await recordOf('pkg:npm/express', () => fixtureJson('npm-express'))).toEqual({
            type: 'npm',
            namespace: null,
            name: 'express',
            description: 'Fast, unopinionated, minimalist web framework',
            homepage_url: 'http://expressjs.com/',
            repo_url: 'https://github.com/expressjs/express',
            licenses: ['MIT'],
            latest: {version: '4.18.2', released_at: '2022-10-08T20:46:50.000Z'},
            latest_prerelease: {version: '4.19.0', released_at: '2024-03-25T17:50:00.000Z'},
            versions: [
                ['0.14.0', 1304893397, 0],
                ['4.17.1', 1558801952, 0],
                ['5.0.0-alpha.8', 1585150200, 1],
                ['4.18.2', 1665262010, 0],
                ['4.19.0', 1711389000, 0],
            ],
            as_of: AT,
            source: 'registry.npmjs.org',
            fetched_at: AT,
            confirmed_at: AT,
        })
    })

    it('pypi requests: only the current release shares the package licenses, the rest say [] outright', async () => {
        const record = await recordOf('pkg:pypi/requests', () => fixtureJson('pypi-requests'))

        expect(record.licenses).toEqual(['Apache-2.0'])
        expect(record.versions).toEqual([
            ['0.0.1', null, 0, []], // no files left: undated, and undated sorts first
            ['2.31.0', 1684768362, 0, []],
            ['2.32.0', 1716221292, 2, []], // every file yanked
            ['2.34.2', 1787047431, 0],
            ['3.0.0b1', 1788253200, 1, []],
        ])
        expect(record.latest).toEqual({version: '2.34.2', released_at: '2026-08-18T10:03:51.000Z'})
    })

    it('cargo serde: release order, not the registry newest-first list, and per-version expressions kept', async () => {
        const record = await recordOf('pkg:cargo/serde', () => fixtureJson('cargo-serde'))

        expect(record.versions).toEqual([
            ['0.9.0-rc1', 1484501125, 1, ['MIT/Apache-2.0']],
            ['0.8.23', 1484954785, 0, ['MIT/Apache-2.0']],
            ['1.0.95', 1563297950, 2],
            ['1.0.172-alpha.0', 1689800633, 1],
            ['1.0.229', 1784415913, 0],
        ])
        expect(record.latest_prerelease).toBeNull()
    })

    it('nuget: unlisted versions without a date first, every version once, latest by version order', async () => {
        const record = await recordOf('pkg:nuget/Microsoft.Extensions.Options', () =>
            fixtureJson('nuget-ms-extensions-options-registration'),
        )

        expect(record.name).toBe('microsoft.extensions.options')
        expect(record.versions.slice(0, 3).map(v => [v[0], v[1], v[2]])).toEqual([
            ['0.0.1-alpha', null, 3],
            ['6.0.2-mauipre.1.22054.8', null, 3],
            ['6.0.2-mauipre.1.22102.15', null, 3],
        ])
        expect(new Set(record.versions.map(v => v[0])).size).toBe(record.versions.length)
        const dates = record.versions.map(v => v[1]).filter((d): d is number => d !== null)
        expect(dates).toEqual([...dates].sort((a, b) => a - b))
        expect(record.latest).toEqual({version: '10.0.12', released_at: '2026-09-08T19:03:11.000Z'})
    })
})

function version(name: string, releasedAt: string | null, extra: Partial<FetchedVersion> = {}): FetchedVersion {
    const date = releasedAt ? new Date(releasedAt) : null
    return {version: name, releasedAt: date, licenses: ['MIT'], prerelease: false, yanked: false, ...extra}
}

function resolved(overrides: Partial<ResolvedPackage>): ResolvedPackage {
    return {licenses: ['MIT'], versions: [], sources: ['proxy.golang.org', 'api.deps.dev'], ...overrides}
}

describe('toPackageRecord', () => {
    const key = parsePurl('pkg:golang/github.com/acme/lib')

    it('keeps the first of a version listed twice, as storing it does', () => {
        const pkg = resolved({
            versions: [version('v1.0.0', '2024-01-01T00:00:00Z'), version('v1.0.0', '2025-01-01T00:00:00Z', {yanked: true})],
        })
        expect(toPackageRecord(key, pkg, FETCHED_AT).versions).toEqual([['v1.0.0', 1704067200, 0]])
    })

    it('orders versions of the same second by version, and floors release times to whole seconds', () => {
        const pkg = resolved({
            versions: [
                version('v1.10.0', '2024-01-01T00:00:00.900Z'),
                version('v1.9.0', '2024-01-01T00:00:00.100Z'),
                version('v0.1.0', null),
            ],
        })
        // Different milliseconds still order by time: the version breaks only exact ties.
        expect(toPackageRecord(key, pkg, FETCHED_AT).versions.map(v => [v[0], v[1]])).toEqual([
            ['v0.1.0', null],
            ['v1.9.0', 1704067200],
            ['v1.10.0', 1704067200],
        ])
    })

    it('sends a fourth element only where a version disagrees with the package, order included', () => {
        const pkg = resolved({
            licenses: ['MIT', 'Apache-2.0'],
            versions: [
                version('v1', '2024-01-01T00:00:00Z', {licenses: ['MIT', 'Apache-2.0']}),
                version('v2', '2024-02-01T00:00:00Z', {licenses: ['Apache-2.0', 'MIT']}),
                version('v3', '2024-03-01T00:00:00Z', {licenses: []}),
            ],
        })
        const fourth = toPackageRecord(key, pkg, FETCHED_AT).versions.map(v => v[3])
        expect(fourth).toEqual([undefined, ['Apache-2.0', 'MIT'], []])
    })

    it('fills absent facts with null and joins the hosts the facts came from', () => {
        const record = toPackageRecord(key, resolved({latest: 'v9.9.9'}), FETCHED_AT)
        expect(record).toMatchObject({
            namespace: 'github.com/acme',
            name: 'lib',
            description: null,
            homepage_url: null,
            repo_url: null,
            latest: {version: 'v9.9.9', released_at: null},
            latest_prerelease: null,
            source: 'proxy.golang.org, api.deps.dev',
        })
    })
})

describe('versionPointer', () => {
    it('is null without a version, and dates it from the version tuples when it is there', () => {
        expect(versionPointer(null, [])).toBeNull()
        const pointer = versionPointer('1.0.0', [['1.0.0', 1, 0]])
        expect(pointer).toEqual({version: '1.0.0', released_at: '1970-01-01T00:00:01.000Z'})
    })
})

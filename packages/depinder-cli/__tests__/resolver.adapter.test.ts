import {CompactVersion, PackageRecord} from '../src/resolver/client'
import {componentLinkOf, registryNameOf, toLibraryInfo} from '../src/resolver/adapter'
import {LibraryInfo} from '../src/extension-points/library-info'
import {newerVersionCounts} from '../src/blackduck/versions'
import {comparatorForPurlType} from '../src/blackduck/model'
import {licenseOf} from '../src/commands/analyse'

/**
 * The resolver speaks purls and Postgres rows; everything downstream of `analyse` — the cache, the
 * CSV writers, `update` — speaks `LibraryInfo`. This is the one place that translates, so a field
 * dropped here is a column silently emptied in every report.
 *
 * Since the compact wire shape (`[version, released_at, flags]`, with an optional fourth element
 * for licenses that differ from the package's) the translation also has to *expand*: a package
 * ships every version it ever had, and the field names were most of the bytes. The expansion is
 * only allowed to be a transport detail — see the parity tests at the bottom.
 */

/** The wire carries epoch seconds, not ISO strings. */
const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000)

const record = (overrides: Partial<PackageRecord>): PackageRecord => ({
    type: 'npm',
    namespace: null,
    name: 'left-pad',
    description: 'pads on the left',
    homepage_url: 'https://example.com',
    repo_url: 'https://github.com/example/left-pad',
    licenses: ['MIT'],
    latest: {version: '1.3.0', released_at: '2018-01-01T00:00:00Z'},
    latest_prerelease: null,
    versions: [
        ['1.2.0', at('2017-01-01T00:00:00Z'), 0],
        ['1.3.0', at('2018-01-01T00:00:00Z'), 0],
    ],
    as_of: '2026-09-16T10:00:00Z',
    source: 'npm',
    fetched_at: '2026-09-16T10:00:00Z',
    confirmed_at: null,
    ...overrides,
})

describe('the resolver package record adapter', () => {
    it('round-trips a package into the LibraryInfo shape the cache stores', () => {
        const info = toLibraryInfo(record({}))

        expect(info.name).toBe('left-pad')
        expect(info.description).toBe('pads on the left')
        expect(info.licenses).toEqual(['MIT'])
        expect(info.homepageUrl).toBe('https://example.com')
        expect(info.reposUrl).toEqual(['https://github.com/example/left-pad'])
        expect(info.issuesUrl).toEqual([])
        expect(info.versions).toHaveLength(2)
        expect(info.versions[0]).toEqual({
            version: '1.2.0',
            timestamp: Date.parse('2017-01-01T00:00:00Z'),
            latest: false,
            licenses: ['MIT'],
        })
    })

    it('marks exactly the version the server calls latest', () => {
        const info = toLibraryInfo(record({}))
        expect(info.versions.filter(it => it.latest).map(it => it.version)).toEqual(['1.3.0'])
    })

    it('marks nothing latest when the server has no latest version', () => {
        const info = toLibraryInfo(record({latest: null}))
        expect(info.versions.some(it => it.latest)).toBe(false)
    })

    it('keeps a yanked version, marked, so a project pinned to it still gets its date and licence', () => {
        // Blazored.LocalStorage 4.5.0 is unlisted on nuget.org and still restored by projects;
        // dropped here, its row fell back to `moment(undefined)` and reported it released "now".
        const info = toLibraryInfo(record({
            licenses: ['MIT'],
            latest: {version: '1.2.1', released_at: '2017-02-01T00:00:00Z'},
            versions: [
                ['1.2.0', at('2017-01-01T00:00:00Z'), 0],
                ['1.2.1', at('2017-02-01T00:00:00Z'), 2, ['Apache-2.0']],
            ],
        }))
        expect(info.versions.map(it => it.version)).toEqual(['1.2.0', '1.2.1'])
        expect(info.versions[1]).toEqual({
            version: '1.2.1', timestamp: Date.parse('2017-02-01T00:00:00Z'),
            latest: false, licenses: ['Apache-2.0'], yanked: true,
        })
        // Not marked yanked at all when it is not: the cached shape of every other version is unchanged.
        expect('yanked' in info.versions[0]).toBe(false)
    })

    it('never marks a yanked version latest, even when the server names it', () => {
        const info = toLibraryInfo(record({
            latest: {version: '1.2.1', released_at: '2017-02-01T00:00:00Z'},
            versions: [['1.2.0', at('2017-01-01T00:00:00Z'), 0], ['1.2.1', at('2017-02-01T00:00:00Z'), 2]],
        }))
        expect(info.versions.some(it => it.latest)).toBe(false)
    })

    it('reads the flag bits one at a time: prerelease is not yanked, yanked is, both is', () => {
        // Bit 0 is prerelease and bit 1 is yanked, so 3 is both. `LibraryInfo` has nowhere to put
        // "prerelease", and the registrars that produce it do not mark one either, so a
        // prerelease is carried like any other version.
        const info = toLibraryInfo(record({
            versions: [
                ['1.0.0', at('2020-01-01T00:00:00Z'), 0],
                ['2.0.0-rc.1', at('2021-01-01T00:00:00Z'), 1],
                ['1.0.1', at('2021-02-01T00:00:00Z'), 2],
                ['2.0.0-rc.2', at('2021-03-01T00:00:00Z'), 3],
            ],
        }))
        expect(info.versions.map(it => [it.version, !!it.yanked])).toEqual([
            ['1.0.0', false], ['2.0.0-rc.1', false], ['1.0.1', true], ['2.0.0-rc.2', true],
        ])
    })

    describe('the component link', () => {
        const urls = {homepage_url: 'https://laravel.com', repo_url: 'https://github.com/laravel/framework'}

        it.each(['composer', 'cargo'])('prefers the repository for %s, where Black Duck holds it', type => {
            // laravel/framework on packagist: `homepage` https://laravel.com, `source.url` the GitHub repo.
            expect(componentLinkOf({type, ...urls})).toBe('https://github.com/laravel/framework')
            expect(componentLinkOf({type, ...urls, repo_url: null})).toBe('https://laravel.com')
        })

        it.each(['npm', 'nuget', 'maven', 'pypi', 'gem', 'golang'])('prefers the homepage for %s, falling back to the repository', type => {
            expect(componentLinkOf({type, ...urls})).toBe('https://laravel.com')
            expect(componentLinkOf({type, ...urls, homepage_url: null})).toBe('https://github.com/laravel/framework')
            expect(componentLinkOf({type, ...urls, homepage_url: ' '})).toBe('https://github.com/laravel/framework')
        })

        it('is empty when the server has neither', () => {
            expect(componentLinkOf({type: 'npm', homepage_url: null, repo_url: null})).toBe('')
        })

        it('is what toLibraryInfo hands on as homepageUrl', () => {
            expect(toLibraryInfo(record({type: 'composer', ...urls})).homepageUrl).toBe('https://github.com/laravel/framework')
            expect(toLibraryInfo(record({type: 'npm', homepage_url: null})).homepageUrl).toBe('https://github.com/example/left-pad')
        })
    })

    it('expands a three-element tuple to the package-level licenses', () => {
        // The server ships a fourth element only when a version differs from its package, so the
        // common case — every version under one license — arrives with no license data at all.
        const info = toLibraryInfo(record({
            licenses: ['MIT'],
            versions: [['1.2.0', at('2017-01-01T00:00:00Z'), 0]],
        }))
        expect(info.versions[0].licenses).toEqual(['MIT'])
        expect(info.licenses).toEqual(['MIT'])
    })

    it('takes a four-element tuple verbatim, including an explicit empty list', () => {
        // `[]` on a version whose package has a license is a fact, not an absence: the version
        // genuinely declares none. It must not be read as "same as the package".
        const info = toLibraryInfo(record({
            licenses: ['MIT'],
            versions: [
                ['1.2.0', at('2017-01-01T00:00:00Z'), 0, []],
                ['1.3.0', at('2018-01-01T00:00:00Z'), 0, ['Apache-2.0']],
            ],
        }))
        expect(info.versions.map(it => it.licenses)).toEqual([[], ['Apache-2.0']])
    })

    it('expands to the package list even when the package has none', () => {
        const info = toLibraryInfo(record({
            licenses: [],
            versions: [['1.2.0', at('2017-01-01T00:00:00Z'), 0]],
        }))
        expect(info.versions[0].licenses).toEqual([])
    })

    it('carries a version with no release date as an unparseable timestamp, not as epoch zero', () => {
        // `Date.parse('')` is what the Go registrar produces for a version the proxy has no time
        // for, and `moment(NaN)` formats as "Invalid date" — a blank cell, not January 1970. A
        // `null` on the wire has to land in the same place, and emphatically not on 1970-01-01.
        const info = toLibraryInfo(record({
            versions: [['1.2.0', null, 0]],
        }))
        expect(Number.isNaN(info.versions[0].timestamp)).toBe(true)
    })

    it('turns epoch seconds into the epoch milliseconds LibraryInfo has always held', () => {
        const info = toLibraryInfo(record({
            versions: [['1.2.0', 1523478433, 0]],
        }))
        expect(info.versions[0].timestamp).toBe(1523478433_000)
        expect(new Date(info.versions[0].timestamp).toISOString()).toBe('2018-04-11T20:27:13.000Z')
    })

    it('names a maven package group:artifact, the way the java parser does', () => {
        const pkg = record({type: 'maven', namespace: 'com.google.guava', name: 'guava'})
        expect(registryNameOf(pkg)).toBe('com.google.guava:guava')
        expect(toLibraryInfo(pkg).name).toBe('com.google.guava:guava')
    })

    it('keeps an npm scope in the name, including when the server dropped the @', () => {
        expect(registryNameOf(record({namespace: '@types', name: 'node'}))).toBe('@types/node')
        expect(registryNameOf(record({namespace: 'types', name: 'node'}))).toBe('@types/node')
    })

    it('names composer vendor/package and golang by full module path', () => {
        expect(registryNameOf(record({type: 'composer', namespace: 'symfony', name: 'console'})))
            .toBe('symfony/console')
        expect(registryNameOf(record({type: 'golang', namespace: 'github.com/spf13', name: 'cobra'})))
            .toBe('github.com/spf13/cobra')
    })

    it('leaves a namespace-less package name alone', () => {
        expect(registryNameOf(record({type: 'pypi', namespace: null, name: 'requests'}))).toBe('requests')
    })

    it('survives a package with no versions, licenses or urls', () => {
        const info = toLibraryInfo(record({
            versions: [], licenses: [], latest: null, description: null, homepage_url: null, repo_url: null,
        }))
        expect(info.versions).toEqual([])
        expect(info.licenses).toEqual([])
        expect(info.reposUrl).toEqual([])
        expect(info.homepageUrl).toBe('')
    })
})

/**
 * The two readers that actually look at `versions` downstream, against the same package in both
 * shapes. The old-shape `LibraryInfo` below is written out by hand — it is what the adapter
 * produced when every version arrived as `{version, released_at, licenses, prerelease, yanked}` —
 * so this fails if the expansion loses a date, a license, a version, or the millisecond scale.
 */
describe('the readers of an expanded record, against the shape they used to get', () => {
    const compare = comparatorForPurlType('npm')

    const versions: CompactVersion[] = [
        ['0.9.9', at('2019-06-01T00:00:00Z'), 2],                  // yanked: never a version to be behind
        ['1.0.0', at('2020-01-01T00:00:00Z'), 0],                  // package license
        ['1.1.0', at('2021-01-01T00:00:00Z'), 0, ['Apache-2.0']],  // relicensed mid-life
        ['2.0.0-rc.1', at('2021-06-01T00:00:00Z'), 1],             // prerelease, still counted
        ['2.0.0', at('2022-01-01T00:00:00Z'), 0],
    ]

    const compact = record({
        licenses: ['MIT'],
        latest: {version: '2.0.0', released_at: '2022-01-01T00:00:00Z'},
        versions,
    })

    /** What `toLibraryInfo` returned before the wire shape changed, spelled out. */
    const oldShape: LibraryInfo = {
        name: 'left-pad',
        description: 'pads on the left',
        versions: [
            {version: '0.9.9', timestamp: Date.parse('2019-06-01T00:00:00Z'), latest: false, licenses: ['MIT'], yanked: true},
            {version: '1.0.0', timestamp: Date.parse('2020-01-01T00:00:00Z'), latest: false, licenses: ['MIT']},
            {version: '1.1.0', timestamp: Date.parse('2021-01-01T00:00:00Z'), latest: false, licenses: ['Apache-2.0']},
            {version: '2.0.0-rc.1', timestamp: Date.parse('2021-06-01T00:00:00Z'), latest: false, licenses: ['MIT']},
            {version: '2.0.0', timestamp: Date.parse('2022-01-01T00:00:00Z'), latest: true, licenses: ['MIT']},
        ],
        licenses: ['MIT'],
        homepageUrl: 'https://example.com',
        reposUrl: ['https://github.com/example/left-pad'],
        issuesUrl: [],
        keywords: [],
    }

    it('expands to exactly the old LibraryInfo', () => {
        expect(toLibraryInfo(compact)).toEqual(oldShape)
    })

    it('counts newer versions the same way, by date and by semver', () => {
        const expanded = newerVersionCounts(toLibraryInfo(compact).versions, '1.0.0', compare)

        // Three versions were released after 1.0.0 and three are numbered above it; the yanked
        // 0.9.9 is older anyway, and would be in neither count regardless.
        expect(expanded).toEqual({byDate: '3', bySemver: '3'})
        expect(expanded).toEqual(newerVersionCounts(oldShape.versions, '1.0.0', compare))
    })

    it('finds a yanked resolved version but never counts a yanked one as newer', () => {
        const withYanked = toLibraryInfo(record({
            versions: [
                ['1.0.0', at('2020-01-01T00:00:00Z'), 2],                    // the one in use, withdrawn
                ['1.0.1', at('2020-02-01T00:00:00Z'), 2],                    // withdrawn: nothing to upgrade to
                ['1.1.0', at('2021-01-01T00:00:00Z'), 0],
            ],
        }))
        expect(newerVersionCounts(withYanked.versions, '1.0.0', compare)).toEqual({byDate: '1', bySemver: '1'})
    })

    it('leaves the counts empty for a version with no date, as it always did', () => {
        const dateless = toLibraryInfo(record({
            licenses: ['MIT'],
            versions: [['1.0.0', null, 0], ['1.1.0', at('2021-01-01T00:00:00Z'), 0]],
        }))
        expect(newerVersionCounts(dateless.versions, '1.0.0', compare).byDate).toBe('')
        expect(newerVersionCounts(dateless.versions, '1.0.0', compare).bySemver).toBe('1')
    })

    it('reports the same license', () => {
        expect(licenseOf(toLibraryInfo(compact))).toBe('MIT')
        expect(licenseOf(toLibraryInfo(compact))).toBe(licenseOf(oldShape))
    })

    it('still falls back to a per-version license when the package has none', () => {
        // The maven registrar fills only the per-version lists, and `licenseOf` has always fallen
        // back to them. A package-level `[]` expands into every three-element tuple, so the
        // fallback has to find the version that shipped a fourth element.
        const perVersionOnly = toLibraryInfo(record({
            licenses: [],
            versions: [['1.0.0', at('2020-01-01T00:00:00Z'), 0], ['1.1.0', at('2021-01-01T00:00:00Z'), 0, ['Apache-2.0']]],
        }))
        expect(licenseOf(perVersionOnly)).toBe('Apache-2.0')
        expect(licenseOf(perVersionOnly)).toBe(licenseOf({
            name: 'left-pad',
            licenses: [],
            versions: [
                {version: '1.0.0', timestamp: Date.parse('2020-01-01T00:00:00Z'), latest: false, licenses: []},
                {version: '1.1.0', timestamp: Date.parse('2021-01-01T00:00:00Z'), latest: false, licenses: ['Apache-2.0']},
            ],
        }))
    })
})

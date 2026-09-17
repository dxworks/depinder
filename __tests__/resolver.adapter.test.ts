import {PackageRecord} from '../src/resolver/client'
import {registryNameOf, toLibraryInfo} from '../src/resolver/adapter'

/**
 * The resolver speaks purls and Postgres rows; everything downstream of `analyse` — the cache, the
 * CSV writers, `update` — speaks `LibraryInfo`. This is the one place that translates, so a field
 * dropped here is a column silently emptied in every report.
 */

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
        {version: '1.2.0', released_at: '2017-01-01T00:00:00Z', licenses: ['MIT'], prerelease: false, yanked: false},
        {version: '1.3.0', released_at: '2018-01-01T00:00:00Z', licenses: ['MIT'], prerelease: false, yanked: false},
    ],
    as_of: '2026-09-16T10:00:00Z',
    source: 'npm',
    fetched_at: '2026-09-16T10:00:00Z',
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

    it('leaves yanked versions out, as the crates.io registrar already does', () => {
        const info = toLibraryInfo(record({
            versions: [
                {version: '1.2.0', released_at: '2017-01-01T00:00:00Z', licenses: [], prerelease: false, yanked: false},
                {version: '1.2.1', released_at: '2017-02-01T00:00:00Z', licenses: [], prerelease: false, yanked: true},
            ],
        }))
        expect(info.versions.map(it => it.version)).toEqual(['1.2.0'])
    })

    it('carries a version with no release date as an unparseable timestamp, not as epoch zero', () => {
        // `Date.parse('')` is what the Go registrar produces for a version the proxy has no time
        // for, and `moment(NaN)` formats as "Invalid date" — a blank cell, not January 1970.
        const info = toLibraryInfo(record({
            versions: [{version: '1.2.0', released_at: null, licenses: [], prerelease: false, yanked: false}],
        }))
        expect(Number.isNaN(info.versions[0].timestamp)).toBe(true)
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

import {describe, expect, it} from 'vitest'
import {compareVersions, computeLatest, isPrerelease, type VersionLike} from '../../../src/resolver/registries/latest.js'

describe('isPrerelease', () => {
    const cases: [string, string, boolean][] = [
        // type, version, expected
        ['npm', '4.18.2', false],
        ['npm', '5.0.0-alpha.8', true],
        ['npm', '1.0.0-beta', true],
        ['npm', '1.0.0-rc.1', true],
        ['npm', '2.0.0+build.5', false],
        ['maven', '32.1.2-jre', false], // a flavour, not a pre-release
        ['maven', '32.1.2-android', false],
        ['maven', '1.0.0-SNAPSHOT', true],
        ['maven', '5.3.0-RC2', true],
        ['maven', '2.0.0.M3', true],
        ['maven', '1.0-1', false],
        ['nuget', '13.0.3', false],
        ['nuget', '6.0.0-preview.7', true],
        ['pypi', '4.2', false],
        ['pypi', '1.0a1', true],
        ['pypi', '2.0.0rc2', true],
        ['pypi', '1.0.0.dev3', true],
        ['pypi', '1.0.0.post1', false],
        ['pypi', '21.11b1', true],
        ['composer', 'dev-master', true],
        ['composer', '1.x-dev', true],
        ['composer', 'v6.4.0', false],
        ['gem', '7.1.0', false],
        ['gem', '7.1.0.beta1', true],
        ['golang', 'v1.9.1', false],
        ['golang', 'v0.0.0-20210101120000-abcdef123456', true],
        ['cargo', '1.0.0', false],
        ['cargo', '1.0.0-alpha.1', true],
    ]

    for (const [type, version, expected] of cases) {
        it(`${type} ${version} -> ${expected ? 'pre-release' : 'release'}`, () => {
            expect(isPrerelease(type, version)).toBe(expected)
        })
    }
})

function v(version: string, releasedAt: string | null, extra: Partial<VersionLike> = {}): VersionLike {
    return {
        version,
        releasedAt: releasedAt ? new Date(releasedAt) : null,
        prerelease: extra.prerelease ?? false,
        yanked: extra.yanked ?? false,
    }
}

describe('computeLatest', () => {
    it('trusts the registry designation when there is one', () => {
        const versions = [
            v('4.17.1', '2019-05-25'),
            v('4.18.2', '2022-10-08'),
            v('5.0.0-alpha.8', '2023-03-25', {prerelease: true}),
        ]
        expect(computeLatest('npm', versions, '4.18.2')).toEqual({
            latest: '4.18.2',
            latestPrerelease: '5.0.0-alpha.8',
        })
    })

    it('ignores a designation that is not in the list', () => {
        const versions = [v('1.0.0', '2020-01-01'), v('1.1.0', '2021-01-01')]
        expect(computeLatest('npm', versions, '9.9.9').latest).toBe('1.1.0')
    })

    it('ignores a designation that was yanked', () => {
        const versions = [v('1.0.0', '2020-01-01'), v('1.1.0', '2021-01-01', {yanked: true})]
        expect(computeLatest('cargo', versions, '1.1.0')).toEqual({latest: '1.0.0', latestPrerelease: undefined})
    })

    it('picks the newest release date when the registry designates nothing', () => {
        const versions = [
            v('1.0.0', '2021-01-01'),
            v('1.2.0', '2023-06-01'),
            v('1.1.0', '2023-09-01'), // a back-port released later
            v('2.0.0-RC1', '2023-12-01', {prerelease: true}),
        ]
        expect(computeLatest('maven', versions)).toEqual({latest: '1.1.0', latestPrerelease: '2.0.0-RC1'})
    })

    it('leaves latest_prerelease unset when the newest version is already latest', () => {
        const versions = [v('1.0.0', '2021-01-01'), v('1.1.0', '2023-01-01')]
        expect(computeLatest('nuget', versions)).toEqual({latest: '1.1.0', latestPrerelease: undefined})
    })

    it('reports a newer stable version the registry has not promoted yet', () => {
        const versions = [v('1.0.0', '2021-01-01'), v('1.1.0', '2023-01-01')]
        expect(computeLatest('npm', versions, '1.0.0')).toEqual({latest: '1.0.0', latestPrerelease: '1.1.0'})
    })

    it('falls back to the newest of all when every version looks like a pre-release', () => {
        const versions = [
            v('1.0.0-SNAPSHOT', '2021-01-01', {prerelease: true}),
            v('1.1.0-SNAPSHOT', '2022-01-01', {prerelease: true}),
        ]
        expect(computeLatest('maven', versions).latest).toBe('1.1.0-SNAPSHOT')
    })

    it('uses list order when nothing carries a date', () => {
        const versions = [v('1.0.0', null), v('1.1.0', null), v('1.2.0', null)]
        expect(computeLatest('maven', versions).latest).toBe('1.2.0')
    })

    it('prefers a dated version over an undated one', () => {
        const versions = [v('1.0.0', '2020-01-01'), v('1.1.0-nightly', null, {prerelease: true})]
        expect(computeLatest('maven', versions).latest).toBe('1.0.0')
    })

    it('says nothing about a package with no versions', () => {
        expect(computeLatest('npm', [])).toEqual({})
        expect(computeLatest('npm', [v('1.0.0', '2020-01-01', {yanked: true})])).toEqual({})
    })
})

describe('compareVersions', () => {
    const ascending: [string, string][] = [
        ['9.0.20', '10.0.12'],
        ['0.0.1110', '5.2.1'],
        ['1.0', '1.0.1'],
        ['4.0.102', '4.0.102.8'], // nuget's fourth part
        ['10.0.12', '11.0.0-rc.1.26425.128'],
        ['11.0.0-preview.7.26381.103', '11.0.0-rc.1.26425.128'],
        ['1.0.0-rc.2', '1.0.0-rc.10'], // numbers compare as numbers
        ['1.0.0-beta2', '1.0.0-RC1'],
        ['1.0.0-rc.1', '1.0.0'],
        ['v11.57.0', 'v13.34.0'],
        ['v0.9.1-alpha', 'v0.14.0-alpha'],
        ['1.18.14-jdk5', '1.18.14'],
        ['20020529', '2.0'], // a date stamp ranks below any real version
        ['20040616', '3.2.2'],
    ]
    for (const [lower, higher] of ascending) {
        it(`${lower} < ${higher}`, () => {
            expect(compareVersions(lower, higher)).toBeLessThan(0)
            expect(compareVersions(higher, lower)).toBeGreaterThan(0)
        })
    }

    it('treats equivalent spellings as equal', () => {
        expect(compareVersions('1.0', '1.0.0')).toBe(0)
        expect(compareVersions('v6.4.0', '6.4.0')).toBe(0)
        expect(compareVersions('2.0.0+build.5', '2.0.0')).toBe(0)
        expect(compareVersions('5.6.15.Final', '5.6.15')).toBe(0)
    })
})

describe('computeLatest by version order (nuget, composer)', () => {
    it('takes the highest stable nuget version, not the newest publish', () => {
        // Microsoft.Extensions.Options on 2026-09-08: 9.0.20 was published 13 minutes after 10.0.12.
        const versions = [
            v('9.0.19', '2026-08-11T18:00:00Z'),
            v('10.0.11', '2026-08-11T18:30:00Z'),
            v('11.0.0-rc.1.26425.128', '2026-09-08T18:12:09Z', {prerelease: true}),
            v('10.0.12', '2026-09-08T19:03:11Z'),
            v('9.0.20', '2026-09-08T19:16:58Z'),
        ]
        expect(computeLatest('nuget', versions)).toEqual({latest: '10.0.12', latestPrerelease: '11.0.0-rc.1.26425.128'})
    })

    it('does the same for composer', () => {
        const versions = [v('v13.34.0', '2026-09-29T15:00:00Z'), v('v11.57.0', '2026-09-29T15:33:27Z')]
        expect(computeLatest('composer', versions)).toEqual({latest: 'v13.34.0', latestPrerelease: undefined})
    })

    it('still skips unlisted versions', () => {
        const versions = [v('5.2.1', '2025-03-09'), v('6.0.0', '2025-04-01', {yanked: true})]
        expect(computeLatest('nuget', versions).latest).toBe('5.2.1')
    })

    it('never picks a composer branch, even when every tag is a pre-release', () => {
        // amirami/localizator: only `-alpha` tags, plus `0.x-dev` and `dev-master` branches that
        // were pushed after the last tag.
        const versions = [
            v('v0.13.0-alpha', '2024-03-27', {prerelease: true}),
            v('v0.14.0-alpha', '2025-03-06T12:49:02Z', {prerelease: true}),
            v('dev-master', '2022-02-15', {prerelease: true}),
            v('0.x-dev', '2025-03-06T12:51:22Z', {prerelease: true}),
        ]
        expect(computeLatest('composer', versions)).toEqual({latest: 'v0.14.0-alpha', latestPrerelease: undefined})
        expect(computeLatest('composer', [v('dev-main', '2025-01-01', {prerelease: true})])).toEqual({})
    })
})

describe('computeLatest for maven', () => {
    it('breaks a release-date tie by version order', () => {
        const at = '2005-09-20T05:49:00Z'
        const versions = [v('1.2', at), v('2.0', at), v('20020529', at), v('1.3-RC1', at, {prerelease: true})]
        expect(computeLatest('maven', versions).latest).toBe('2.0')
    })

    it('swaps a letter-led flavour for its plain sibling, whichever way it was chosen', () => {
        const versions = [v('1.18.14-jdk5', '2026-09-14T22:03:00Z'), v('1.18.14', '2026-09-14T22:10:00Z')]
        expect(computeLatest('maven', versions, '1.18.14-jdk5').latest).toBe('1.18.14')
        expect(computeLatest('maven', [...versions].reverse()).latest).toBe('1.18.14')
    })

    it('leaves flavours without a plain sibling, and dot or numeric qualifiers, alone', () => {
        const guava = [v('33.0.0-android', '2024-01-01'), v('33.0.0-jre', '2024-01-01')]
        expect(computeLatest('maven', guava, '33.0.0-jre').latest).toBe('33.0.0-jre')
        const inject = [v('2.0.1', '2020-01-01'), v('2.0.1.MR', '2021-01-01')]
        expect(computeLatest('maven', inject, '2.0.1.MR').latest).toBe('2.0.1.MR')
        const rebuild = [v('1.0', '2020-01-01'), v('1.0-1', '2021-01-01')]
        expect(computeLatest('maven', rebuild, '1.0-1').latest).toBe('1.0-1')
    })
})
